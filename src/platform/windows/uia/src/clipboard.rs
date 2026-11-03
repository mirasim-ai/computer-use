//! The user's clipboard, borrowed for one paste: saved, replaced, and put back.
//!
//! Only memory-backed formats can be saved (every text, HTML, RTF, file list and DIB image is one).
//! GDI-handle formats (CF_BITMAP, metafiles, palettes) are not memory: the system synthesizes
//! CF_BITMAP from CF_DIB, which is saved, and the rest are named in the answer when they were
//! present and could not come back. A restore is skipped when the clipboard changed after our
//! paste — that is the user (or the app) copying something, and theirs wins.
//!
//! Opened with no owner window: an owner is sent WM_DESTROYCLIPBOARD when another app empties
//! the clipboard, and this helper's thread pumps no messages — that app's copy would hang on us.

use std::thread::sleep;
use std::time::Duration;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HGLOBAL};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    RegisterClipboardFormatW, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};

use crate::{fail, Fail};

const CF_UNICODETEXT: u32 = 13;
/// Formats whose data is a GDI handle, not memory — never copied byte-wise.
const GDI_FORMATS: &[u32] = &[2 /* BITMAP */, 3 /* METAFILEPICT */, 9 /* PALETTE */, 14 /* ENHMETAFILE */, 0x80, 0x82, 0x83, 0x8E];
/// Formats Windows derives from CF_UNICODETEXT / CF_DIB on its own; saving them is redundant.
const SYNTHESIZED: &[u32] = &[1 /* TEXT */, 7 /* OEMTEXT */, 16 /* LOCALE */, 17 /* DIBV5 */];
/// More than this is not held in the helper to put back; the paste is refused instead.
const MAX_SAVED: usize = 64 * 1024 * 1024;

pub struct Saved {
    formats: Vec<(u32, Vec<u8>)>,
    /// Formats present that could not be saved (GDI handles with no memory twin).
    pub lost: Vec<u32>,
}

/// The clipboard, opened for the length of one borrow; closed on drop.
struct Open;
impl Open {
    fn new() -> Result<Self, Fail> {
        // Another app may hold it for a moment (a copy in progress); wait briefly, never long.
        for _ in 0..40 {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return Ok(Open);
            }
            sleep(Duration::from_millis(25));
        }
        Err(fail("clipboard_busy", "another program is holding the clipboard; nothing was pasted"))
    }
}
impl Drop for Open {
    fn drop(&mut self) {
        let _ = unsafe { CloseClipboard() };
    }
}

fn read_global(h: HANDLE) -> Option<Vec<u8>> {
    unsafe {
        let g = HGLOBAL(h.0);
        let size = GlobalSize(g);
        let p = GlobalLock(g) as *const u8;
        if p.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(p, size).to_vec();
        let _ = GlobalUnlock(g);
        Some(bytes)
    }
}

fn put(format: u32, bytes: &[u8]) -> Result<(), Fail> {
    unsafe {
        let g = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1))?;
        let p = GlobalLock(g) as *mut u8;
        if p.is_null() {
            return Err(fail("clipboard_error", "could not lock clipboard memory"));
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(g);
        // On success the system owns the memory.
        SetClipboardData(format, HANDLE(g.0))?;
        Ok(())
    }
}

pub fn save() -> Result<Saved, Fail> {
    let _open = Open::new()?;
    let mut formats = Vec::new();
    let mut lost = Vec::new();
    let mut total = 0usize;
    let mut f = 0u32;
    loop {
        f = unsafe { EnumClipboardFormats(f) };
        if f == 0 {
            break;
        }
        if SYNTHESIZED.contains(&f) {
            continue;
        }
        if GDI_FORMATS.contains(&f) {
            if f != 2 {
                lost.push(f); // CF_BITMAP comes back from the saved CF_DIB
            }
            continue;
        }
        let Ok(h) = (unsafe { GetClipboardData(f) }) else { continue };
        if let Some(bytes) = read_global(h) {
            total += bytes.len();
            if total > MAX_SAVED {
                return Err(fail("clipboard_large", "the clipboard holds more than 64 MB, which could not be put back after a paste; nothing was pasted — type the text instead"));
            }
            formats.push((f, bytes));
        }
    }
    Ok(Saved { formats, lost })
}

/// The CF_HTML envelope: a header of byte offsets (UTF-8) around the fragment.
fn cf_html(fragment: &str) -> Vec<u8> {
    const HEADER: &str = "Version:0.9\r\nStartHTML:0000000000\r\nEndHTML:0000000000\r\nStartFragment:0000000000\r\nEndFragment:0000000000\r\n";
    let pre = "<html><body>\r\n<!--StartFragment-->";
    let post = "<!--EndFragment-->\r\n</body></html>";
    let start_html = HEADER.len();
    let start_frag = start_html + pre.len();
    let end_frag = start_frag + fragment.len();
    let end_html = end_frag + post.len();
    let header = format!(
        "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_frag:010}\r\nEndFragment:{end_frag:010}\r\n"
    );
    let mut out = format!("{header}{pre}{fragment}{post}").into_bytes();
    out.push(0);
    out
}

fn utf16z(s: &str) -> Vec<u8> {
    s.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect()
}

fn registered(name: PCWSTR) -> u32 {
    unsafe { RegisterClipboardFormatW(name) }
}

/// Put the paste's content on the clipboard, marked to stay out of the clipboard history, the
/// cloud clipboard and clipboard monitors. Returns the sequence number our content has.
pub fn set(text: &str, html: Option<&str>) -> Result<u32, Fail> {
    {
        let _open = Open::new()?;
        unsafe { EmptyClipboard()? };
        put(CF_UNICODETEXT, &utf16z(text))?;
        if let Some(html) = html {
            put(registered(w!("HTML Format")), &cf_html(html))?;
        }
        let zero = 0u32.to_le_bytes();
        put(registered(w!("ExcludeClipboardContentFromMonitorProcessing")), &zero)?;
        put(registered(w!("CanIncludeInClipboardHistory")), &zero)?;
        put(registered(w!("CanUploadToCloudClipboard")), &zero)?;
    }
    // Read AFTER closing: the number moves when the clipboard closes, so one read while it was
    // still open made every restore think somebody had copied (measured — the user's clipboard
    // was left holding the paste).
    Ok(unsafe { GetClipboardSequenceNumber() })
}

/// The clipboard's text right now, if it has any.
fn current_text() -> Option<Vec<u8>> {
    let _open = Open::new().ok()?;
    let h = unsafe { GetClipboardData(CF_UNICODETEXT) }.ok()?;
    read_global(h)
}

/// Put the saved clipboard back — unless someone copied since `ours`. The sequence number alone
/// cannot say that (rendering a synthesized format can move it), so a moved number still
/// restores while the clipboard holds exactly the text this paste put there.
/// Answers whether it was restored.
pub fn restore(saved: &Saved, ours: u32, text: &str) -> Result<bool, Fail> {
    if unsafe { GetClipboardSequenceNumber() } != ours {
        let mine = utf16z(text);
        if !current_text().is_some_and(|t| t.len() >= mine.len() && t[..mine.len()] == mine[..]) {
            return Ok(false);
        }
    }
    let _open = Open::new()?;
    unsafe { EmptyClipboard()? };
    for (f, bytes) in &saved.formats {
        put(*f, bytes)?;
    }
    Ok(true)
}
