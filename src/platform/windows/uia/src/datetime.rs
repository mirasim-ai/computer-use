//! Win32 date/time pickers (`SysDateTimePick32`, which every WinForms DateTimePicker is) and month
//! calendars (`SysMonthCal32`).
//!
//! Through UI Automation a WinForms picker is a bare Pane: no value, no pattern (measured), so it
//! was simply not listed. Its window text is what it shows; the exact date comes from
//! DTM_GETSYSTEMTIME, which writes a SYSTEMTIME into memory the caller hands it — memory that has
//! to live in the picker's own process, so a buffer is allocated there for the one read.
//!
//! A date is SET the way a person sets it: focus the picker, walk its fields with the arrow keys
//! and type each one. DTM_SETSYSTEMTIME would change what is shown without telling the app
//! (WinForms keeps its Value from the change notification, which only input sends). Which
//! component a field holds is learned by nudging it (Up, read, Down): no locale or format parsing,
//! so long, short, time and custom formats all work.

use serde_json::{json, Value};
use std::thread::sleep;
use std::time::Duration;

use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, SYSTEMTIME, WPARAM};
use windows::Win32::System::Diagnostics::Debug::ReadProcessMemory;
use windows::Win32::System::Memory::{VirtualAllocEx, VirtualFreeEx, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE, PAGE_READWRITE};
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_OPERATION, PROCESS_VM_READ, PROCESS_VM_WRITE};
use windows::Win32::UI::Accessibility::IUIAutomationElement;
use windows::Win32::UI::Controls::{DTM_GETSYSTEMTIME, GDT_NONE, MCM_GETCURSEL, MCM_GETSELRANGE};
use windows::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, SMTO_ABORTIFHUNG};

use crate::typing::native_text;
use crate::{fail, input, win, Fail, Reply};

pub fn is_picker(h: HWND) -> bool {
    win::class(h).contains("SysDateTimePick32")
}

pub fn is_calendar(h: HWND) -> bool {
    win::class(h).contains("SysMonthCal32")
}

/// Send `msg` with a SYSTEMTIME buffer allocated in the control's process; (result, time).
fn remote_time(h: HWND, msg: u32) -> Option<(usize, SYSTEMTIME)> {
    remote_times::<1>(h, msg).map(|(r, [st])| (r, st))
}

/// The same for a message that fills `N` SYSTEMTIMEs (a calendar's selection range is two).
fn remote_times<const N: usize>(h: HWND, msg: u32) -> Option<(usize, [SYSTEMTIME; N])> {
    unsafe {
        let proc = OpenProcess(PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_LIMITED_INFORMATION, false, win::pid(h)).ok()?;
        let size = std::mem::size_of::<[SYSTEMTIME; N]>();
        let mem = VirtualAllocEx(proc, None, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        let mut out = None;
        if !mem.is_null() {
            let mut result = 0usize;
            if SendMessageTimeoutW(h, msg, WPARAM(0), LPARAM(mem as isize), SMTO_ABORTIFHUNG, 500, Some(&mut result)).0 != 0 {
                let mut st = [SYSTEMTIME::default(); N];
                if ReadProcessMemory(proc, mem, st.as_mut_ptr() as *mut _, size, None).is_ok() {
                    out = Some((result, st));
                }
            }
            let _ = VirtualFreeEx(proc, mem, 0, MEM_RELEASE);
        }
        let _ = CloseHandle(proc);
        out
    }
}

fn iso(st: &SYSTEMTIME) -> String {
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond)
}

/// What a picker or calendar holds: `{shown, iso?, none?}` — `none` is a picker whose checkbox is off.
pub fn describe(h: HWND) -> Option<Value> {
    if is_picker(h) {
        let shown = native_text(h).unwrap_or_default();
        return Some(match remote_time(h, DTM_GETSYSTEMTIME) {
            Some((r, _)) if r as u32 == GDT_NONE.0 => json!({ "shown": shown, "none": true }),
            Some((_, st)) => json!({ "shown": shown, "iso": iso(&st) }),
            None => json!({ "shown": shown }),
        });
    }
    if is_calendar(h) {
        // A multi-select calendar answers only its range (WinForms always creates one so).
        if let Some((_, st)) = remote_time(h, MCM_GETCURSEL).filter(|(r, _)| *r != 0) {
            return Some(json!({ "shown": "", "iso": iso(&st)[..10], "calendar": true }));
        }
        let (r, [from, to]) = remote_times::<2>(h, MCM_GETSELRANGE)?;
        if r == 0 {
            return Some(json!({ "shown": "", "calendar": true }));
        }
        let (a, b) = (iso(&from)[..10].to_string(), iso(&to)[..10].to_string());
        return Some(json!({ "shown": "", "iso": if a == b { a } else { format!("{a} – {b}") }, "calendar": true }));
    }
    None
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Part { Year, Month, Day, Hour, Minute, Second, AmPm }

fn now(h: HWND) -> Result<SYSTEMTIME, Fail> {
    match remote_time(h, DTM_GETSYSTEMTIME) {
        Some((r, st)) if r as u32 != GDT_NONE.0 => Ok(st),
        Some(_) => Err(fail("date_none", "the picker's checkbox is off, so it holds no date")),
        None => Err(fail("date_unreadable", "the picker's date cannot be read (its process refused the read); nothing was typed")),
    }
}

/// Which component a nudge (Up) moved. A 12-hour picker's AM/PM field moves the hour by 12.
fn moved(a: &SYSTEMTIME, b: &SYSTEMTIME) -> Option<Part> {
    if a.wYear != b.wYear { return Some(Part::Year); }
    if a.wMonth != b.wMonth { return Some(Part::Month); }
    if a.wDay != b.wDay { return Some(Part::Day); }
    if a.wHour != b.wHour { return Some(if (a.wHour as i32 - b.wHour as i32).abs() == 12 { Part::AmPm } else { Part::Hour }); }
    if a.wMinute != b.wMinute { return Some(Part::Minute); }
    if a.wSecond != b.wSecond { return Some(Part::Second); }
    None
}

fn keys(chord: &str, n: u32) -> Result<(), Fail> {
    input::chord(chord, n)?;
    sleep(Duration::from_millis(30));
    Ok(())
}

fn digits(s: &str) -> Result<(), Fail> {
    input::type_text(s)?;
    sleep(Duration::from_millis(30));
    Ok(())
}

/// Set the picker to `want` (each component optional; absent ones are left as they are) and
/// verify by reading it back. `el` is the picker's own UIA element, focused first.
pub fn set(el: &IUIAutomationElement, h: HWND, want: &Value) -> Reply {
    let get = |k: &str| want[k].as_u64().map(|v| v as u16);
    let _ = unsafe { el.SetFocus() };
    sleep(Duration::from_millis(80));
    if matches!(remote_time(h, DTM_GETSYSTEMTIME), Some((r, _)) if r as u32 == GDT_NONE.0) {
        keys("space", 1)?; // a picker with ShowCheckBox: switch the date on first
    }
    now(h)?;
    keys("left", 12)?; // to the first field (the arrows stop at the ends)
    let mut seen: Vec<Part> = Vec::new();
    for _ in 0..12 {
        let before = now(h)?;
        keys("up", 1)?;
        let after = now(h)?;
        keys("down", 1)?;
        if let Some(part) = moved(&before, &after) {
            if seen.contains(&part) {
                break; // the last field again: Right no longer moves
            }
            seen.push(part);
            let field = |v: Option<u16>, width: usize| v.map(|v| format!("{v:0width$}"));
            let text = match part {
                Part::Year => field(get("year"), 4),
                Part::Month => field(get("month"), 2),
                Part::Day => field(get("day"), 2),
                // A 12-hour field takes 1–12 (retyped below); the AM/PM field puts the half right.
                Part::Hour => field(get("hour"), 2),
                Part::Minute => field(get("minute"), 2),
                Part::Second => field(get("second"), 2),
                Part::AmPm => None,
            };
            if let Some(text) = text {
                digits(&text)?;
                // A 12-hour hour field refuses 13–23: say it the 12-hour way.
                if part == Part::Hour {
                    let v = get("hour").unwrap_or(0);
                    if now(h)?.wHour != v && v > 12 {
                        digits(&format!("{:02}", v - 12))?;
                    }
                }
            }
            if part == Part::AmPm {
                if let Some(v) = get("hour") {
                    if (now(h)?.wHour >= 12) != (v >= 12) {
                        keys("up", 1)?;
                    }
                }
            }
        }
        keys("right", 1)?;
    }
    let got = now(h)?;
    let ok = [("year", got.wYear), ("month", got.wMonth), ("day", got.wDay), ("hour", got.wHour), ("minute", got.wMinute), ("second", got.wSecond)]
        .iter()
        .all(|(k, v)| get(k).map_or(true, |w| w == *v));
    Ok(json!({ "verified": ok, "iso": iso(&got), "shown": native_text(h).unwrap_or_default() }))
}
