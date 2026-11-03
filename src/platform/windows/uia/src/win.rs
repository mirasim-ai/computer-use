//! Top-level windows: the driver's targets, and how one is brought to the front.

use serde_json::{json, Value};
use std::ffi::c_void;

use windows::core::{w, PWSTR};
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::VK_MENU;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetAncestor, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindow, GA_ROOTOWNER, GWL_EXSTYLE,
    GWL_STYLE, GW_OWNER, SW_RESTORE, WS_CAPTION, WS_EX_TOOLWINDOW, WS_POPUP,
};

use crate::{fail, input, Reply};

pub fn hwnd(h: isize) -> HWND {
    HWND(h as *mut c_void)
}

fn id(h: HWND) -> i64 {
    h.0 as isize as i64
}

pub fn root(h: HWND) -> HWND {
    unsafe { GetAncestor(h, GA_ROOTOWNER) }
}

pub fn title(h: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn class(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn pid(h: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
    pid
}

/// The executable's stem (`explorer`, `CalculatorApp`), or "" when the process will not say.
pub fn process_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit('\\').next().unwrap_or("");
        file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file).to_string()
    }
}

/// The visible frame — DWM's extended bounds, without the invisible resize border that
/// `GetWindowRect` includes on Windows 10/11.
pub fn frame(h: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    unsafe {
        DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut c_void, std::mem::size_of::<RECT>() as u32).ok()?;
    }
    (r.right > r.left && r.bottom > r.top).then_some(r)
}

fn cloaked(h: HWND) -> bool {
    let mut v = 0u32;
    unsafe { DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut v as *mut u32 as *mut c_void, 4).is_ok() && v != 0 }
}

fn minimized(h: HWND) -> bool {
    unsafe { IsIconic(h).as_bool() }
}

unsafe extern "system" fn collect(h: HWND, lp: LPARAM) -> BOOL {
    let out = &mut *(lp.0 as *mut Vec<HWND>);
    out.push(h);
    true.into()
}

/// Application windows as a person would list them: visible, unowned, titled, not cloaked
/// (a cloaked window is on another virtual desktop or a suspended UWP frame).
pub fn list() -> Vec<Value> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    let fg = root(unsafe { GetForegroundWindow() });
    let own = std::process::id();
    all.into_iter()
        .filter(|&h| unsafe { IsWindowVisible(h).as_bool() })
        // An owned window is its owner's dialog — unless the owner is hidden: a control panel run
        // through rundll32 (the Sound panel, a property sheet) is a dialog whose owner nobody
        // sees, and is the only window that program shows.
        .filter(|&h| unsafe { GetWindow(h, GW_OWNER) }.map_or(true, |o| o.0.is_null() || !unsafe { IsWindowVisible(o) }.as_bool()))
        .filter(|&h| !cloaked(h))
        .filter_map(|h| {
            let t = title(h);
            let c = class(h);
            // The desktop itself (Progman/WorkerW) and the taskbar are the shell, not applications.
            if t.is_empty() || pid(h) == own || matches!(c.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd") {
                return None;
            }
            let p = app_pid(h, &c);
            let r = frame(h).unwrap_or_default();
            Some(json!({
                "hwnd": id(h), "pid": p, "process": process_name(p), "title": t, "class": c,
                "rect": { "x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top },
                "minimized": minimized(h), "foreground": h == fg,
            }))
        })
        .collect()
}

/// The process that OWNS a window's content. A UWP/WinUI app's top-level frame belongs to
/// ApplicationFrameHost; the app itself is the CoreWindow parented inside it (CalculatorApp,
/// SystemSettings), which is the name a person and an allow-list mean.
fn app_pid(h: HWND, class: &str) -> u32 {
    if class == "ApplicationFrameWindow" {
        if let Ok(core) = unsafe { FindWindowExW(h, None, w!("Windows.UI.Core.CoreWindow"), None) } {
            if !core.0.is_null() {
                return pid(core);
            }
        }
    }
    pid(h)
}

/// Visible windows whose owner chain leads to `h` — its dialogs and message boxes.
pub fn owned(h: HWND) -> Vec<HWND> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    all.into_iter()
        .filter(|&w| w != h && unsafe { IsWindowVisible(w).as_bool() } && !cloaked(w))
        .filter(|&w| owned_by(w, h))
        .collect()
}

/// Is `h` on `w`'s owner chain? Not "is `h` its root owner": a target may itself be owned by a
/// hidden window (see `list`), and its dialogs then share that hidden root with it.
fn owned_by(w: HWND, h: HWND) -> bool {
    let mut cur = w;
    for _ in 0..16 {
        match unsafe { GetWindow(cur, GW_OWNER) } {
            Ok(o) if !o.0.is_null() => {
                if o == h {
                    return true;
                }
                cur = o;
            }
            _ => return false,
        }
    }
    false
}

/// A window drawn without a caption: a menu, dropdown or flyout rather than a dialog.
pub fn captionless(h: HWND) -> bool {
    let style = unsafe { GetWindowLongW(h, GWL_STYLE) } as u32;
    style & WS_POPUP.0 != 0 && style & WS_CAPTION.0 != WS_CAPTION.0
}

/// The app's open menus that belong to NO window: a classic context menu (`#32768`, as an edit
/// control's own right-click menu) or a combo box's list is a top-level popup of the app's
/// process with no owner, so [`owned`] never reaches it — measured: the menu was on screen
/// and the walk listed none of its items. Tool-window popups of the same process only, and not
/// tooltips, which a hover leaves on screen and which say nothing a ref could act on.
pub fn popups(h: HWND) -> Vec<HWND> {
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize));
    }
    let app = pid(h);
    all.into_iter()
        .filter(|&w| w != h && pid(w) == app && unsafe { IsWindowVisible(w).as_bool() } && !cloaked(w))
        .filter(|&w| unsafe { GetWindow(w, GW_OWNER) }.map_or(true, |o| o.0.is_null()))
        .filter(|&w| captionless(w) && unsafe { GetWindowLongW(w, GWL_EXSTYLE) } as u32 & WS_EX_TOOLWINDOW.0 != 0)
        .filter(|&w| !matches!(class(w).as_str(), "tooltips_class32" | "SysShadow") && frame(w).is_some())
        .collect()
}

pub fn foreground() -> Value {
    let h = root(unsafe { GetForegroundWindow() });
    let p = app_pid(h, &class(h));
    json!({ "hwnd": id(h), "pid": p, "process": process_name(p), "title": title(h) })
}

fn is_front(h: HWND) -> bool {
    root(unsafe { GetForegroundWindow() }) == root(h)
}

/// Restore and bring a window to the front, and say whether it actually got there.
///
/// `SetForegroundWindow` is refused when Windows decides this process may not take the
/// foreground (the user is typing elsewhere). A synthetic Alt tap is the documented way such a
/// process becomes eligible; it is a real key event, so it is the second rung, not the first.
pub fn activate(h: isize) -> Reply {
    let h = hwnd(h);
    if !unsafe { IsWindow(h).as_bool() } {
        return Err(fail("window_gone", "the window no longer exists"));
    }
    let restored = minimized(h);
    if restored {
        unsafe {
            let _ = ShowWindow(h, SW_RESTORE);
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    if is_front(h) {
        return Ok(json!({ "foreground": true, "method": if restored { "restore" } else { "already" }, "restored": restored }));
    }
    let mut method = "set";
    unsafe {
        let _ = SetForegroundWindow(h);
    }
    if !wait_front(h) {
        method = "alt";
        input::tap(VK_MENU);
        unsafe {
            let _ = SetForegroundWindow(h);
        }
        wait_front(h);
    }
    Ok(json!({ "foreground": is_front(h), "method": method, "restored": restored }))
}

fn wait_front(h: HWND) -> bool {
    for _ in 0..10 {
        if is_front(h) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    false
}
