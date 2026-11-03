//! Real input through `SendInput`: the user's own cursor and keyboard queue. Every op here lands
//! wherever the system sends it — the foreground window — so the driver activates first.

use serde_json::json;
use std::thread::sleep;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Globalization::{GetLocaleInfoEx, LOCALE_SDECIMAL};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};

use crate::{fail, human, Reply};

fn send(inputs: &[INPUT]) -> Result<(), crate::Fail> {
    // Every event this helper injects goes through here, so this is where it is told apart from
    // the user's own (human.rs).
    human::injecting();
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    human::injected();
    if sent as usize != inputs.len() {
        // UIPI: input to a window of a higher integrity level (an elevated app) is dropped.
        return Err(fail("input_blocked", format!("Windows accepted {sent} of {} input events — the target may be running elevated", inputs.len())));
    }
    Ok(())
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn key(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

/// Screen pixels → the 0..65535 space `MOUSEEVENTF_ABSOLUTE | VIRTUALDESK` spans.
fn absolute(x: i32, y: i32) -> (i32, i32) {
    unsafe {
        let (vx, vy) = (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN));
        let (vw, vh) = (GetSystemMetrics(SM_CXVIRTUALSCREEN).max(2), GetSystemMetrics(SM_CYVIRTUALSCREEN).max(2));
        (((x - vx) as i64 * 65535 / (vw - 1) as i64) as i32, ((y - vy) as i64 * 65535 / (vh - 1) as i64) as i32)
    }
}

fn move_input(x: i32, y: i32) -> INPUT {
    let (ax, ay) = absolute(x, y);
    mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, ax, ay, 0)
}

pub fn move_to(x: i32, y: i32) -> Reply {
    send(&[move_input(x, y)])?;
    Ok(json!({}))
}

pub fn click(x: i32, y: i32, button: &str, count: u32) -> Reply {
    let (down, up) = match button {
        "left" => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
        "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        other => return Err(fail("bad_request", format!("unknown button '{other}'"))),
    };
    send(&[move_input(x, y)])?;
    sleep(Duration::from_millis(30));
    for _ in 0..count {
        send(&[mouse(down, 0, 0, 0), mouse(up, 0, 0, 0)])?;
        sleep(Duration::from_millis(40));
    }
    Ok(json!({ "x": x, "y": y }))
}

/// Press the left button at one point, move to another in `steps` motion events, release.
///
/// The path is cut into steps because apps start a drag only after the pointer leaves the
/// system's drag rectangle WHILE the button is down (`SM_CXDRAG`), and many poll the pointer per
/// frame — a single jump reads as a click followed by a move. The button is released on every
/// path out, including the user taking the mouse mid-way: a button left down would hold the
/// user's real mouse in a drag they never started.
pub fn drag(x: i32, y: i32, to_x: i32, to_y: i32, steps: u32) -> Reply {
    let steps = steps.clamp(2, 60);
    send(&[move_input(x, y)])?;
    sleep(Duration::from_millis(40));
    send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0, 0, 0)])?;
    let mark = human::mark();
    let path = (|| -> Result<(), crate::Fail> {
        sleep(Duration::from_millis(80));
        for i in 1..=steps {
            if human::touched_since(mark) {
                return Err(taken_over(format!("moved {i} of {steps} steps, then released the button")));
            }
            let t = i as f64 / steps as f64;
            let px = x + ((to_x - x) as f64 * t).round() as i32;
            let py = y + ((to_y - y) as f64 * t).round() as i32;
            send(&[move_input(px, py)])?;
            sleep(Duration::from_millis(15));
        }
        // Drop targets highlight on hover; give the one under the pointer a moment to accept.
        sleep(Duration::from_millis(120));
        Ok(())
    })();
    let released = send(&[mouse(MOUSEEVENTF_LEFTUP, 0, 0, 0)]);
    path?;
    released?;
    Ok(json!({ "x": to_x, "y": to_y, "steps": steps }))
}

/// Wheel at a point. `dy` > 0 scrolls DOWN (content moves up), in notches of 120.
pub fn scroll(x: i32, y: i32, dx: i32, dy: i32) -> Reply {
    send(&[move_input(x, y)])?;
    sleep(Duration::from_millis(30));
    for _ in 0..dy.unsigned_abs() {
        send(&[mouse(MOUSEEVENTF_WHEEL, 0, 0, if dy > 0 { -120 } else { 120 })])?;
        sleep(Duration::from_millis(15));
    }
    for _ in 0..dx.unsigned_abs() {
        send(&[mouse(MOUSEEVENTF_HWHEEL, 0, 0, if dx > 0 { 120 } else { -120 })])?;
        sleep(Duration::from_millis(15));
    }
    Ok(json!({}))
}

pub fn tap(vk: VIRTUAL_KEY) {
    let _ = send(&[key(vk, 0, KEYBD_EVENT_FLAGS(0)), key(vk, 0, KEYEVENTF_KEYUP)]);
}

/// `Ctrl+Shift+T`, `Enter`, `alt+f4`, `PageDown`. Modifiers are held around the final key.
pub fn chord(spec: &str, count: u32) -> Reply {
    let parts: Vec<&str> = spec.split('+').map(str::trim).filter(|p| !p.is_empty()).collect();
    let Some((last, mods)) = parts.split_last() else { return Err(fail("bad_request", "empty chord")) };
    let mods: Vec<VIRTUAL_KEY> = mods.iter().map(|m| modifier(m)).collect::<Result<_, _>>()?;
    let main = named_key(last)?;
    if matches!(&main, KeyPress::Decimal(_)) && !mods.is_empty() {
        return Err(fail("bad_request", "Decimal enters the locale's decimal separator as text and does not take modifiers; use a literal key chord for shortcuts"));
    }
    let mark = human::mark();
    for i in 0..count {
        if human::touched_since(mark) {
            return Err(taken_over(format!("pressed {spec} {i} of {count} times")));
        }
        let mut seq: Vec<INPUT> = mods.iter().map(|&m| key(m, 0, KEYBD_EVENT_FLAGS(0))).collect();
        seq.extend(main.press());
        seq.extend(mods.iter().rev().map(|&m| key(m, 0, KEYEVENTF_KEYUP)));
        send(&seq)?;
        sleep(Duration::from_millis(30));
    }
    Ok(json!({}))
}

/// Text as Unicode key events: layout- and IME-independent, one character at a time.
pub fn type_text(text: &str) -> Reply {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let units: Vec<u16> = normalized.encode_utf16().collect();
    let mark = human::mark();
    for (sent, &unit) in units.iter().enumerate() {
        if human::touched_since(mark) {
            let done = String::from_utf16_lossy(&units[..sent]).chars().count();
            return Err(taken_over(format!("typed {done} of {} characters", normalized.chars().count())));
        }
        if unit == '\n' as u16 {
            send(&KeyPress::Vk(VK_RETURN).press())?;
        } else {
            send(&[key(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE), key(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])?;
        }
        sleep(Duration::from_millis(4));
    }
    Ok(json!({ "chars": normalized.chars().count() }))
}

/// The user reached for the keyboard or mouse in the middle of a multi-event action: stop there
/// rather than keep typing into whatever they are doing.
fn taken_over(progress: String) -> crate::Fail {
    fail("human_input", format!("stopped: the user used the keyboard or mouse while this was being sent; {progress}"))
}

enum KeyPress {
    Vk(VIRTUAL_KEY),
    Char(u16),
    Decimal(Vec<u16>),
}

impl KeyPress {
    fn press(&self) -> Vec<INPUT> {
        match self {
            KeyPress::Vk(vk) => {
                let vk = *vk;
                // Navigation keys, keypad Divide and NumLock carry the extended-key flag.
                let ext = if matches!(vk, VK_LEFT | VK_RIGHT | VK_UP | VK_DOWN | VK_HOME | VK_END | VK_PRIOR | VK_NEXT | VK_INSERT | VK_DELETE | VK_DIVIDE | VK_NUMLOCK) {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    KEYBD_EVENT_FLAGS(0)
                };
                vec![key(vk, 0, ext), key(vk, 0, ext | KEYEVENTF_KEYUP)]
            }
            KeyPress::Char(c) => {
                let c = *c;
                // A letter or digit under modifiers must be its virtual key, or Ctrl+C is just "c".
                let vk = unsafe { VkKeyScanW(c) };
                if vk != -1 {
                    let v = VIRTUAL_KEY((vk & 0xff) as u16);
                    vec![key(v, 0, KEYBD_EVENT_FLAGS(0)), key(v, 0, KEYEVENTF_KEYUP)]
                } else {
                    vec![key(VIRTUAL_KEY(0), c, KEYEVENTF_UNICODE), key(VIRTUAL_KEY(0), c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
                }
            }
            KeyPress::Decimal(units) => units.iter().flat_map(|&unit| [
                key(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE),
                key(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ]).collect(),
        }
    }
}

fn modifier(m: &str) -> Result<VIRTUAL_KEY, crate::Fail> {
    Ok(match m.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "cmd" | "meta" | "mod" => VK_CONTROL,
        "shift" => VK_SHIFT,
        "alt" | "option" => VK_MENU,
        "win" | "super" => VK_LWIN,
        other => return Err(fail("bad_request", format!("unknown modifier '{other}'"))),
    })
}

fn named_key(k: &str) -> Result<KeyPress, crate::Fail> {
    let lower = k.to_ascii_lowercase();
    let vk = match lower.as_str() {
        "enter" | "return" => VK_RETURN,
        "tab" => VK_TAB,
        "escape" | "esc" => VK_ESCAPE,
        "space" => VK_SPACE,
        "backspace" => VK_BACK,
        "delete" | "del" => VK_DELETE,
        "insert" => VK_INSERT,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "arrowup" | "up" => VK_UP,
        "arrowdown" | "down" => VK_DOWN,
        "arrowleft" | "left" => VK_LEFT,
        "arrowright" | "right" => VK_RIGHT,
        "contextmenu" | "apps" => VK_APPS,
        "numlock" => VK_NUMLOCK,
        "multiply" | "numpadmultiply" => VK_MULTIPLY,
        "add" | "numpadadd" => VK_ADD,
        "subtract" | "numpadsubtract" => VK_SUBTRACT,
        "divide" | "numpaddivide" => VK_DIVIDE,
        "decimal" | "numpaddecimal" => {
            // VK_DECIMAL becomes Delete with NumLock off. Enter the user's decimal separator
            // as Unicode instead; do not toggle their lock state or assume a US keyboard layout.
            let mut separator = [0u16; 16];
            // LOCALE_NAME_USER_DEFAULT is the Win32 NULL macro, not an exported constant.
            let len = unsafe { GetLocaleInfoEx(PCWSTR::null(), LOCALE_SDECIMAL, Some(&mut separator)) };
            if len <= 1 { return Err(fail("bad_request", "Windows did not provide a decimal separator")); }
            return Ok(KeyPress::Decimal(separator[..len as usize - 1].to_vec()));
        }
        f if f.len() >= 2 && f.starts_with('f') && f[1..].parse::<u16>().is_ok_and(|n| (1..=24).contains(&n)) => {
            VIRTUAL_KEY(VK_F1.0 + f[1..].parse::<u16>().unwrap() - 1)
        }
        _ => {
            let units: Vec<u16> = k.encode_utf16().collect();
            if units.len() == 1 {
                return Ok(KeyPress::Char(units[0]));
            }
            return Err(fail("bad_request", format!("unknown key '{k}'")));
        }
    };
    Ok(KeyPress::Vk(vk))
}
