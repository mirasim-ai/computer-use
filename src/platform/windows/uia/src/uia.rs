//! The UI Automation half: one cached walk per `tree`, and the pattern actions on its elements.
//!
//! A walk is ONE `BuildUpdatedCache` over the window's control view — every property the driver
//! renders rides that single cross-process round trip (measured: 47–176 ms for 130–330 nodes,
//! against 2–3 ms per node read one property at a time). Each element is kept as a live COM
//! object under a key `k<walk>.<index>`; the last few walks stay addressable so a ref from the
//! previous observation still resolves, anything older answers `stale_key`.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::thread::sleep;
use std::time::Duration;

use windows::core::{Interface, BSTR, VARIANT};
use windows::Win32::Foundation::RECT;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::UI::Accessibility::*;

use crate::{fail, win, Fail, Reply};

const KEEP_WALKS: usize = 3;

/// Control type ids 50000.. in order — UIA's own names, mapped to roles by the driver.
const TYPE_NAMES: &[&str] = &[
    "Button", "Calendar", "CheckBox", "ComboBox", "Edit", "Hyperlink", "Image", "ListItem", "List", "Menu", "MenuBar",
    "MenuItem", "ProgressBar", "RadioButton", "ScrollBar", "Slider", "Spinner", "StatusBar", "Tab", "TabItem", "Text",
    "ToolBar", "ToolTip", "Tree", "TreeItem", "Custom", "Group", "Thumb", "DataGrid", "DataItem", "Document",
    "SplitButton", "Window", "Pane", "Header", "HeaderItem", "Table", "TitleBar", "Separator", "SemanticZoom", "AppBar",
];

/// `IsXxxPatternAvailable` → the action word the driver shows.
const ACTIONS: &[(UIA_PROPERTY_ID, &str)] = &[
    (UIA_IsInvokePatternAvailablePropertyId, "invoke"),
    (UIA_IsTogglePatternAvailablePropertyId, "toggle"),
    (UIA_IsSelectionItemPatternAvailablePropertyId, "select"),
    (UIA_IsExpandCollapsePatternAvailablePropertyId, "expand"),
    (UIA_IsValuePatternAvailablePropertyId, "value"),
    (UIA_IsRangeValuePatternAvailablePropertyId, "range"),
    (UIA_IsScrollPatternAvailablePropertyId, "scroll"),
    (UIA_IsTextPatternAvailablePropertyId, "text"),
];

const STATE_PROPS: &[UIA_PROPERTY_ID] = &[
    UIA_ValueValuePropertyId,
    UIA_ValueIsReadOnlyPropertyId,
    UIA_ToggleToggleStatePropertyId,
    UIA_ExpandCollapseExpandCollapseStatePropertyId,
    UIA_SelectionItemIsSelectedPropertyId,
    UIA_RangeValueValuePropertyId,
    UIA_LegacyIAccessibleDefaultActionPropertyId,
    UIA_HelpTextPropertyId,
];

pub struct Engine {
    a: IUIAutomation,
    walks: VecDeque<(u32, Vec<IUIAutomationElement>)>,
    walk_no: u32,
}

impl Engine {
    pub fn new() -> Result<Self, Fail> {
        let a: IUIAutomation = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER)? };
        if let Ok(a2) = a.cast::<IUIAutomation2>() {
            // A hung provider must cost seconds, not the request's whole budget.
            unsafe {
                let _ = a2.SetConnectionTimeout(2_000);
                let _ = a2.SetTransactionTimeout(8_000);
            }
        }
        Ok(Self { a, walks: VecDeque::new(), walk_no: 0 })
    }

    fn request(&self) -> Result<IUIAutomationCacheRequest, Fail> {
        unsafe {
            let r = self.a.CreateCacheRequest()?;
            for p in [
                UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_AutomationIdPropertyId, UIA_BoundingRectanglePropertyId,
                UIA_IsEnabledPropertyId, UIA_IsOffscreenPropertyId, UIA_HasKeyboardFocusPropertyId, UIA_FrameworkIdPropertyId,
                UIA_NativeWindowHandlePropertyId,
            ] {
                r.AddProperty(p)?;
            }
            for (p, _) in ACTIONS {
                r.AddProperty(*p)?;
            }
            for p in STATE_PROPS {
                r.AddProperty(*p)?;
            }
            r.SetTreeScope(TreeScope_Subtree)?;
            r.SetTreeFilter(&self.a.ControlViewCondition()?)?;
            Ok(r)
        }
    }

    pub fn tree(&mut self, hwnd: isize, max: usize) -> Reply {
        let h = win::hwnd(hwnd);
        let root = unsafe { self.a.ElementFromHandle(h)? };
        let req = self.request()?;
        // Chromium builds its web tree only once an accessibility client has asked: the first
        // walk of an Electron window is the 14-node frame, the full tree arrives within seconds.
        let chromium = win::class(h).starts_with("Chrome_WidgetWin");
        let mut nodes: Vec<(IUIAutomationElement, usize)> = Vec::new();
        let mut partial = None;
        for attempt in 0..8 {
            let cached = unsafe { root.BuildUpdatedCache(&req)? };
            let mut found = Vec::new();
            partial = collect(&cached, 0, max, &mut found);
            let grew = found.len() > nodes.len();
            nodes = found;
            if !chromium || nodes.len() >= 60 || (attempt > 0 && !grew && attempt >= 3) {
                break;
            }
            sleep(Duration::from_millis(350));
        }
        // A modal dialog (Office's "save changes?", a file picker, a message box) is its own
        // top-level window OWNED by this one — absent from this window's tree, yet it is what the
        // window is waiting on. Walk each visible owned window too and list it after the owner.
        // An open menu, dropdown or flyout is the same kind of window without a caption (WinForms'
        // ToolStrip dropdowns, Explorer's XAML context menu), or belongs to no window at all
        // (`win::popups`); it is counted as a popup, not reported as a dialog the window waits on.
        let mut dialogs = Vec::new();
        let mut popups = 0;
        for extra in win::owned(h).into_iter().chain(win::popups(h)) {
            if partial.is_some() {
                break;
            }
            let Ok(el) = (unsafe { self.a.ElementFromHandle(extra) }) else { continue };
            let Ok(cached) = (unsafe { el.BuildUpdatedCache(&req) }) else { continue };
            partial = collect(&cached, 1, max, &mut nodes);
            if win::captionless(extra) { popups += 1 } else { dialogs.push(win::title(extra)) }
        }
        self.walk_no += 1;
        let walk = self.walk_no;
        let elements: Vec<Value> = nodes.iter().enumerate().map(|(i, (e, depth))| describe(e, &format!("k{walk}.{i}"), *depth)).collect();
        self.walks.push_back((walk, nodes.into_iter().map(|(e, _)| e).collect()));
        while self.walks.len() > KEEP_WALKS {
            self.walks.pop_front();
        }
        let frame = win::frame(h).unwrap_or_default();
        Ok(json!({
            "title": win::title(h),
            "frame": { "x": frame.left, "y": frame.top, "w": frame.right - frame.left, "h": frame.bottom - frame.top },
            "elements": elements,
            "dialogs": dialogs,
            "popups": popups,
            "partial": partial,
        }))
    }

    fn get(&self, key: &str) -> Result<IUIAutomationElement, Fail> {
        let parsed = key.strip_prefix('k').and_then(|k| k.split_once('.')).and_then(|(w, i)| Some((w.parse::<u32>().ok()?, i.parse::<usize>().ok()?)));
        let Some((walk, index)) = parsed else { return Err(fail("bad_request", format!("not an element key: {key}"))) };
        self.walks
            .iter()
            .find(|(w, _)| *w == walk)
            .and_then(|(_, els)| els.get(index).cloned())
            .ok_or_else(|| fail("stale_key", format!("{key} is from an observation too old to act on — observe again")))
    }

    /// Live bounds for a detail capture, pinned to this window's UIA ancestry. Owned dialogs are
    /// separate windows: their controls must never crop unrelated pixels out of the parent.
    pub fn capture_rect(&self, key: &str, hwnd: isize) -> Result<RECT, Fail> {
        let el = self.get(key)?;
        unsafe {
            let root = self.a.ElementFromHandle(win::hwnd(hwnd))?;
            let walker = self.a.RawViewWalker()?;
            let mut ancestor = el.clone();
            for _ in 0..128 {
                if self.a.CompareElements(&root, &ancestor)?.as_bool() {
                    if el.CurrentIsOffscreen()?.as_bool() {
                        return Err(fail("offscreen", "the control is offscreen; choose a visible control"));
                    }
                    let rect = el.CurrentBoundingRectangle()?;
                    if rect.right <= rect.left || rect.bottom <= rect.top {
                        return Err(fail("offscreen", "the control has no visible bounds to capture"));
                    }
                    return Ok(rect);
                }
                match walker.GetParentElement(&ancestor) {
                    Ok(parent) => ancestor = parent,
                    Err(_) => break,
                }
            }
        }
        Err(fail("wrong_window", "the control does not belong to the captured window; observe the intended window again"))
    }

    /// The cheapest action that means "click": Invoke, Toggle, Select, Expand/Collapse, then the
    /// MSAA default action. `no_action` tells the driver to fall back to a real mouse click.
    pub fn press(&self, key: &str) -> Reply {
        unsafe { self.a.cast::<IUIAutomation2>()?.SetAutoSetFocus(true)?; }
        let el = self.get(key)?;
        // An ITEM's Invoke is its double-click: on an Explorer file it OPENS the file (measured:
        // a single click by ref opened the .txt in Notepad). A single click selects an item, so
        // Select comes first for items — except in a combo box's list, where the click that
        // picks an entry also closes the list, which is what Invoke does there.
        let item = unsafe { el.CurrentControlType() }
            .is_ok_and(|t| t == UIA_ListItemControlTypeId || t == UIA_TreeItemControlTypeId || t == UIA_DataItemControlTypeId)
            && !inside_combo(&self.a, &el);
        let press = unsafe {
            if let (true, Ok(p)) = (item, el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)) {
                Press::Select(p)
            } else if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId) {
                Press::Invoke(p)
            } else if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId) {
                Press::Toggle(p)
            } else if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId) {
                Press::Select(p)
            } else if let Ok(p) = el.GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId) {
                let collapsed = p.CurrentExpandCollapseState().map(|s| s == ExpandCollapseState_Collapsed).unwrap_or(true);
                Press::Expand(p, collapsed)
            } else {
                match el.GetCurrentPatternAs::<IUIAutomationLegacyIAccessiblePattern>(UIA_LegacyIAccessiblePatternId) {
                    Ok(p) if !p.CurrentDefaultAction().map(|s| s.is_empty()).unwrap_or(true) => Press::Default(p),
                    _ => return Err(fail("no_action", "this control exposes no UI Automation action")),
                }
            }
        };
        // WinForms runs a pressed control's click handler INSIDE Invoke / the default action, and
        // while that handler sits in a modal dialog the app's UI thread answers no UI Automation
        // request from anyone — measured: after a message-box button's Invoke, a fresh helper
        // process could not walk the window for 20 s, so the dialog was unreadable and could not
        // be answered. A real click on a visible control never waits on the handler, so it is the
        // route there; the driver clicks the control's centre (`prefer_mouse`).
        if matches!(press, Press::Invoke(_) | Press::Default(_))
            && framework(&self.a, &el) == "WinForm"
            && !unsafe { el.CurrentIsOffscreen() }.is_ok_and(|o| o.as_bool())
        {
            return Err(fail("prefer_mouse", "WinForms runs this control's handler synchronously; click it with the pointer"));
        }
        press.run_bounded()
    }

    /// One named pattern action, run exactly as asked: what a click chose for the control is not
    /// always what is wanted (a tree node's click selects it; expanding is its own act).
    pub fn pattern(&self, key: &str, action: &str) -> Reply {
        unsafe { self.a.cast::<IUIAutomation2>()?.SetAutoSetFocus(true)?; }
        let el = self.get(key)?;
        let missing = |what: &str| fail("no_action", format!("this control does not offer {what} (no such UI Automation pattern)"));
        let press = unsafe {
            match action {
                "invoke" => Press::Invoke(el.GetCurrentPatternAs(UIA_InvokePatternId).map_err(|_| missing("invoke"))?),
                "toggle" => Press::Toggle(el.GetCurrentPatternAs(UIA_TogglePatternId).map_err(|_| missing("toggle"))?),
                "select" => Press::Select(el.GetCurrentPatternAs(UIA_SelectionItemPatternId).map_err(|_| missing("select"))?),
                "expand" | "collapse" => {
                    let p: IUIAutomationExpandCollapsePattern = el.GetCurrentPatternAs(UIA_ExpandCollapsePatternId).map_err(|_| missing(action))?;
                    if p.CurrentExpandCollapseState().is_ok_and(|s| s == ExpandCollapseState_LeafNode) {
                        return Err(fail("no_action", "this item has nothing to expand or collapse (it is a leaf)"));
                    }
                    Press::Expand(p, action == "expand")
                }
                _ => return Err(fail("bad_request", format!("unknown action '{action}' — invoke, toggle, select, expand or collapse"))),
            }
        };
        press.run_bounded()
    }

    pub fn set_value(&self, key: &str, text: &str) -> Reply {
        unsafe { self.a.cast::<IUIAutomation2>()?.SetAutoSetFocus(true)?; }
        let el = self.get(key)?;
        let p = unsafe { el.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .map_err(|_| fail("no_value", "this control has no settable value (no ValuePattern)"))?;
        unsafe {
            if p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(false) {
                return Err(fail("read_only", "this control's value is read-only"));
            }
            p.SetValue(&BSTR::from(text))?;
            Ok(json!({ "value": p.CurrentValue().map(|v| v.to_string()).unwrap_or_default() }))
        }
    }

    pub fn value(&self, key: &str) -> Reply {
        let el = self.get(key)?;
        if let Some(value) = crate::typing::read_text(&el) {
            return Ok(json!({ "value": value }));
        }
        unsafe {
            // A date picker's label is not its value either: what it shows is (datetime.rs).
            if let Ok(h) = el.CurrentNativeWindowHandle() {
                if !h.0.is_null() {
                    if let Some(d) = crate::datetime::describe(h) {
                        let v = if d["calendar"] == true { &d["iso"] } else { &d["shown"] };
                        return Ok(json!({ "value": v.as_str().unwrap_or_default() }));
                    }
                }
            }
            let control = el.CurrentControlType()?;
            if el.CurrentIsPassword()?.as_bool() || control == UIA_EditControlTypeId || control == UIA_DocumentControlTypeId {
                return Err(fail("no_value", "this editor's text cannot be read; its label is not its value"));
            }
            Ok(json!({ "value": el.CurrentName()?.to_string() }))
        }
    }

    pub fn focus(&self, key: &str) -> Reply {
        let el = self.get(key)?;
        unsafe { el.SetFocus()? };
        Ok(json!({}))
    }

    pub fn type_text(&self, hwnd: isize, text: &str, verify_ms: u64) -> Reply {
        crate::typing::type_text(&self.a, hwnd, text, verify_ms)
    }

    pub fn select_range(&self, key: &str, start: usize, len: usize, want: &str, prefix: &str) -> Reply {
        unsafe { self.a.cast::<IUIAutomation2>()?.SetAutoSetFocus(true)?; }
        crate::editing::select_range(&self.get(key)?, start, len, want, prefix)
    }

    pub fn paste(&self, hwnd: isize, text: &str, html: Option<&str>, key: Option<&str>, verify_ms: u64) -> Reply {
        let expect = key.map(|k| self.get(k)).transpose()?;
        crate::editing::paste(&self.a, hwnd, text, html, expect.as_ref(), verify_ms)
    }

    pub fn set_date(&self, key: &str, want: &Value) -> Reply {
        unsafe { self.a.cast::<IUIAutomation2>()?.SetAutoSetFocus(true)?; }
        let el = self.get(key)?;
        let h = unsafe { el.CurrentNativeWindowHandle()? };
        if h.0.is_null() || !crate::datetime::is_picker(h) {
            return Err(fail("not_a_picker", "this control is not a Win32 date/time picker"));
        }
        crate::datetime::set(&el, h, want)
    }

    pub fn background(&self, hwnd: isize, key: &str, request: &Value) -> Reply {
        crate::background::perform(&self.a, &self.get(key)?, hwnd, request)
    }
}

/// The pattern call a `press` resolved to, carried to the worker thread that makes it.
enum Press {
    Invoke(IUIAutomationInvokePattern),
    Toggle(IUIAutomationTogglePattern),
    Select(IUIAutomationSelectionItemPattern),
    Expand(IUIAutomationExpandCollapsePattern, bool),
    Default(IUIAutomationLegacyIAccessiblePattern),
}

// The helper lives in the multithreaded apartment (main.rs), where UIA's interfaces may be called
// from any of its threads; the pattern only moves to a thread that joins that apartment.
unsafe impl Send for Press {}

/// How long a press may run before it is answered as dispatched-but-pending.
const PRESS_WAIT: Duration = Duration::from_millis(1500);

impl Press {
    fn via(&self) -> &'static str {
        match self {
            Press::Invoke(_) => "invoke",
            Press::Toggle(_) => "toggle",
            Press::Select(_) => "select",
            Press::Expand(_, true) => "expand",
            Press::Expand(_, false) => "collapse",
            Press::Default(_) => "default_action",
        }
    }

    fn fire(&self) -> Reply {
        unsafe {
            match self {
                Press::Invoke(p) => p.Invoke()?,
                Press::Toggle(p) => {
                    p.Toggle()?;
                    return Ok(json!({ "via": "toggle", "state": p.CurrentToggleState().map(|s| s.0).unwrap_or(-1) }));
                }
                Press::Select(p) => p.Select()?,
                Press::Expand(p, true) => p.Expand()?,
                Press::Expand(p, false) => p.Collapse()?,
                Press::Default(p) => p.DoDefaultAction()?,
            }
        }
        Ok(json!({ "via": self.via() }))
    }

    /// Pattern calls are SYNCHRONOUS in the app: a button whose handler opens a modal dialog
    /// (a message box, a file picker) answers Invoke only once that dialog is closed. Measured on
    /// a WinForms button: the call hung for UIA's 8 s transaction timeout and came back as
    /// UIA_E_TIMEOUT (0x80131505) — a press that HAD worked, reported as an opaque failure after
    /// ten seconds. So the call runs on its own thread and is awaited briefly; still running
    /// after that means the app is inside what the press started, and the answer says so.
    /// The thread is left to finish whenever the app returns; it holds nothing else.
    fn run_bounded(self) -> Reply {
        let via = self.via();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::Builder::new()
            .name("uia-press".into())
            .spawn(move || {
                unsafe { let _ = windows::Win32::System::Com::CoInitializeEx(None, windows::Win32::System::Com::COINIT_MULTITHREADED); }
                let _ = tx.send(self.fire());
            })
            .map_err(|_| fail("uia_error", "could not start the press thread; nothing was sent"))?;
        match rx.recv_timeout(PRESS_WAIT) {
            Ok(result) => result,
            Err(_) => Ok(json!({ "via": via, "pending": true })),
        }
    }
}

/// Depth-first over the cached children, capped at `max` nodes. Returns why it stopped early.
fn collect(e: &IUIAutomationElement, depth: usize, max: usize, out: &mut Vec<(IUIAutomationElement, usize)>) -> Option<String> {
    if out.len() >= max {
        return Some(format!("stopped at {max} elements"));
    }
    out.push((e.clone(), depth));
    let Ok(kids) = (unsafe { e.GetCachedChildren() }) else { return None };
    let n = unsafe { kids.Length() }.unwrap_or(0);
    for i in 0..n {
        if let Ok(k) = unsafe { kids.GetElement(i) } {
            if let Some(stop) = collect(&k, depth + 1, max, out) {
                return Some(stop);
            }
        }
    }
    None
}

/// Is this element in a combo box's dropdown list (its list, or the list's popup window)?
pub(crate) fn inside_combo(a: &IUIAutomation, el: &IUIAutomationElement) -> bool {
    let Ok(walker) = (unsafe { a.ControlViewWalker() }) else { return false };
    let mut node = el.clone();
    for _ in 0..4 {
        node = match unsafe { walker.GetParentElement(&node) } { Ok(p) => p, Err(_) => return false };
        if unsafe { node.CurrentControlType() }.is_ok_and(|t| t == UIA_ComboBoxControlTypeId) {
            return true;
        }
    }
    false
}

/// The UI framework an element belongs to. Windowless parts (a WinForms ToolStrip menu item)
/// report none of their own, so the nearest ancestor that does decides.
pub(crate) fn framework(a: &IUIAutomation, el: &IUIAutomationElement) -> String {
    let Ok(walker) = (unsafe { a.RawViewWalker() }) else { return String::new() };
    let mut node = el.clone();
    for _ in 0..32 {
        if let Ok(f) = unsafe { node.CurrentFrameworkId() } {
            if !f.is_empty() {
                return f.to_string();
            }
        }
        node = match unsafe { walker.GetParentElement(&node) } { Ok(p) => p, Err(_) => break };
    }
    String::new()
}

fn prop(e: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<VARIANT> {
    let v = unsafe { e.GetCachedPropertyValue(id) }.ok()?;
    (!v.is_empty()).then_some(v)
}

fn prop_bool(e: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> bool {
    prop(e, id).and_then(|v| bool::try_from(&v).ok()).unwrap_or(false)
}

fn prop_str(e: &IUIAutomationElement, id: UIA_PROPERTY_ID) -> Option<String> {
    let s = prop(e, id).and_then(|v| BSTR::try_from(&v).ok())?.to_string();
    (!s.is_empty()).then_some(s)
}

fn describe(e: &IUIAutomationElement, key: &str, depth: usize) -> Value {
    let ct = unsafe { e.CachedControlType() }.map(|t| t.0).unwrap_or(0);
    let r = unsafe { e.CachedBoundingRectangle() }.unwrap_or_default();
    let actions: Vec<&str> = ACTIONS.iter().filter(|(p, _)| prop_bool(e, *p)).map(|(_, a)| *a).collect();
    let mut v = json!({
        "key": key,
        "type": TYPE_NAMES.get((ct - 50000).max(0) as usize).copied().unwrap_or("Unknown"),
        "name": unsafe { e.CachedName() }.map(|s| s.to_string()).unwrap_or_default(),
        "rect": { "x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top },
        "depth": depth,
        "actions": actions,
    });
    let o = v.as_object_mut().unwrap();
    if let Ok(id) = unsafe { e.CachedAutomationId() } {
        if !id.is_empty() {
            o.insert("id".into(), json!(id.to_string()));
        }
    }
    if !unsafe { e.CachedIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true) {
        o.insert("disabled".into(), json!(true));
    }
    if unsafe { e.CachedIsOffscreen() }.map(|b| b.as_bool()).unwrap_or(false) {
        o.insert("offscreen".into(), json!(true));
    }
    if unsafe { e.CachedHasKeyboardFocus() }.map(|b| b.as_bool()).unwrap_or(false) {
        o.insert("focused".into(), json!(true));
    }
    if actions.contains(&"value") {
        o.insert("value".into(), json!(prop_str(e, UIA_ValueValuePropertyId).unwrap_or_default()));
        if prop_bool(e, UIA_ValueIsReadOnlyPropertyId) {
            o.insert("readonly".into(), json!(true));
        }
    }
    if actions.contains(&"toggle") {
        if let Some(s) = prop(e, UIA_ToggleToggleStatePropertyId).and_then(|v| i32::try_from(&v).ok()) {
            o.insert("toggle".into(), json!(["off", "on", "mixed"].get(s as usize).copied().unwrap_or("off")));
        }
    }
    if actions.contains(&"expand") {
        if let Some(s) = prop(e, UIA_ExpandCollapseExpandCollapseStatePropertyId).and_then(|v| i32::try_from(&v).ok()) {
            o.insert("expanded".into(), json!(["collapsed", "expanded", "partial", "leaf"].get(s as usize).copied().unwrap_or("collapsed")));
        }
    }
    // A Win32 date picker or month calendar is a bare Pane to UI Automation (WinForms' too): no
    // value, no pattern. Its own window says what it holds (datetime.rs).
    if matches!(ct, 50025 | 50033) {
        if let Ok(h) = unsafe { e.CachedNativeWindowHandle() } {
            if !h.0.is_null() {
                if let Some(d) = crate::datetime::describe(h) {
                    o.insert("datetime".into(), d);
                }
            }
        }
    }
    if actions.contains(&"select") && prop_bool(e, UIA_SelectionItemIsSelectedPropertyId) {
        o.insert("selected".into(), json!(true));
    }
    if actions.contains(&"range") {
        if let Some(n) = prop(e, UIA_RangeValueValuePropertyId).and_then(|v| f64::try_from(&v).ok()) {
            o.insert("range".into(), json!(n));
        }
    }
    if let Some(d) = prop_str(e, UIA_LegacyIAccessibleDefaultActionPropertyId) {
        o.insert("defaultAction".into(), json!(d));
    }
    if let Some(help) = prop_str(e, UIA_HelpTextPropertyId) {
        o.insert("help".into(), json!(help));
    }
    v
}
