// The Accessibility engine: app elements, the batched window walk, the key table, hit testing.
//
// Measured rules:
//   1. Batch attributes — `AXUIElementCopyMultipleAttributeValues` took a 661-node Finder walk from
//      332 ms to 107 ms. Every attribute read is a synchronous IPC; the round-trip count IS the cost.
//   2. Bound the depth and the node count; the caller chooses, the defaults are generous.
//   3. Set a messaging timeout. The AX default is SIX SECONDS per wedged call; 1.5 s keeps one
//      unresponsive app from holding the session hostage.
//   4. Hit-test (`at`) instead of walking when a coordinate is already known.
//
// Chromium/Electron apps build their AX tree lazily and expose almost nothing until an assistive
// client asks: setting `AXManualAccessibility` on the app element and re-walking fills it in
// (Mirasim: 8 nodes → 1,384 in 235 ms). The nudge is per pid and undone by the hidden `unnudge` op.
import AppKit
import ApplicationServices
import Foundation

/// 1.5 s: long enough for a busy app, short enough that a wedged one cannot stall a turn.
let AX_TIMEOUT: Float = 1.5

/// How much of an element's value the tree walk carries: a PREVIEW, flagged when cut, so a screen
/// of long values cannot blow up one response. The `value` op hands back the whole thing.
private let VALUE_PREVIEW = 400

/// Fetched in ONE round trip per element. Order is load-bearing — `read` indexes into it.
private let BATCH_ATTRS: [String] = [
  kAXRoleAttribute as String, kAXSubroleAttribute as String, kAXTitleAttribute as String,
  kAXValueAttribute as String, kAXDescriptionAttribute as String, kAXPositionAttribute as String,
  kAXSizeAttribute as String, kAXEnabledAttribute as String, kAXFocusedAttribute as String,
  // The extras below are free (same batched round trip). The developer-assigned id is the only
  // thing that tells two NAMELESS controls apart.
  "AXIdentifier",
  // The tooltip: what the control DOES where the name only says what it is called (a format
  // painter named Format).
  kAXHelpAttribute as String,
  // The chosen one of a set of BUTTONS: System Settings' Light / Dark / Auto carry no value, only
  // AXSelected on the current one.
  kAXSelectedAttribute as String,
]

/// Roles that are an Element on their own. Anything else earns a place only by carrying AXPress.
private let INCLUDED_ROLES: Set<String> = [
  "AXButton", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
  "AXMenuButton", "AXComboBox", "AXSlider", "AXIncrementor", "AXLink", "AXMenuItem", "AXTabGroup",
  "AXDisclosureTriangle", "AXCell", "AXRow", "AXColorWell", "AXStaticText", "AXImage", "AXWebArea",
]

/// A frame number JSON can carry. AX hands out NaN and infinities (Preview showing a PDF), and
/// `NSJSONSerialization` throws an NSException on them that Swift cannot catch, killing the
/// resident helper with SIGABRT. Non-finite means no geometry, which zero already means here.
func jsonNumber(_ v: CGFloat) -> Double { v.isFinite ? Double(v) : 0 }

/// One element's batched read, before it is decided whether it is worth listing.
struct Node {
  var role = ""
  var subrole = ""
  var title = ""
  var desc = ""
  var value = ""
  var frame = CGRect.zero
  var enabled = true
  var focused = false
  var actions: [String] = []
  /// The value above is a prefix — the whole one is behind the `value` op.
  var valueCut = false
  /// `AXIdentifier` — what the app's own developer called this control. Not a name the user sees,
  /// but for a nameless control the only thing that says which one it is (see `json`).
  var ident = ""
  /// `AXHelp` — the tooltip. What the control DOES, where the name says what it is called.
  var help = ""
  /// `AXSelected` — the chosen member of a set of buttons, rows or cells.
  var selected = false

  /// UNADDRESSABLE: nothing names it — no title, description, value or developer id — and the
  /// keyboard is not in it. Not on its own a reason to drop one (a badly labelled toolbar button is
  /// still the only way to press it); DENSITY decides (`bulkRole`): a lone one is kept, a wall not.
  var bare: Bool {
    title.isEmpty && desc.isEmpty && value.isEmpty && ident.isEmpty && !focused
  }

  /// Worth listing: a known role, or anything pressable; never a zero-area node unless it is text.
  var included: Bool {
    guard INCLUDED_ROLES.contains(role) || actions.contains("AXPress") else { return false }
    if role == "AXImage" && desc.isEmpty { return false }
    if frame.width <= 0 || frame.height <= 0 { return role == "AXStaticText" && !value.isEmpty }
    return true
  }

  /// `seq` is the walk's visit counter when this node was read — its position in document order.
  /// On-screen and off-screen nodes leave in separate arrays, so `text()` needs it to merge them.
  /// Unique within a walk; meaningless across walks.
  func json(key: String, seq: Int? = nil, depth: Int, off: Bool = false) -> [String: Any] {
    var out: [String: Any] = [
      "key": key, "role": role, "subrole": subrole, "title": title, "desc": desc, "value": value,
      "x": jsonNumber(frame.origin.x), "y": jsonNumber(frame.origin.y),
      "w": jsonNumber(frame.width), "h": jsonNumber(frame.height),
      "enabled": enabled, "focused": focused, "actions": actions, "depth": depth,
    ]
    // Optional fields go out only when set: a field on every element of every walk is payload.
    if let seq { out["seq"] = seq }
    // Every real id is sent; the client decides where it earns a line (elements.ts). AppKit's
    // generated ones ("_NS:9") are a serial number and dropped here.
    if !ident.isEmpty && !ident.hasPrefix("_NS:") { out["ident"] = ident }
    if !help.isEmpty { out["help"] = help }
    if valueCut { out["valueCut"] = true }
    if selected { out["selected"] = true }
    if off { out["off"] = true }
    return out
  }
}

final class AXEngine {
  /// One app element per pid, reused: the messaging timeout is set once on it.
  private var appElements: [pid_t: AXUIElement] = [:]
  /// pids where the AXManualAccessibility nudge TOOK, to switch back on exit. No "already tried"
  /// set: a still-thin tree is nudged again on the next read (see `tree`).
  var nudged: Set<pid_t> = []
  /// key → live element. Keys are globally unique, so a key from an older `tree` is simply absent.
  var keys: [String: AXUIElement] = [:]
  var keysByPid: [pid_t: [String]] = [:]
  var nextKey = 0
  /// The user's own pasteboard, held for the length of ONE paste and never sent over the wire
  /// (ax-input.swift's `stashClipboard` explains why it lives here rather than in the client).
  var stashed: [NSPasteboardItem] = []
  var stashedChangeCount: Int? = nil

  // MARK: plumbing

  func appElement(_ pid: pid_t) -> AXUIElement {
    if let existing = appElements[pid] { return existing }
    let el = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(el, AX_TIMEOUT)
    appElements[pid] = el
    return el
  }

  func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success ? out : nil
  }

  func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
  }

  /// Action names, kept only when they look like `AXPress`: AppKit exposes some toolbar items with a
  /// generated debug dump as the "name" (`AXName:Copy\nTarget:0x0\nSelector:(null)`), unperformable.
  private func actionNames(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return ((names as? [String]) ?? []).filter { name in
      name.hasPrefix("AX") && name.count > 2 && name.dropFirst(2).allSatisfy { $0.isASCII && $0.isLetter }
    }
  }

  /// Reads one element in two IPC round trips: the attribute batch and its action names.
  ///
  /// `contentActions: false` (the walk's setting) skips the second for `AXStaticText` and `AXImage`,
  /// which makes a long document affordable (a text-heavy window: 470 ms → 370 ms). Both roles are
  /// listed regardless, and a pressable one stays clickable — `act-element.ts` sends a bare `press`,
  /// which defaults to AXPress. Lost: naming it as a button, and the action list in a refusal.
  func read(_ el: AXUIElement, contentActions: Bool = true) -> Node {
    var n = Node()
    var values: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(el, BATCH_ATTRS as CFArray, AXCopyMultipleAttributeOptions(), &values)
    if status == .success, let list = values as? [CFTypeRef], list.count == BATCH_ATTRS.count {
      n.role = string(list[0])
      n.subrole = string(list[1])
      n.title = string(list[2])
      let rawValue = string(list[3])
      n.value = String(rawValue.prefix(VALUE_PREVIEW))
      n.valueCut = rawValue.count > VALUE_PREVIEW
      n.desc = string(list[4])
      if let p = axPoint(list[5]) { n.frame.origin = p }
      if let s = axSize(list[6]) { n.frame.size = s }
      n.enabled = (list[7] as? NSNumber)?.boolValue ?? true
      n.focused = (list[8] as? NSNumber)?.boolValue ?? false
      n.ident = string(list[9])
      n.help = string(list[10])
      n.selected = (list[11] as? NSNumber)?.boolValue ?? false
    }
    if contentActions || (n.role != "AXStaticText" && n.role != "AXImage") { n.actions = actionNames(el) }
    return n
  }

  /// Missing values arrive as an AXValue of illegal type, not as nil — hence the type checks.
  func string(_ v: CFTypeRef) -> String {
    if let s = v as? String { return s }
    if let n = v as? NSNumber {
      return CFGetTypeID(v) == CFBooleanGetTypeID() ? (n.boolValue ? "true" : "false") : n.stringValue
    }
    if let u = v as? URL { return u.absoluteString }
    return ""
  }

  func axPoint(_ v: CFTypeRef) -> CGPoint? {
    guard CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cgPoint else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
  }

  func axSize(_ v: CFTypeRef) -> CGSize? {
    guard CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .cgSize else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
  }

  // MARK: windows

  /// The app's windows, with the KEY-WINDOW FALLBACK: Chromium/Electron hosts answer
  /// `AXWindows` with an empty array while `AXFocusedWindow` / `AXMainWindow` return a good window.
  /// Also probes the app once so "not answering" is reported as itself rather than as "no windows".
  func axWindows(pid: pid_t) throws -> [AXUIElement] {
    try requireTrusted()
    // The kernel, not LaunchServices: a pure EXISTENCE check, and LaunchServices intermittently
    // answers nil for a live process, which would end the session (see `liveApp` in ax-apps.swift).
    guard processAlive(pid) else {
      throw HelperError("no_app", "no running app with pid \(pid)")
    }
    let app = appElement(pid)
    var probe: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(app, kAXRoleAttribute as CFString, &probe)
    if status != .success { throw axFailure(status, "app \(pid)") }
    let listed = (attr(app, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    if !listed.isEmpty { return listed }
    for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
      if let w = attr(app, name as String), CFGetTypeID(w) == AXUIElementGetTypeID() { return [w as! AXUIElement] }
    }
    return []
  }

  /// `windows {pid}` rows: AX geometry, paired one-to-one with the window server's ids.
  func windows(pid: pid_t) throws -> [[String: Any]] {
    let list = try axWindows(pid: pid)
    let nodes = list.map { read($0) }
    let ids = matchWindowIds(nodes.map(\.frame), cgWindowRows(pid: pid, panels: true))
    return list.indices.map { i in
      let n = nodes[i]
      let main = (attr(list[i], kAXMainAttribute as String) as? NSNumber)?.boolValue ?? false
      return [
        "id": ids[i], "title": n.title, "onScreen": ids[i] >= 0,
        "x": jsonNumber(n.frame.origin.x), "y": jsonNumber(n.frame.origin.y),
        "w": jsonNumber(n.frame.width), "h": jsonNumber(n.frame.height),
        "main": main, "focused": n.focused,
      ]
    }
  }

  /// The window to walk: the one with the requested CGWindowID, else focused → main → first.
  ///
  /// The pairing is the same one `windows` reports, so a pinned id resolves to the window it was
  /// listed against, even when two windows share a frame.
  func pickWindow(pid: pid_t, windowId: Int?) throws -> (element: AXUIElement, json: [String: Any]) {
    let list = try axWindows(pid: pid)
    guard !list.isEmpty else { throw HelperError("no_window", "app \(pid) has no window\(lockedSuffix())") }
    let nodes = list.map { read($0) }
    let frames = nodes.map(\.frame)
    let rows = cgWindowRows(pid: pid, panels: true)
    let ids = matchWindowIds(frames, rows)
    let index: Int
    if let windowId {
      guard let i = pickWindowIndex(windowId: windowId, ids: ids, frames: frames, rows: rows) else {
        throw HelperError("no_window", "app \(pid) has no window with id \(windowId)\(lockedSuffix())")
      }
      index = i
    } else {
      index =
        nodes.indices.first { nodes[$0].focused }
        ?? list.indices.first { (attr(list[$0], kAXMainAttribute as String) as? NSNumber)?.boolValue == true } ?? 0
    }
    let n = nodes[index]
    // `onScreen` spells out what `id: -1` implies: an unlisted window's walk comes back EMPTY
    // rather than failing, and "0 elements" must not read as "this app has no controls".
    let json: [String: Any] = [
      "id": ids[index], "title": n.title, "onScreen": ids[index] >= 0,
      "x": jsonNumber(n.frame.origin.x), "y": jsonNumber(n.frame.origin.y),
      "w": jsonNumber(n.frame.width), "h": jsonNumber(n.frame.height),
    ]
    return (list[index], json)
  }

}
