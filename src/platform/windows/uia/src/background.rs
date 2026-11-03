//! Limited UIA-only actions. This module has no keyboard/mouse/activation fallback.
use serde_json::{json, Value};
use std::thread::sleep;
use std::time::{Duration, Instant};
use windows::core::{Interface, BSTR};
use windows::Win32::Foundation::BOOL;
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, IsIconic, GA_ROOT};
use crate::{background_guard::BackgroundGuard, fail, typing, uia::{framework, inside_combo}, win, Fail, Reply};

struct AutoFocus { client: IUIAutomation2, previous: BOOL }
impl AutoFocus {
    fn off(a: &IUIAutomation) -> Result<Self, Fail> {
        unsafe {
            let client = a.cast::<IUIAutomation2>().map_err(|_| unsupported("this UIA client cannot disable automatic focus"))?;
            let previous = client.AutoSetFocus()?;
            client.SetAutoSetFocus(false)?;
            Ok(Self { client, previous })
        }
    }
}
impl Drop for AutoFocus { fn drop(&mut self) { let _ = unsafe { self.client.SetAutoSetFocus(self.previous) }; } }

fn unsupported(message: &str) -> Fail { fail("background_unsupported", format!("{message}; nothing was sent. Use desktop interaction only with permission for its foreground/input effects")) }
fn normalized(s: &str) -> String { s.replace("\r\n", "\n").replace('\r', "\n") }

/// Cached refs never authorize another window or an owned dialog's controls.
fn validate(a: &IUIAutomation, el: &IUIAutomationElement, hwnd: isize) -> Result<(), Fail> {
    unsafe {
        if !el.CurrentIsEnabled()?.as_bool() { return Err(unsupported("this control is disabled")); }
        let root = a.ElementFromHandle(win::hwnd(hwnd))?;
        let walker = a.RawViewWalker()?;
        let mut ancestor = el.clone();
        for _ in 0..128 {
            if let Ok(window) = ancestor.GetCurrentPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId) {
                if window.CurrentIsModal()?.as_bool() { return Err(unsupported("modal dialogs are outside background mode")); }
            }
            if let Ok(native) = ancestor.CurrentNativeWindowHandle() {
                if !native.0.is_null() && GetAncestor(native, GA_ROOT) != win::hwnd(hwnd) {
                    return Err(unsupported("the control is outside the bound window (possibly an owned popup)"));
                }
            }
            if a.CompareElements(&root, &ancestor)?.as_bool() { return Ok(()); }
            ancestor = match walker.GetParentElement(&ancestor) { Ok(parent) => parent, Err(_) => break };
        }
        Err(unsupported("the control no longer belongs to the bound window; observe again"))
    }
}

fn standard(el: &IUIAutomationElement) -> bool {
    unsafe { el.CurrentFrameworkId() }.is_ok_and(|s| matches!(s.to_string().to_ascii_lowercase().as_str(), "win32" | "winform" | "wpf"))
}

/// Frameworks measured to act without the foreground once AutoSetFocus is off:
/// Chromium pages and Electron apps ("Chrome"), XAML (Settings, Calculator, Explorer's command bar)
/// and DirectUI (Explorer's file list). Every pattern tried there applied with the user's
/// foreground, focus, caret and cursor unchanged, and in-window flyouts opened in place. With
/// AutoSetFocus on, the same calls stole the foreground every time.
fn measured(a: &IUIAutomation, el: &IUIAutomationElement) -> bool {
    matches!(framework(a, el).to_ascii_lowercase().as_str(), "chrome" | "xaml" | "directui")
}

/// Packaged XAML apps are suspended while minimized and Chromium stops rendering there; background
/// mode never restores a window, so it refuses instead.
fn unminimized(hwnd: isize) -> Result<(), Fail> {
    if unsafe { IsIconic(win::hwnd(hwnd)) }.as_bool() {
        return Err(unsupported("this window is minimized and its app may not respond until restored; background mode never restores it (it may stay covered)"));
    }
    Ok(())
}

/// A click on a measured control, chosen as the desktop press chooses: an item is selected (its
/// Invoke opens it, like a double-click) unless it sits in a combo box's list; otherwise the
/// control's own press, toggle, selection or expand/collapse. No Legacy default action.
fn press(a: &IUIAutomation, el: &IUIAutomationElement) -> Result<Action, Fail> {
    unsafe {
        let item = el.CurrentControlType().is_ok_and(|t| t == UIA_ListItemControlTypeId || t == UIA_TreeItemControlTypeId || t == UIA_DataItemControlTypeId)
            && !inside_combo(a, el);
        if let (true, Ok(p)) = (item, el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)) { return Ok(Action::Select(p)); }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) { return Ok(Action::Invoke(p)); }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) { return Ok(Action::Toggle(p)); }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) { return Ok(Action::Select(p)); }
        if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
            let state = p.CurrentExpandCollapseState()?;
            if state != ExpandCollapseState_LeafNode { return Ok(Action::Expand(p, state == ExpandCollapseState_Collapsed)); }
        }
        Err(unsupported("this control exposes no background UIA action (invoke, toggle, select or expand)"))
    }
}

/// One named pattern (uiaAction), exactly as asked: a tree node's click selects it, expanding is its own act.
fn named(el: &IUIAutomationElement, action: &str) -> Result<Action, Fail> {
    let missing = || unsupported(&format!("this control does not offer {action}"));
    unsafe {
        match action {
            "invoke" => el.GetCurrentPatternAs(UIA_InvokePatternId).map(Action::Invoke).map_err(|_| missing()),
            "toggle" => el.GetCurrentPatternAs(UIA_TogglePatternId).map(Action::Toggle).map_err(|_| missing()),
            "select" => el.GetCurrentPatternAs(UIA_SelectionItemPatternId).map(Action::Select).map_err(|_| missing()),
            "expand" | "collapse" => {
                let p: IUIAutomationExpandCollapsePattern = el.GetCurrentPatternAs(UIA_ExpandCollapsePatternId).map_err(|_| missing())?;
                if p.CurrentExpandCollapseState()? == ExpandCollapseState_LeafNode { return Err(unsupported("this item has nothing to expand or collapse (it is a leaf)")); }
                Ok(Action::Expand(p, action == "expand"))
            }
            _ => Err(unsupported("unknown uiaAction action")),
        }
    }
}

enum Action {
    Value(IUIAutomationValuePattern, String),
    Select(IUIAutomationSelectionItemPattern),
    Toggle(IUIAutomationTogglePattern),
    Invoke(IUIAutomationInvokePattern),
    /// true = expand, false = collapse.
    Expand(IUIAutomationExpandCollapsePattern, bool),
    Scroll(IUIAutomationScrollPattern, String, Option<String>, u32),
}

fn prepare(a: &IUIAutomation, el: &IUIAutomationElement, r: &Value) -> Result<Action, Fail> {
    unsafe {
        let control = el.CurrentControlType()?;
        match r["kind"].as_str().unwrap_or("") {
            "set_text" => {
                let editor = control == UIA_EditControlTypeId || control == UIA_DocumentControlTypeId;
                if !editor || !(standard(el) || measured(a, el)) {
                    return Err(unsupported("background setText supports editors in standard Win32/WinForms/WPF windows (including Notepad), Chromium pages, Electron apps and XAML apps"));
                }
                if el.CurrentIsPassword()?.as_bool() { return Err(unsupported("password fields cannot be verified in background mode")); }
                let p = el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId).map_err(|_| unsupported("this editor exposes no ValuePattern"))?;
                if p.CurrentIsReadOnly()?.as_bool() { return Err(unsupported("this editor is read-only")); }
                if typing::read_text(el).is_none() { return Err(unsupported("this editor cannot be read back")); }
                let text = r["text"].as_str().ok_or_else(|| unsupported("setText requires text"))?;
                Ok(Action::Value(p, text.into()))
            }
            "click" => {
                if r["button"].as_str().unwrap_or("left") != "left" || r["count"].as_u64().unwrap_or(1) != 1 {
                    return Err(unsupported("background click supports a single left action by ref"));
                }
                if measured(a, el) { return press(a, el); }
                // Win32 proxy list items may omit FrameworkId; validate their actual list parent.
                let standard_item = control == UIA_ListItemControlTypeId && (standard(el)
                    || a.ControlViewWalker().and_then(|w| w.GetParentElement(el)).is_ok_and(|p|
                        p.CurrentControlType().is_ok_and(|t| t == UIA_ListControlTypeId) && standard(&p)));
                if standard_item {
                    return el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
                        .map(Action::Select).map_err(|_| unsupported("this list item exposes no SelectionItemPattern"));
                }
                if control == UIA_CheckBoxControlTypeId {
                    let framework = el.CurrentFrameworkId()?.to_string();
                    let class = el.CurrentNativeWindowHandle().map(win::class).unwrap_or_default().to_ascii_lowercase();
                    if framework == "WPF" || class.starts_with("windowsforms10.button.") {
                        return el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                            .map(Action::Toggle).map_err(|_| unsupported("this checkbox exposes no TogglePattern"));
                    }
                    return Err(unsupported("classic Win32 and unverified checkboxes can take focus"));
                }
                Err(unsupported("background click covers controls in Chromium pages, Electron and XAML apps, plus standard list items and WinForms/WPF checkboxes; other Win32/WinForms/WPF buttons, menus and expansion are excluded"))
            }
            "uia_action" => {
                if !measured(a, el) { return Err(unsupported("background uiaAction supports controls in Chromium pages, Electron and XAML apps")); }
                named(el, r["action"].as_str().unwrap_or(""))
            }
            "scroll" => {
                if !(standard(el) || measured(a, el)) { return Err(unsupported("background scrolling supports scroll containers in standard Win32/WinForms/WPF windows, Chromium pages, Electron and XAML apps")); }
                let direction = r["direction"].as_str().unwrap_or("down");
                let to = r["to"].as_str();
                let count = r["count"].as_u64().unwrap_or(1);
                if !matches!(direction, "up" | "down" | "left" | "right") || to.is_some_and(|v| !matches!(v, "top" | "bottom")) || !(1..=20).contains(&count) {
                    return Err(unsupported("invalid background scroll direction, endpoint or count (1–20)"));
                }
                let p = el.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId).map_err(|_| unsupported("this ref exposes no ScrollPattern; choose the scroll container"))?;
                let vertical = to.is_some() || matches!(direction, "up" | "down");
                if !(if vertical { p.CurrentVerticallyScrollable()? } else { p.CurrentHorizontallyScrollable()? }).as_bool() {
                    return Err(unsupported("the requested axis is not scrollable"));
                }
                Ok(Action::Scroll(p, direction.into(), to.map(str::to_owned), count as u32))
            }
            _ => Err(unsupported("this action requires desktop interaction")),
        }
    }
}

fn verify(mut check: impl FnMut() -> Result<bool, Fail>, note: &str) -> Reply {
    let end = Instant::now() + Duration::from_millis(2500);
    loop {
        if check()? { return Ok(json!({"verified":true,"note":note})); }
        if Instant::now() >= end { return Ok(json!({"verified":false,"note":"UIA action was sent once but read-back did not match; do not automatically replay it"})); }
        sleep(Duration::from_millis(25));
    }
}

fn apply(action: Action, el: &IUIAutomationElement) -> Reply {
    unsafe {
        match action {
            Action::Value(p, text) => {
                p.SetValue(&BSTR::from(&text))?;
                verify(|| typing::read_text(el).map(|v| normalized(&v) == normalized(&text)).ok_or_else(|| fail("no_value", "editor became unreadable after writing")), "background UIA write reads back as requested")
            }
            Action::Select(p) => {
                if !p.CurrentIsSelected()?.as_bool() { p.Select()?; }
                verify(|| Ok(p.CurrentIsSelected()?.as_bool()), "item selected through background UIA")
            }
            Action::Toggle(p) => {
                let before = p.CurrentToggleState()?;
                p.Toggle()?;
                verify(|| Ok(p.CurrentToggleState()? != before), "toggle state changed through background UIA")
            }
            Action::Invoke(p) => {
                p.Invoke()?;
                Ok(json!({"note":"invoked through background UIA; the app runs it on its own, so observe the result"}))
            }
            Action::Expand(p, expand) => {
                if expand { p.Expand()?; } else { p.Collapse()?; }
                verify(|| Ok((p.CurrentExpandCollapseState()? == ExpandCollapseState_Collapsed) != expand), if expand { "expanded through background UIA" } else { "collapsed through background UIA" })
            }
            Action::Scroll(p, direction, to, count) => {
                let vertical = to.is_some() || matches!(direction.as_str(), "up" | "down");
                let before = if vertical { p.CurrentVerticalScrollPercent()? } else { p.CurrentHorizontalScrollPercent()? };
                let forward = !matches!(direction.as_str(), "up" | "left");
                if let Some(to) = &to {
                    p.SetScrollPercent(-1.0, if to == "top" { 0.0 } else { 100.0 })?;
                } else {
                    let amount = if forward { ScrollAmount_LargeIncrement } else { ScrollAmount_LargeDecrement };
                    for _ in 0..count { p.Scroll(if vertical { ScrollAmount_NoAmount } else { amount }, if vertical { amount } else { ScrollAmount_NoAmount })?; }
                }
                verify(|| {
                    let after = if vertical { p.CurrentVerticalScrollPercent()? } else { p.CurrentHorizontalScrollPercent()? };
                    Ok(if let Some(to) = &to { (after - if to == "top" { 0.0 } else { 100.0 }).abs() < 0.1 }
                    else if forward { after > before || after >= 99.9 } else { after < before || after <= 0.1 })
                }, "background UIA scroll position verified (or already at its boundary)")
            }
        }
    }
}

/// A window in front is one the user may be typing in. A background action still moves keyboard
/// focus INSIDE its window (measured: a clicked VS Code search box and an Electron app button became the
/// focused element), which would pull the caret out from under them, so it is refused there.
fn behind(hwnd: isize) -> Result<(), Fail> {
    if unsafe { GetAncestor(GetForegroundWindow(), GA_ROOT) } == win::hwnd(hwnd) {
        return Err(unsupported("this window is in front, where the user may be working, and a background action would move keyboard focus inside it"));
    }
    Ok(())
}

pub fn perform(a: &IUIAutomation, el: &IUIAutomationElement, hwnd: isize, r: &Value) -> Reply {
    let plan = (|| {
        behind(hwnd)?;
        // Before validation: a minimized Chromium window re-shapes its tree, so the ownership walk
        // would refuse it for the wrong reason.
        if measured(a, el) { unminimized(hwnd)?; }
        validate(a, el, hwnd)?;
        prepare(a, el, r)
    })().map_err(|e| if e.code == "uia_error" { unsupported("could not validate the control or its UIA pattern; observe again") } else { e })?;
    let _auto_focus = AutoFocus::off(a).map_err(|_| unsupported("could not disable UIA automatic focus"))?;
    let guard = BackgroundGuard::begin(a, hwnd)?;
    let result = apply(plan, el);
    // Let queued provider events settle before the final check. Sampling also runs during reads.
    sleep(Duration::from_millis(100));
    if guard.finish(a, hwnd) {
        return Err(fail("background_interrupted", "foreground, input focus, or owned windows changed during the UIA action; it may already have completed. Background actions on this window are stopped; observe without replaying input"));
    }
    result.map_err(|e| fail("background_uncertain", format!("UIA action may have completed: {}. Background actions on this window are stopped; observe without replaying input", e.message)))
}
