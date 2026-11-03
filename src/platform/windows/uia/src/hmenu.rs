//! A classic Win32 menu bar (HMENU), read and run without opening it.
//!
//! The menu lives in the window manager, not in the app, so its items, their text and their state
//! are readable from here. Before a submenu is read the window is sent WM_INITMENUPOPUP — what the
//! system sends before showing it — so an app that enables or fills items on demand (Paste only
//! with something to paste) answers with today's state rather than whatever was last drawn.
//! Running an item is the WM_COMMAND the menu itself would send: exact, and no menu opens.

use serde_json::{json, Value};

use windows::core::PWSTR;
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    GetMenu, GetMenuItemCount, GetMenuItemInfoW, PostMessageW, SendMessageTimeoutW, HMENU, MENUITEMINFOW, MFS_CHECKED, MFS_DISABLED,
    MFT_OWNERDRAW, MFT_SEPARATOR, MIIM_FTYPE, MIIM_ID, MIIM_STATE, MIIM_STRING, MIIM_SUBMENU, SMTO_ABORTIFHUNG, WM_COMMAND,
    WM_INITMENUPOPUP,
};

use crate::{fail, win, Reply};

const MAX_DEPTH: usize = 5;
const MAX_ITEMS: usize = 600;

fn item(menu: HMENU, index: u32) -> Option<(String, u32, u32, u32, HMENU)> {
    unsafe {
        let mut info = MENUITEMINFOW {
            cbSize: std::mem::size_of::<MENUITEMINFOW>() as u32,
            fMask: MIIM_STRING | MIIM_STATE | MIIM_ID | MIIM_SUBMENU | MIIM_FTYPE,
            ..Default::default()
        };
        GetMenuItemInfoW(menu, index, true, &mut info).ok()?;
        let mut text = String::new();
        if info.cch > 0 {
            let mut buf = vec![0u16; info.cch as usize + 1];
            info.dwTypeData = PWSTR(buf.as_mut_ptr());
            info.cch += 1;
            GetMenuItemInfoW(menu, index, true, &mut info).ok()?;
            text = String::from_utf16_lossy(&buf[..info.cch as usize]);
        }
        Some((text, info.fType.0, info.fState.0, info.wID, info.hSubMenu))
    }
}

fn walk(hwnd: windows::Win32::Foundation::HWND, menu: HMENU, path: &[String], depth: usize, out: &mut Vec<Value>) {
    let count = unsafe { GetMenuItemCount(menu) };
    for i in 0..count.max(0) as u32 {
        if out.len() >= MAX_ITEMS {
            return;
        }
        let Some((text, kind, state, id, sub)) = item(menu, i) else { continue };
        if kind & MFT_SEPARATOR.0 != 0 || (text.is_empty() && kind & MFT_OWNERDRAW.0 != 0) {
            continue;
        }
        let mut here = path.to_vec();
        here.push(text);
        let submenu = !sub.0.is_null();
        out.push(json!({
            "path": here, "id": id, "submenu": submenu,
            "enabled": state & MFS_DISABLED.0 == 0, "checked": state & MFS_CHECKED.0 != 0,
        }));
        if submenu && depth < MAX_DEPTH {
            // What the system sends before showing this submenu; low word = its position.
            unsafe {
                let mut r = 0usize;
                SendMessageTimeoutW(hwnd, WM_INITMENUPOPUP, WPARAM(sub.0 as usize), LPARAM(i as isize), SMTO_ABORTIFHUNG, 300, Some(&mut r));
            }
            walk(hwnd, sub, &here, depth + 1, out);
        }
    }
}

/// Every item of the window's menu bar, depth first: `{path, id, submenu, enabled, checked}`.
/// An empty list means the window has no classic menu bar (its menus, if any, are UI Automation's).
pub fn list(hwnd: isize) -> Reply {
    let h = win::hwnd(hwnd);
    let menu = unsafe { GetMenu(h) };
    let mut items = Vec::new();
    if !menu.0.is_null() {
        walk(h, menu, &[], 0, &mut items);
    }
    Ok(json!({ "items": items }))
}

/// Run a menu item the way the menu does: WM_COMMAND with its id, posted (the command may open a
/// modal dialog, which must not block this helper).
pub fn command(hwnd: isize, id: u32) -> Reply {
    unsafe { PostMessageW(win::hwnd(hwnd), WM_COMMAND, WPARAM(id as usize & 0xffff), LPARAM(0)) }
        .map_err(|e| fail("menu_error", format!("could not post the menu command: {}", e.message())))?;
    Ok(json!({}))
}
