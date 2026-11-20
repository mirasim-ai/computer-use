//! An Electron app's own box for a JS dialog the Electron driver already answered (`jsdialog`).
//!
//! Electron shows a page's `alert()` / `confirm()` as a native message box — a `#32770` task
//! dialog owned by the page's window — from its main process, and takes it down only when the page
//! navigates or closes. An answer given over the DevTools protocol reaches the page but never that
//! box: it stays on screen, keeps the window that owns it disabled, and its buttons no longer
//! change anything. The Electron driver (`src/platform/electron`) answers over that protocol, so it
//! asks here to close the box, and this is the one thing the op does.
//!
//! Narrow on purpose: a visible `#32770` window of the app's own process whose text IS the
//! dialog's message — the topmost such box when there are several — closed by its own OK or
//! Cancel command. Never another window of the app, never input, never a box of another process.

use serde_json::{json, Value};
use std::collections::HashSet;
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
use windows::Win32::UI::Accessibility::{IUIAutomation, TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_TextControlTypeId};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, IsWindow, IsWindowVisible, PostMessageW, GW_OWNER, IDCANCEL, IDOK, WM_COMMAND, WM_USER,
};
use windows::core::VARIANT;

use crate::{win, Reply};

/// How often the window list is read while the box has not come up yet.
const POLL_MS: u64 = 50;
/// How long a closed box may take to go once its command was posted.
const GONE_MS: u64 = 1_500;
/// `TDM_CLICK_BUTTON`: a task dialog's own way to press one of its buttons.
const TDM_CLICK_BUTTON: u32 = WM_USER + 102;
/// Longer messages are compared on this many leading characters: a box may wrap or cut them.
const MATCH_CHARS: usize = 200;

unsafe extern "system" fn collect(h: HWND, lp: LPARAM) -> windows::Win32::Foundation::BOOL {
    let out = &mut *(lp.0 as *mut Vec<HWND>);
    out.push(h);
    true.into()
}

/// Visible top-level `#32770` windows of `pid`, topmost first (EnumWindows walks the z-order).
fn boxes(pid: u32) -> Vec<HWND> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    all.into_iter()
        .filter(|&h| win::pid(h) == pid && unsafe { IsWindowVisible(h).as_bool() } && win::class(h) == "#32770")
        .collect()
}

/// Whitespace collapsed, line endings and all: a box lays the message out its own way.
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn head(s: &str) -> String {
    s.chars().take(MATCH_CHARS).collect()
}

/// The text lines a box shows (its Text elements), or None when it cannot be read yet.
fn texts(a: &IUIAutomation, h: HWND) -> Option<Vec<String>> {
    unsafe {
        let el = a.ElementFromHandle(h).ok()?;
        let cond = a.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_TextControlTypeId.0)).ok()?;
        let found = el.FindAll(TreeScope_Descendants, &cond).ok()?;
        let n = found.Length().ok()?;
        let mut out = Vec::new();
        for i in 0..n {
            if let Ok(t) = found.GetElement(i) {
                if let Ok(name) = t.CurrentName() {
                    out.push(name.to_string());
                }
            }
        }
        Some(out)
    }
}

/// Is this box the one showing `message`? One of its lines is the message, or starts with its
/// first [`MATCH_CHARS`] characters. An empty message matches a box that shows no text at all.
fn shows(lines: &[String], message: &str) -> bool {
    let want = norm(message);
    if want.is_empty() {
        return lines.iter().all(|l| norm(l).is_empty());
    }
    let want = head(&want);
    lines.iter().any(|l| head(&norm(l)) == want)
}

fn gone(h: HWND, ms: u64) -> bool {
    let end = Instant::now() + Duration::from_millis(ms);
    loop {
        if !unsafe { IsWindow(h).as_bool() } || !unsafe { IsWindowVisible(h).as_bool() } {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        sleep(Duration::from_millis(25));
    }
}

/// Wait up to `wait_ms` for `pid`'s box showing `message` and close it with `button` ("ok" or
/// "cancel"). Answers `{found, closed, waitedMs, title?, ownerEnabled?}`; `found: false` when no
/// such box came up in time — the op never closes a box it could not match.
pub fn close(a: &IUIAutomation, pid: u32, message: &str, button: &str, wait_ms: u64) -> Reply {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(wait_ms);
    let id = if button == "cancel" { IDCANCEL.0 } else { IDOK.0 } as usize;
    // Boxes read and found to show something else: their text does not change, so read once.
    let mut other: HashSet<isize> = HashSet::new();
    loop {
        for h in boxes(pid) {
            if other.contains(&(h.0 as isize)) {
                continue;
            }
            // Unreadable or still empty: maybe still being laid out, so asked again next round.
            let Some(lines) = texts(a, h) else { continue };
            if !shows(&lines, message) {
                if lines.iter().any(|l| !norm(l).is_empty()) {
                    other.insert(h.0 as isize);
                }
                continue;
            }
            let owner = unsafe { GetWindow(h, GW_OWNER) }.ok().filter(|o| !o.0.is_null());
            let title = win::title(h);
            // Its own command first (what Enter or Esc sends), the task dialog's button message
            // second: either ends the box the way its button would.
            unsafe {
                let _ = PostMessageW(h, WM_COMMAND, WPARAM(id), LPARAM(0));
            }
            let mut closed = gone(h, GONE_MS / 2);
            if !closed {
                unsafe {
                    let _ = PostMessageW(h, TDM_CLICK_BUTTON, WPARAM(id), LPARAM(0));
                }
                closed = gone(h, GONE_MS);
            }
            let mut out: Value = json!({
                "found": true, "closed": closed, "title": title,
                "waitedMs": started.elapsed().as_millis() as u64,
            });
            if let Some(o) = owner {
                out["ownerEnabled"] = json!(unsafe { IsWindowEnabled(o).as_bool() });
            }
            return Ok(out);
        }
        if Instant::now() >= deadline {
            return Ok(json!({ "found": false, "closed": false, "waitedMs": started.elapsed().as_millis() as u64 }));
        }
        sleep(Duration::from_millis(POLL_MS));
    }
}

#[cfg(test)]
mod tests {
    use super::shows;

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn matches_the_message_however_the_box_lays_it_out() {
        assert!(shows(&lines(&["确定删除记录 #42 吗？"]), "确定删除记录 #42 吗？"));
        assert!(shows(&lines(&["", "Delete\r\nrecord  #42?"]), "Delete record #42?"));
        let long = "x".repeat(300);
        assert!(shows(&lines(&[&long[..250]]), &long));
    }

    #[test]
    fn never_matches_another_box() {
        assert!(!shows(&lines(&["Unsaved changes. Quit anyway?"]), "Delete record #42?"));
        assert!(!shows(&lines(&["Delete record #42? Really"]), "Delete record #42?"));
        assert!(!shows(&lines(&["Delete"]), "Delete record #42?"));
        assert!(!shows(&lines(&["Delete record #42?"]), ""));
    }

    #[test]
    fn an_empty_message_matches_only_an_empty_box() {
        assert!(shows(&lines(&[]), ""));
        assert!(shows(&lines(&["  "]), ""));
    }
}
