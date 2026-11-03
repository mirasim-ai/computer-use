//! Is someone else at the machine? The last input that did NOT come from this helper.
//!
//! `GetLastInputInfo` alone cannot answer it: Windows counts injected input as input, so every
//! click and keystroke this helper sends resets it, and a check after our own action would always
//! read "the user just moved". Two sources, combined:
//!
//!   - **Raw Input** from real devices. A message-only window registered with `RIDEV_INPUTSINK`
//!     receives every keyboard and mouse report system-wide without sitting on the input path (no
//!     hook, no added latency); `SendInput` reports arrive with no device handle, so a report WITH
//!     one is a person's hand. This is the only source that still sees the user while we are
//!     typing, which is what lets `type` stop mid-text. Only the time is kept — never a key.
//!   - **`GetLastInputInfo` outside our own injections**, sampled before every injection and on a
//!     25 ms timer. It covers what Raw Input does not see as a device: touch and pen, a remote
//!     desktop viewer, another automation tool. Input that lands while we are injecting is
//!     attributed to us and dropped — the price of a tick-resolution counter.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Mutex;

use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Input::{
    GetRawInputData, RegisterRawInputDevices, HRAWINPUT, RAWINPUT, RAWINPUTDEVICE, RAWINPUTHEADER, RIDEV_INPUTSINK, RID_INPUT, RIM_TYPEMOUSE,
};
use windows::Win32::UI::WindowsAndMessaging::*;

/// How long after our last `SendInput` returns its events may still be stamped by the system.
const INJECT_SLACK_MS: u32 = 150;
const SAMPLE_MS: u32 = 25;

/// Tick of the last real-device report, and how many there have been (the count is what a long
/// injection compares against: ticks are ~15 ms coarse, a counter is exact).
static PHYSICAL_TICK: AtomicU32 = AtomicU32::new(0);
static PHYSICAL_COUNT: AtomicU64 = AtomicU64::new(0);
static LISTENING: AtomicBool = AtomicBool::new(false);

struct Seen {
    /// The last `GetLastInputInfo` stamp observed, and the last one that was not ours.
    seen: u32,
    other: u32,
    /// Our injection window: events stamped in `[from, until]` are ours.
    from: u32,
    until: u32,
}

static SEEN: Mutex<Seen> = Mutex::new(Seen { seen: 0, other: 0, from: 1, until: 0 });

fn last_input() -> Option<u32> {
    let mut li = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe { GetLastInputInfo(&mut li).as_bool().then_some(li.dwTime) }
}

fn now() -> u32 {
    unsafe { GetTickCount() }
}

/// `t` is in `[from, until]`, tick wrap-around included.
fn within(t: u32, from: u32, until: u32) -> bool {
    t.wrapping_sub(from) <= until.wrapping_sub(from)
}

/// `a` is later than `b`, tick wrap-around included.
fn later(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) > 0
}

fn sample() {
    let Some(t) = last_input() else { return };
    let mut s = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if t != s.seen {
        s.seen = t;
        if !within(t, s.from, s.until) {
            s.other = t;
        }
    }
}

/// Before every `SendInput`: record whatever someone else did up to now, then open (or extend) the
/// window in which input is ours.
pub fn injecting() {
    sample();
    let t = now();
    let mut s = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    if later(t, s.until) {
        s.from = t;
    }
    s.until = t.wrapping_add(INJECT_SLACK_MS);
}

/// After every `SendInput` returns: its events are stamped shortly after, so the window stays open
/// a little past this.
pub fn injected() {
    let mut s = SEEN.lock().unwrap_or_else(|e| e.into_inner());
    s.until = now().wrapping_add(INJECT_SLACK_MS);
}

/// The real-device report count, for [`touched_since`].
pub fn mark() -> u64 {
    PHYSICAL_COUNT.load(Ordering::Relaxed)
}

/// A person used a real keyboard or mouse after `mark` was taken. Always false when Raw Input
/// could not be registered.
pub fn touched_since(mark: u64) -> bool {
    PHYSICAL_COUNT.load(Ordering::Relaxed) != mark
}

/// `{ seconds, listening }`: seconds since anyone but this helper used the machine. Counted from
/// the helper's start at most — input before it is assumed to be the user's.
pub fn idle() -> serde_json::Value {
    sample();
    let t = now();
    let other = SEEN.lock().unwrap_or_else(|e| e.into_inner()).other;
    let physical = PHYSICAL_TICK.load(Ordering::Relaxed);
    let last = if later(physical, other) { physical } else { other };
    serde_json::json!({ "seconds": t.wrapping_sub(last) as f64 / 1000.0, "listening": LISTENING.load(Ordering::Relaxed) })
}

/// Start the listener thread. The input before it counts as the user's, so a helper that has just
/// started reports the machine's real idle time rather than "idle forever".
pub fn start() {
    let t = last_input().unwrap_or_else(now);
    {
        let mut s = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        s.seen = t;
        s.other = t;
    }
    PHYSICAL_TICK.store(t, Ordering::Relaxed);
    std::thread::spawn(|| {
        if let Err(e) = listen() {
            eprintln!("computer-use-uia-helper: raw input unavailable, so input during our own typing is not seen: {}", e.message());
        }
    });
}

fn listen() -> windows::core::Result<()> {
    unsafe {
        let instance = GetModuleHandleW(None)?;
        let class = WNDCLASSW { lpfnWndProc: Some(wndproc), hInstance: instance.into(), lpszClassName: w!("ComputerUseHumanInput"), ..Default::default() };
        RegisterClassW(&class);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0), w!("ComputerUseHumanInput"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, HWND_MESSAGE, None, instance, None,
        )?;
        // Usage page 1 (generic desktop): 2 = mouse, 6 = keyboard.
        let devices = [2u16, 6].map(|usage| RAWINPUTDEVICE { usUsagePage: 1, usUsage: usage, dwFlags: RIDEV_INPUTSINK, hwndTarget: hwnd });
        RegisterRawInputDevices(&devices, std::mem::size_of::<RAWINPUTDEVICE>() as u32)?;
        LISTENING.store(true, Ordering::Relaxed);
        SetTimer(hwnd, 1, SAMPLE_MS, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            DispatchMessageW(&msg);
        }
    }
    LISTENING.store(false, Ordering::Relaxed);
    Ok(())
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_INPUT => {
            if from_a_device(HRAWINPUT(lp.0 as _)) {
                PHYSICAL_TICK.store(now(), Ordering::Relaxed);
                PHYSICAL_COUNT.fetch_add(1, Ordering::Relaxed);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
        WM_TIMER => {
            sample();
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wp, lp),
    }
}

/// A report from a real device that says something happened: injected input carries no device
/// handle, and a mouse report with no motion, buttons or wheel (some devices send them idle) is
/// not a person.
unsafe fn from_a_device(h: HRAWINPUT) -> bool {
    let mut raw = RAWINPUT::default();
    let mut size = std::mem::size_of::<RAWINPUT>() as u32;
    let got = GetRawInputData(h, RID_INPUT, Some(&mut raw as *mut RAWINPUT as *mut _), &mut size, std::mem::size_of::<RAWINPUTHEADER>() as u32);
    if got == u32::MAX || got < std::mem::size_of::<RAWINPUTHEADER>() as u32 || raw.header.hDevice.0.is_null() {
        return false;
    }
    if raw.header.dwType == RIM_TYPEMOUSE.0 {
        let m = raw.data.mouse;
        return m.lLastX != 0 || m.lLastY != 0 || m.Anonymous.Anonymous.usButtonFlags != 0;
    }
    true
}
