//! Partial edits: put a field's selection (or caret) on a stretch of its text, and paste at the
//! keyboard focus through the clipboard. Both are verified by reading back, never by dispatch.

use serde_json::json;
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Controls::{EM_GETSEL, EM_SCROLLCARET, EM_SETSEL};
use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, SMTO_ABORTIFHUNG};

use crate::typing::{belongs_to, expected, native_text, normalized, read_text};
use crate::{clipboard, fail, input, win, Fail, Reply};

fn edit_class(el: &IUIAutomationElement) -> Option<windows::Win32::Foundation::HWND> {
    let hwnd = unsafe { el.CurrentNativeWindowHandle() }.ok()?;
    if hwnd.0.is_null() {
        return None;
    }
    let class = win::class(hwnd).to_ascii_lowercase();
    (class == "edit" || class.starts_with("richedit") || class.starts_with("windowsforms10.edit.")
        || class.starts_with("windowsforms10.richedit")).then_some(hwnd)
}

/// Set a classic edit control's selection by its own UTF-16 offsets. Whether those offsets meant
/// the right text is for [`selection`] to say: RichEdit holds a line break as ONE character
/// while its value reads CRLF, so the same numbers land one character later per line above.
fn select_by_message(el: &IUIAutomationElement, start: usize, len: usize) -> bool {
    let Some(hwnd) = edit_class(el) else { return false };
    if start + len >= 0xffff {
        return false; // EM_GETSEL answers 16-bit offsets in its return value
    }
    unsafe {
        let mut r = 0usize;
        SendMessageTimeoutW(hwnd, EM_SETSEL, WPARAM(start), LPARAM((start + len) as isize), SMTO_ABORTIFHUNG, 500, Some(&mut r)).0 != 0
            && SendMessageTimeoutW(hwnd, EM_SCROLLCARET, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 500, Some(&mut r)).0 != 0
    }
}

/// Select through TextPattern by moving each endpoint from the document's start. Not `Move`: it
/// re-expands the range to a whole unit after moving (measured on WPF: a caret became a selected
/// space, and the next keystroke replaced it).
fn select_by_pattern(p: &IUIAutomationTextPattern, start: usize, len: usize) -> Result<bool, Fail> {
    unsafe {
        let doc = p.DocumentRange()?;
        let r = doc.Clone()?;
        r.MoveEndpointByRange(TextPatternRangeEndpoint_End, &doc, TextPatternRangeEndpoint_Start)?;
        // Moving the start past the (equal) end drags the end along: still degenerate.
        if start > 0 && r.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, start as i32)? != start as i32 {
            return Ok(false);
        }
        if len > 0 && r.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, len as i32)? != len as i32 {
            return Ok(false);
        }
        r.Select()?;
        Ok(true)
    }
}

/// What the control has selected right now, as (text before it, selected text) — from the
/// control itself, never from the offsets that were asked for.
fn selection(el: &IUIAutomationElement) -> Option<(String, String)> {
    unsafe {
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            let sel = p.GetSelection().ok()?;
            if sel.Length().ok()? != 1 {
                return None;
            }
            let got = sel.GetElement(0).ok()?;
            let before = p.DocumentRange().ok()?;
            before.MoveEndpointByRange(TextPatternRangeEndpoint_End, &got, TextPatternRangeEndpoint_Start).ok()?;
            return Some((before.GetText(-1).ok()?.to_string(), got.GetText(-1).ok()?.to_string()));
        }
        let hwnd = edit_class(el)?;
        let units: Vec<u16> = native_text(hwnd)?.encode_utf16().collect();
        let mut sel = 0usize;
        if SendMessageTimeoutW(hwnd, EM_GETSEL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 500, Some(&mut sel)).0 == 0 {
            return None;
        }
        let (s, e) = (sel & 0xffff, (sel >> 16) & 0xffff);
        if s > e || e > units.len() {
            return None;
        }
        Some((String::from_utf16(&units[..s]).ok()?, String::from_utf16(&units[s..e]).ok()?))
    }
}

fn selected_right(el: &IUIAutomationElement, want: &str, prefix: &str) -> bool {
    selection(el).is_some_and(|(before, got)| normalized(&before) == normalized(prefix) && normalized(&got) == normalized(want))
}

/// `start`/`len` are UTF-16 offsets into the field's value as `value` read it; `want` is the text
/// at that span and `prefix` everything before it. Providers disagree on what a character is —
/// RichEdit and some TextPattern providers count CRLF as one — so both counts are tried, and a
/// selection counts only when the control reads it back as `want` after `prefix`.
pub fn select_range(el: &IUIAutomationElement, start: usize, len: usize, want: &str, prefix: &str) -> Reply {
    // Focus first: a selection in a field without focus is not where keys go.
    let _ = unsafe { el.SetFocus() };
    let crlf = |s: &str| s.matches("\r\n").count();
    let mut counts = vec![(start, len)];
    if crlf(prefix) + crlf(want) > 0 {
        counts.push((start - crlf(prefix), len - crlf(want)));
    }
    for &(s, l) in &counts {
        if select_by_message(el, s, l) && selected_right(el, want, prefix) {
            return Ok(json!({ "via": "edit_message" }));
        }
    }
    if let Ok(p) = unsafe { el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) } {
        for &(s, l) in &counts {
            if select_by_pattern(&p, s, l)? && selected_right(el, want, prefix) {
                return Ok(json!({ "via": "text_pattern" }));
            }
        }
    } else if edit_class(el).is_none() {
        return Err(fail("no_selection", "this control exposes no text selection (no TextPattern and not a standard edit control)"));
    }
    Err(fail("no_selection", "the control did not take a selection that reads back as the requested text"))
}

/// Paste at the bound window's keyboard focus: save the clipboard, put the content on it, Ctrl+V,
/// wait for the focused editor to show the expected edit (when readable), put the clipboard back.
pub fn paste(a: &IUIAutomation, hwnd: isize, text: &str, html: Option<&str>, expect: Option<&IUIAutomationElement>, verify_ms: u64) -> Reply {
    let el = unsafe { a.GetFocusedElement()? };
    if !belongs_to(a, &el, hwnd)? {
        return Err(fail("wrong_focus", "keyboard focus is outside the bound window; nothing was put on the clipboard"));
    }
    if let Some(want) = expect {
        if !unsafe { a.CompareElements(want, &el)? }.as_bool() {
            let name = unsafe { el.CurrentName() }.map(|s| s.to_string()).unwrap_or_default();
            return Err(fail("wrong_focus", format!("keyboard focus is on \"{name}\", not on the ref you expected; nothing was put on the clipboard — click or selectText into the field first")));
        }
    }
    let text = normalized(text);
    let plan = expected(&el, &text);
    let saved = clipboard::save()?;
    let clip_text = text.replace('\n', "\r\n");
    let ours = clipboard::set(&clip_text, html)?;
    let sent = input::chord("ctrl+v", 1);
    let mut verified = None;
    if sent.is_ok() {
        match &plan {
            Some((before, after)) if normalized(after) != normalized(before) => {
                let deadline = Instant::now() + Duration::from_millis(verify_ms);
                verified = Some(loop {
                    if read_text(&el).is_some_and(|v| normalized(&v) == normalized(after)) { break true; }
                    if Instant::now() >= deadline { break false; }
                    sleep(Duration::from_millis(25));
                });
                // The app has the text; give a lazy reader a moment before the clipboard changes back.
                sleep(Duration::from_millis(150));
            }
            _ => sleep(Duration::from_millis(600)),
        }
    }
    let restored = clipboard::restore(&saved, ours, &clip_text);
    sent?;
    let restored = restored?;
    let clip = match (restored, saved.lost.is_empty()) {
        (false, _) => "the clipboard changed after the paste (someone copied), so their content was left on it".to_string(),
        (true, true) => "the clipboard was put back as it was".to_string(),
        (true, false) => format!("the clipboard was put back, except {} non-memory format(s) it held (a metafile or palette)", saved.lost.len()),
    };
    let note = match verified {
        Some(true) => format!("pasted once; the focused editor reads back the expected text. {clip}"),
        Some(false) => format!("pasted once; the focused editor did not show the expected text before verification timed out — do not paste again blindly. {clip}"),
        None => format!("pasted once; the focused editor cannot be read back, so the result was not verified. {clip}"),
    };
    Ok(json!({ "note": note, "restored": restored, "lost": saved.lost.len(), "verified": verified }))
}
