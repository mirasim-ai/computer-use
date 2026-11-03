// The KEY TABLE and the hit test: how a client names one element, and how a point becomes one.
//
// Every walk REPLACES a pid's table, so a key from an older walk answers `stale_key` and the
// client re-observes rather than act on an element that may have moved. `at` and `focusedElement`
// mint keys the same way, so a point or the app's focus can be acted on by ref.
import AppKit
import ApplicationServices
import Foundation

extension AXEngine {
  // MARK: keys

  func register(_ el: AXUIElement, pid: pid_t) -> String {
    nextKey += 1
    let key = "k\(nextKey)"
    keys[key] = el
    keysByPid[pid, default: []].append(key)
    return key
  }

  /// A new `tree` for a pid REPLACES its table; older keys then answer `stale_key`.
  func replaceKeys(pid: pid_t) {
    for key in keysByPid[pid] ?? [] { keys.removeValue(forKey: key) }
    keysByPid[pid] = []
  }

  /// Every act on an element resolves through here, so this is where an ungranted act is told apart
  /// from a stale one: ungranted there was no walk, and `stale_key` would misdiagnose it.
  func element(forKey key: String) throws -> AXUIElement {
    try requireTrusted()
    guard let el = keys[key] else {
      throw HelperError("stale_key", "key \"\(key)\" is not in the current tree — take a fresh tree")
    }
    return el
  }

  /// The FULL value of one element; the walk carries only a preview, which is enough to LIST it.
  func value(key: String) throws -> String {
    let el = try element(forKey: key)
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success,
          let got = v else { return "" }
    return string(got)
  }

  // MARK: hit test

  /// Is `el` inside an NSSavePanel/NSOpenPanel? Their sheet carries the identifier `save-panel` /
  /// `open-panel`; ANY ancestor sheet counts, because the panel's own Go To Folder sheet sits
  /// between a field and it. A panel shown as its own WINDOW (a document app launched cold) counts
  /// too, and its keys go to the same service.
  private func insideRemotePanel(_ el: AXUIElement) -> Bool {
    var node: AXUIElement? = el
    var hops = 0
    while let cur = node, hops < 40 {
      let role = attr(cur, kAXRoleAttribute as String) as? String
      if role == "AXSheet" || role == "AXWindow",
         let id = attr(cur, "AXIdentifier") as? String, id.hasSuffix("-panel") { return true }
      node = attr(cur, kAXParentAttribute as String).map { $0 as! AXUIElement }
      hops += 1
    }
    return false
  }

  /// The openAndSavePanelService process whose responsible process is `app` — the one hosting
  /// that app's Open/Save panel. `responsibility_get_pid_responsible_for_pid` is the private call
  /// TCC itself attributes with; where the symbol is missing the answer is nil and keys stay
  /// with the app, as if this did not exist.
  private func panelServicePid(responsibleFor app: pid_t) -> pid_t? {
    typealias RespFn = @convention(c) (pid_t) -> pid_t
    guard let sym = dlsym(dlopen("/usr/lib/system/libquarantine.dylib", RTLD_NOW), "responsibility_get_pid_responsible_for_pid") else { return nil }
    let responsible = unsafeBitCast(sym, to: RespFn.self)
    var count = proc_listallpids(nil, 0)
    var pids = [pid_t](repeating: 0, count: Int(count) + 64)
    count = proc_listallpids(&pids, Int32(pids.count) * Int32(MemoryLayout<pid_t>.size))
    var path = [CChar](repeating: 0, count: 4096)
    for candidate in pids.prefix(Int(max(count, 0))) where candidate > 0 {
      guard proc_pidpath(candidate, &path, UInt32(path.count)) > 0 else { continue }
      if String(cString: path).hasSuffix("openAndSavePanelService"), responsible(candidate) == app { return candidate }
    }
    return nil
  }

  /// The panel service's pid when `pid` has an Open/Save panel up — as its own window or as a sheet
  /// on one — else nil. The fallback for {@link focusedElement}: an app in the BACKGROUND answers no
  /// AXFocusedUIElement at all, while the panel is plainly in its window list.
  func panelService(pid: pid_t) throws -> pid_t? {
    try requireTrusted()
    let windows = (attr(appElement(pid), kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    let isPanel = { (el: AXUIElement) -> Bool in (self.attr(el, "AXIdentifier") as? String)?.hasSuffix("-panel") ?? false }
    for w in windows {
      let sheets = ((attr(w, kAXChildrenAttribute as String) as? [AXUIElement]) ?? [])
        .filter { (self.attr($0, kAXRoleAttribute as String) as? String) == "AXSheet" }
      if isPanel(w) || sheets.contains(where: isPanel) { return panelServicePid(responsibleFor: pid) }
    }
    return nil
  }

  /// `focused {pid}`: the element the app itself says has keyboard focus, and the window it is in.
  ///
  /// The app-level `AXFocusedUIElement`, not the walk's per-element `focused` flag: they disagree
  /// (a source list can mark every cell focused), and the app's answer decides where a menu command
  /// lands. `key` is filled in only when the CURRENT tree already handed that element out, so the
  /// caller can check focus against a ref; a focus the walk never listed comes back unkeyed.
  func focusedElement(pid: pid_t) throws -> [String: Any] {
    try requireTrusted()
    guard let el = attr(appElement(pid), kAXFocusedUIElementAttribute as String) else {
      throw HelperError("no_element", "app \(pid) reports no focused element")
    }
    let focused = el as! AXUIElement
    let existing = (keysByPid[pid] ?? []).first { keys[$0].map { CFEqual($0, focused) } ?? false }
    var out = read(focused).json(key: existing ?? "", depth: 0)
    if existing == nil { out.removeValue(forKey: "key") }
    // Where a KEY EVENT for this focus must go. An Open/Save panel is a remote view hosted by
    // openAndSavePanelService: keys posted to the app never reach it, keys to the service do. AX
    // reports the APP's pid for the panel's elements, so the panel is recognised by its sheet's
    // identifier and the service by the responsibility API.
    if insideRemotePanel(focused), let service = panelServicePid(responsibleFor: pid) {
      out["pid"] = Int(service)
    }
    // Which WINDOW holds it: that decides whether a menu command reaches this element at all.
    var node: AXUIElement? = focused
    while let cur = node {
      if (attr(cur, kAXRoleAttribute as String) as? String) == "AXWindow" {
        let n = read(cur)
        out["window"] = n.title
        // The CGWindowID, paired as `windows` pairs them, to compare against the window being
        // DRIVEN (two documents can share a title).
        out["windowId"] = matchWindowIds([n.frame], cgWindowRows(pid: pid, panels: true)).first ?? -1
        break
      }
      node = attr(cur, kAXParentAttribute as String).map { $0 as! AXUIElement }
    }
    return out
  }

  /// `at {pid,x,y}`: the deepest element under a screen point, registered as a fresh key in the pid's
  /// CURRENT table (nothing else is invalidated). Asked of the app element, so the answer is this
  /// app's even when another window overlaps. For a point outside every window AppKit answers its
  /// AXMenuBar, so a hit whose frame does not contain the point is `no_element`.
  func at(pid: pid_t, x: Double, y: Double) throws -> [String: Any] {
    try requireTrusted()
    var hit: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(appElement(pid), Float(x), Float(y), &hit)
    if status == .noValue { throw HelperError("no_element", "nothing of app \(pid) at \(x),\(y)") }
    guard status == .success, let el = hit else { throw axFailure(status, "hit test at \(x),\(y)") }
    let n = read(el)
    guard n.frame.insetBy(dx: -1, dy: -1).contains(CGPoint(x: x, y: y)) else {
      throw HelperError("no_element", "nothing of app \(pid) at \(x),\(y) (the app answered its \(n.role) elsewhere)")
    }
    return n.json(key: register(el, pid: pid), depth: 0)
  }
}
