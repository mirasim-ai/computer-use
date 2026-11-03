// Input: AX actions on elements, and the targeted events for what AX has no vocabulary for.
//
// A CLICK is `AXPress`: no cursor move, no focus steal, so the human keeps using the machine. A
// synthetic MOUSE event is the fallback when AXPress is refused or ignored (Electron apps accept it
// and do nothing); it rides the session tap, so the app comes forward. A KEY is posted to ONE pid
// with `CGEventPostToPid` and reaches a background app. A SCROLL is a located wheel event on the
// session tap (a pid-posted wheel does nothing). Document shortcuts go through
// ax-background-keys.swift, whose subtype-3 activation click is distinct from ordinary mouse input.
// The posted events and their rules live in ax-events.swift.
import AppKit
import ApplicationServices
import Carbon
import Foundation

// MARK: - element actions

extension AXEngine {
  /// `press {key, action}`: the action by name, `AXPress` by default.
  func press(key: String, action: String) throws {
    let el = try element(forKey: key)
    let status = AXUIElementPerformAction(el, action as CFString)
    if status != .success { throw axFailure(status, "\(action) on \(key)") }
    markPointer(at: el)
  }

  /// Put the drawn pointer on the element an ACCESSIBILITY act just touched — and post nothing.
  ///
  /// An AXPress moves no cursor, so without this the agent's acts would be invisible; the ring
  /// shows them while the user's own cursor stays theirs.
  ///
  /// Only while the user can SEE that element: the target is usually BEHIND another window, and the
  /// mark's panel floats above every window, so a covered point is CONCEALED rather than drawn on
  /// top of what the user is reading (@see `overlayConceal`, `pointShowing`). Best-effort: an
  /// element with no geometry is not marked, and nothing here can fail the calling act.
  func markPointer(at el: AXUIElement) {
    var pos: CFTypeRef?
    var size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &pos) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &size) == .success,
          let p = pos.flatMap(axPoint), let s = size.flatMap(axSize), s.width > 0, s.height > 0
    else { return }
    let center = CGPoint(x: p.x + s.width / 2, y: p.y + s.height / 2)
    // An element that will not say whose it is cannot be checked, so it is not marked.
    var pid: pid_t = 0
    guard AXUIElementGetPid(el, &pid) == .success else { return }
    guard pointShowing(center, of: pid) else {
      notePointerHidden(center, owner: pid)
      return
    }
    notePointerAt(center, owner: pid, drawn: true)
  }

  /// `ancestors {key, limit}`: the chain ABOVE an element, nearest first, each registered as a key
  /// of its own so the caller can act on one.
  ///
  /// A clicked control is often not the node that CARRIES the click: Finder's sidebar item is an
  /// action-less `AXStaticText` in an `AXCell` offering `AXOpen`, in an `AXRow` with settable
  /// `AXSelected`. Which ancestor may stand in for a click is the client's decision
  /// (press-rungs.ts), so this reports capabilities only. `selectable` asks
  /// `AXUIElementIsAttributeSettable`: a row that merely REPORTS its selection cannot be selected.
  func ancestors(key: String, limit: Int) throws -> [[String: Any]] {
    var el = try element(forKey: key)
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    var out: [[String: Any]] = []
    for _ in 0..<max(0, limit) {
      guard let parent = attr(el, kAXParentAttribute as String) else { break }
      let up = parent as! AXUIElement
      var names: CFArray?
      let actions = AXUIElementCopyActionNames(up, &names) == .success ? (names as? [String] ?? []) : []
      var settable = DarwinBoolean(false)
      AXUIElementIsAttributeSettable(up, kAXSelectedAttribute as CFString, &settable)
      let role = (attr(up, kAXRoleAttribute as String) as? String) ?? ""
      out.append([
        "key": register(up, pid: pid),
        "role": role,
        "actions": actions,
        "selectable": settable.boolValue,
        "selected": (attr(up, kAXSelectedAttribute as String) as? Bool) == true,
        "name": (attr(up, kAXTitleAttribute as String) as? String) ?? (attr(up, kAXDescriptionAttribute as String) as? String) ?? "",
      ])
      // The window is the top of anything a click can mean; above it are the app and the system.
      if role == kAXWindowRole as String { break }
      el = up
    }
    return out
  }

  /// `select {key}`: select this element the way a single click does — through its CONTAINER where
  /// the container owns the selection, and only otherwise through the element's own `AXSelected`.
  ///
  /// The order matters: an AppKit table or outline owns its selection. In Finder's sidebar setting
  /// the row's own settable `AXSelected` succeeds and changes nothing, while the outline's
  /// `AXSelectedRows = [row]` navigates at once. Never `AXOpen` here: on a file row it opens the
  /// file, which is a double click's meaning.
  func setSelected(key: String) throws {
    let el = try element(forKey: key)
    if let parentRef = attr(el, kAXParentAttribute as String) {
      let parent = parentRef as! AXUIElement
      for attribute in [kAXSelectedRowsAttribute, kAXSelectedChildrenAttribute] {
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(parent, attribute as CFString, &settable)
        guard settable.boolValue else { continue }
        let status = AXUIElementSetAttributeValue(parent, attribute as CFString, [el] as CFArray)
        if status == .success { return }
      }
    }
    var settable = DarwinBoolean(false)
    AXUIElementIsAttributeSettable(el, kAXSelectedAttribute as CFString, &settable)
    guard settable.boolValue else {
      throw HelperError("ax_error", "select \(key): this element's selection cannot be set", ax: AXError.attributeUnsupported.rawValue)
    }
    let status = AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    if status != .success { throw axFailure(status, "select \(key)") }
  }

  /// `setvalue {key, text}`: writes the value directly — no focus change, no keystrokes.
  func setValue(key: String, text: String) throws {
    let el = try element(forKey: key)
    let status = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString)
    if status != .success { throw axFailure(status, "set value on \(key)") }
    markPointer(at: el)
  }

  /// `clipboardstash {text, html?}`: remember EVERYTHING on the pasteboard, then put this content
  /// on it. `clipboardrestore` puts the remembered content back.
  ///
  /// The stash never leaves the helper: the clipboard may hold a password, and a round trip
  /// through the client would put it in a model's context. Every item and type is kept, not just
  /// the string, or a copied image would be destroyed. An unreadable item is dropped rather than
  /// failing the paste; {@link restoreClipboard} reports how many survived.
  func stashClipboard(text: String, html: String?) -> Int {
    let board = NSPasteboard.general
    stashed = board.pasteboardItems?.compactMap { item in
      let copy = NSPasteboardItem()
      var kept = false
      for type in item.types {
        if let data = item.data(forType: type) { copy.setData(data, forType: type); kept = true }
      }
      return kept ? copy : nil
    } ?? []
    board.clearContents()
    if let html, !html.isEmpty { board.setString(html, forType: .html) }
    board.setString(text, forType: .string)
    stashedChangeCount = board.changeCount
    return stashed.count
  }

  /// Put back what {@link stashClipboard} remembered. Returns how many items were restored;
  /// zero is a real answer (the clipboard was empty before), not a failure.
  @discardableResult
  func restoreClipboard() -> Int {
    let board = NSPasteboard.general
    // A person or another app copied something during the paste. Keep their newer content;
    // restoring our old stash would overwrite it. No stash means no clipboard operation.
    guard let expected = stashedChangeCount else { return 0 }
    stashedChangeCount = nil
    guard board.changeCount == expected else { stashed = []; return -1 }
    board.clearContents()
    if !stashed.isEmpty { board.writeObjects(stashed) }
    let n = stashed.count
    stashed = []
    return n
  }

  /// `selectrange {key, start, length}`: put the field's own selection (or, with length 0, its
  /// caret) on a stretch of its value. The offsets are UTF-16 indices, which is what both AX and
  /// the client's own string indices count in.
  ///
  /// The element is focused FIRST: the range sticks on an unfocused field, but the keystrokes
  /// that follow would land in whatever the app does have focused.
  func selectRange(key: String, start: Int, length: Int) throws {
    let el = try element(forKey: key)
    AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    var range = CFRange(location: start, length: length)
    guard let value = AXValueCreate(.cfRange, &range) else {
      throw HelperError("ax_error", "could not build a range for \(key)")
    }
    let status = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, value)
    if status != .success { throw axFailure(status, "select range on \(key)") }
  }

  /// `focus {key}`: gives the element keyboard focus so the next `type`/`key` is deterministic.
  ///
  /// Answers whether the element ITSELF now reports AXFocused, which press-rungs.ts needs before
  /// sending a key on a click's behalf. The app-level `kAXFocusedUIElement` cannot stand in: in
  /// Chromium web content it keeps naming a container while focus sits on the node we set.
  @discardableResult
  func focus(key: String) throws -> Bool {
    let el = try element(forKey: key)
    let status = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    if status != .success { throw axFailure(status, "focus \(key)") }
    return (attr(el, kAXFocusedAttribute as String) as? NSNumber)?.boolValue ?? false
  }
}
