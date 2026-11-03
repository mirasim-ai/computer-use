//! Capture the focused editor BEFORE sending input, then verify that same editor without replay.
use serde_json::json;
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Controls::EM_GETSEL;
use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SendMessageTimeoutW, ES_MULTILINE, GWL_STYLE, SMTO_ABORTIFHUNG, WM_GETTEXT, WM_GETTEXTLENGTH};
use crate::{fail, input, win, Fail, Reply};

pub(crate) fn normalized(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// These standard messages marshal the text across processes. Bound allocation and reject a
/// racing/truncated read; this is a read-only cross-check, never a replacement write backend.
pub(crate) fn native_text(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut length = 0usize;
        if SendMessageTimeoutW(hwnd, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 250, Some(&mut length)).0 == 0 || length > 1_048_576 { return None; }
        let mut buffer = vec![0u16; length + 1];
        let mut copied = 0usize;
        if SendMessageTimeoutW(hwnd, WM_GETTEXT, WPARAM(buffer.len()), LPARAM(buffer.as_mut_ptr() as isize), SMTO_ABORTIFHUNG, 250, Some(&mut copied)).0 == 0 || copied != length { return None; }
        let mut after = 0usize;
        if SendMessageTimeoutW(hwnd, WM_GETTEXTLENGTH, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 250, Some(&mut after)).0 == 0 || after != copied { return None; }
        String::from_utf16(&buffer[..copied]).ok()
    }
}

fn editor_value(el: &IUIAutomationElement, mut text: String) -> String {
    // RichEdit may append a document-end CR, even in multiline WinForms controls. Compare
    // with the native text before dropping it, so Notepad's real final newline is preserved.
    if text.ends_with('\r') {
        if let Ok(hwnd) = unsafe { el.CurrentNativeWindowHandle() } {
            let class = win::class(hwnd).to_ascii_lowercase();
            if class.starts_with("richedit") || class.starts_with("windowsforms10.richedit") {
                if let Some(native) = native_text(hwnd) {
                    if normalized(&text) == format!("{}\n", normalized(&native)) { return native; }
                } else if unsafe { GetWindowLongW(hwnd, GWL_STYLE) } & ES_MULTILINE == 0 {
                    // A single-line RichEdit cannot contain a user's real trailing newline.
                    text.pop();
                }
            }
        }
    }
    text
}

pub fn read_text(el: &IUIAutomationElement) -> Option<String> {
    unsafe {
        if el.CurrentIsPassword().ok()?.as_bool() { return None; }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            return p.CurrentValue().ok().map(|s| editor_value(el, s.to_string()));
        }
        let p = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok()?;
        p.DocumentRange().ok()?.GetText(-1).ok().map(|s| editor_value(el, s.to_string()))
    }
}

pub(crate) fn expected(el: &IUIAutomationElement, text: &str) -> Option<(String, String)> {
    let before = read_text(el)?;
    let after = pattern_edit(el, &before, text).or_else(|| edit_control_edit(el, &before, text))
        .or_else(|| normalized(&before).is_empty().then(|| text.to_string()))?;
    Some((before, after))
}

fn pattern_edit(el: &IUIAutomationElement, before: &str, text: &str) -> Option<String> {
    unsafe {
        let p = el.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok()?;
        let selections = p.GetSelection().ok()?;
        if selections.Length().ok()? != 1 { return None; }
        let selection = selections.GetElement(0).ok()?;
        let document = p.DocumentRange().ok()?;
        let prefix = document.Clone().ok()?;
        prefix.MoveEndpointByRange(TextPatternRangeEndpoint_End, &selection, TextPatternRangeEndpoint_Start).ok()?;
        let suffix = document.Clone().ok()?;
        suffix.MoveEndpointByRange(TextPatternRangeEndpoint_Start, &selection, TextPatternRangeEndpoint_End).ok()?;
        let document = normalized(&document.GetText(-1).ok()?.to_string());
        let before = normalized(before);
        // TextPattern may include a document-end marker which ValuePattern does not. Identify
        // it by comparing both representations, never by deleting the user's last newline.
        if document != before && document != format!("{before}\n") { return None; }
        let prefix = normalized(&prefix.GetText(-1).ok()?.to_string());
        let suffix = normalized(&suffix.GetText(-1).ok()?.to_string());
        if !document.starts_with(&prefix) || !document.ends_with(&suffix) { return None; }
        let units: Vec<u16> = before.encode_utf16().collect();
        let start = prefix.encode_utf16().count().min(units.len());
        let end = document.encode_utf16().count().checked_sub(suffix.encode_utf16().count())?.min(units.len());
        if start > end { return None; }
        Some(format!("{}{text}{}", String::from_utf16(&units[..start]).ok()?, String::from_utf16(&units[end..]).ok()?))
    }
}

/// Classic Edit/WinForms providers expose ValuePattern but may omit TextPattern. EM_GETSEL
/// returns UTF-16 offsets in its result without cross-process pointers; reject its 16-bit overflow.
fn edit_control_edit(el: &IUIAutomationElement, before: &str, text: &str) -> Option<String> {
    unsafe {
        let hwnd = el.CurrentNativeWindowHandle().ok()?;
        let class = win::class(hwnd).to_ascii_lowercase();
        if class != "edit" && !class.starts_with("richedit") && !class.starts_with("windowsforms10.edit.") { return None; }
        let units: Vec<u16> = before.encode_utf16().collect();
        if units.len() >= 65535 { return None; }
        let mut selection = 0usize;
        if SendMessageTimeoutW(hwnd, EM_GETSEL, WPARAM(0), LPARAM(0), SMTO_ABORTIFHUNG, 500, Some(&mut selection)).0 == 0 { return None; }
        let (start, end) = (selection & 0xffff, (selection >> 16) & 0xffff);
        if start > end || end > units.len() { return None; }
        let prefix = String::from_utf16(&units[..start]).ok()?;
        let suffix = String::from_utf16(&units[end..]).ok()?;
        Some(format!("{prefix}{text}{suffix}"))
    }
}

pub(crate) fn belongs_to(a: &IUIAutomation, el: &IUIAutomationElement, hwnd: isize) -> Result<bool, Fail> {
    unsafe {
        let root = a.ElementFromHandle(win::hwnd(hwnd))?;
        let walker = a.RawViewWalker()?;
        let mut ancestor = el.clone();
        for _ in 0..128 {
            if a.CompareElements(&root, &ancestor)?.as_bool() { return Ok(true); }
            // The driver's surface also includes this window's owned dialogs.
            if let Ok(native) = ancestor.CurrentNativeWindowHandle() {
                if !native.0.is_null() && win::root(native) == win::hwnd(hwnd) { return Ok(true); }
            }
            match walker.GetParentElement(&ancestor) { Ok(parent) => ancestor = parent, Err(_) => break }
        }
    }
    Ok(false)
}

pub fn type_text(a: &IUIAutomation, hwnd: isize, text: &str, verify_ms: u64) -> Reply {
    let el = unsafe { a.GetFocusedElement()? };
    if !belongs_to(a, &el, hwnd)? {
        return Err(fail("wrong_focus", "keyboard focus is outside the bound window; nothing was typed"));
    }
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let plan = expected(&el, &text);
    input::type_text(&text)?;
    let Some((before, expected)) = plan else {
        return Ok(json!({"note":"typed once; original text or selection is unreadable — the value was not verified"}));
    };
    let expected = normalized(&expected);
    if expected == normalized(&before) {
        return Ok(json!({"note":"typed once; the expected value was already present before input — delivery could not be verified"}));
    }
    let deadline = Instant::now() + Duration::from_millis(verify_ms);
    loop {
        let Some(actual) = read_text(&el) else {
            return Ok(json!({"note":"typed once; the original editor could not be read afterwards — the value was not verified"}));
        };
        if normalized(&actual) == expected {
            return Ok(json!({"verified":true,"note":"typed once; the original editor reads back the expected text after replacing its selection"}));
        }
        if Instant::now() >= deadline {
            return Ok(json!({"verified":false,"note":"typed once; the original editor did not retain the expected text before verification timed out; do not automatically replay input"}));
        }
        sleep(Duration::from_millis(25).min(deadline.saturating_duration_since(Instant::now())));
    }
}
