//! computer-use-uia-helper — the native half of computer-use's Windows driver (`../uia-client.ts` spawns it).
//!
//! ONE resident process per driver, JSON Lines both ways: a request `{id, op, ...params}` is
//! answered by `{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`. It has to
//! stay resident because the element keys a `tree` call hands out are COM objects held by THIS
//! process; a per-call process would re-mint every key.
//!
//! Everything here is UI Automation, Win32 input and GDI capture. Rendering, refs and the change
//! verdict stay in the TypeScript driver. Logs go to stderr, never stdout.
//!
//! Desktop actions use the user's foreground/input. The separate `background` operation only
//! admits a bounded set of UIA patterns, disables AutoSetFocus and never falls back to real input.

mod apps;
mod background;
mod clipboard;
mod datetime;
mod editing;
#[path = "background-guard.rs"]
mod background_guard;
mod hmenu;
mod human;
mod input;
mod manifest;
mod shot;
mod typing;
mod uia;
mod win;

use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

/// A refusal the driver can word: `code` is stable, `message` is for people.
#[derive(Debug)]
pub struct Fail {
    pub code: &'static str,
    pub message: String,
}

pub fn fail(code: &'static str, message: impl Into<String>) -> Fail {
    Fail { code, message: message.into() }
}

impl From<windows::core::Error> for Fail {
    fn from(e: windows::core::Error) -> Self {
        fail("uia_error", format!("{} (0x{:08X})", e.message(), e.code().0))
    }
}

pub type Reply = Result<Value, Fail>;

const OPS: &[&str] = &[
    "capabilities", "windows", "foreground", "tree", "activate", "press", "setvalue", "value", "focus",
    "click", "move", "scroll", "key", "type", "shot", "shotscoped", "humanidle", "background", "pattern", "apps", "appinfo", "launch", "drag", "selectrange", "paste", "hmenu", "hmenucmd", "setdate",
];

fn main() {
    unsafe {
        // Physical pixels everywhere: UIA rects, cursor positions and captures share one space.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED).ok();
    }
    human::start();
    let mut engine = match uia::Engine::new() {
        Ok(e) => Some(e),
        Err(e) => {
            eprintln!("computer-use-uia-helper: UI Automation is unavailable: {}", e.message);
            None
        }
    };
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("computer-use-uia-helper: unparseable request: {e}");
                continue;
            }
        };
        let id = req["id"].clone();
        let reply = match catch_unwind(AssertUnwindSafe(|| dispatch(engine.as_mut(), &req))) {
            Ok(Ok(result)) => json!({ "id": id, "ok": true, "result": result }),
            Ok(Err(f)) => json!({ "id": id, "ok": false, "error": { "code": f.code, "message": f.message } }),
            Err(_) => json!({ "id": id, "ok": false, "error": { "code": "panic", "message": "the helper panicked on this request" } }),
        };
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

fn dispatch(engine: Option<&mut uia::Engine>, r: &Value) -> Reply {
    let op = r["op"].as_str().unwrap_or("");
    match op {
        "capabilities" => return Ok(json!({ "version": env!("CARGO_PKG_VERSION"), "ops": OPS })),
        "windows" => return Ok(json!({ "windows": win::list() })),
        "foreground" => return Ok(win::foreground()),
        "activate" => return win::activate(param_hwnd(r)?),
        "click" => return input::click(int(r, "x")?, int(r, "y")?, r["button"].as_str().unwrap_or("left"), count(r)),
        "move" => return input::move_to(int(r, "x")?, int(r, "y")?),
        "scroll" => return input::scroll(int(r, "x")?, int(r, "y")?, r["dx"].as_i64().unwrap_or(0) as i32, r["dy"].as_i64().unwrap_or(0) as i32),
        "key" => return input::chord(text(r, "chord")?, count(r)),
        "type" if r.get("hwnd").is_none() => return input::type_text(text(r, "text")?),
        "shot" => return shot::window(param_hwnd(r)?),
        "shotscoped" => return shot::scoped(param_hwnd(r)?, r, engine.as_deref()),
        "humanidle" => return Ok(human::idle()),
        "apps" => return apps::list(),
        "hmenu" => return hmenu::list(param_hwnd(r)?),
        "hmenucmd" => return hmenu::command(param_hwnd(r)?, r["item"].as_u64().unwrap_or(0) as u32),
        "appinfo" => return apps::info(text(r, "app")?),
        "launch" => return apps::launch(text(r, "app")?),
        "drag" => return input::drag(int(r, "x")?, int(r, "y")?, int(r, "toX")?, int(r, "toY")?, r["steps"].as_u64().unwrap_or(20) as u32),
        _ => {}
    }
    let Some(engine) = engine else {
        return Err(fail("unsupported", "UI Automation could not be initialised in this session"));
    };
    match op {
        "tree" => engine.tree(param_hwnd(r)?, r["max"].as_u64().unwrap_or(1500) as usize),
        "press" => engine.press(text(r, "key")?),
        "setvalue" => engine.set_value(text(r, "key")?, text(r, "text")?),
        "value" => engine.value(text(r, "key")?),
        "focus" => engine.focus(text(r, "key")?),
        "pattern" => engine.pattern(text(r, "key")?, text(r, "action")?),
        "setdate" => engine.set_date(text(r, "key")?, &r["want"]),
        "selectrange" => engine.select_range(text(r, "key")?, r["start"].as_u64().unwrap_or(0) as usize, r["length"].as_u64().unwrap_or(0) as usize,
            r["want"].as_str().unwrap_or(""), r["prefix"].as_str().unwrap_or("")),
        "paste" => engine.paste(param_hwnd(r)?, text(r, "text")?, r["html"].as_str(), r["key"].as_str(), r["verifyMs"].as_u64().unwrap_or(2500).min(5000)),
        "background" => engine.background(param_hwnd(r)?, text(r, "key")?, r),
        "type" => engine.type_text(param_hwnd(r)?, text(r, "text")?, r["verifyMs"].as_u64().unwrap_or(2500).min(5000)),
        _ => Err(fail("unknown_op", format!("unknown op '{op}'"))),
    }
}

fn param_hwnd(r: &Value) -> Result<isize, Fail> {
    r["hwnd"].as_i64().map(|h| h as isize).ok_or_else(|| fail("bad_request", "missing numeric 'hwnd'"))
}

fn int(r: &Value, k: &str) -> Result<i32, Fail> {
    r[k].as_f64().map(|v| v.round() as i32).ok_or_else(|| fail("bad_request", format!("missing number '{k}'")))
}

fn text<'a>(r: &'a Value, k: &str) -> Result<&'a str, Fail> {
    r[k].as_str().ok_or_else(|| fail("bad_request", format!("missing string '{k}'")))
}

fn count(r: &Value) -> u32 {
    r["count"].as_u64().unwrap_or(1).clamp(1, 20) as u32
}
