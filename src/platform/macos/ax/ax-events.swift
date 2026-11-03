// POSTED EVENTS: the keys, the typing, the wheel and the mouse — everything this helper puts into
// the system rather than asks an element to do.
//
// The seam with ax-input.swift: an AX ACTION asks the app to do something and leaves the screen
// alone; a posted event IS input, and where it is posted decides who it belongs to.
//
// KEYS STAY ON `postToPid`, beyond delivery: a session-tap KEY resets the hardware idle counter
// that `humanIdleSeconds` (ax-apps.swift) reads, so routing `postChord` or `typeText` through the
// session tap would read our own typing as the user and wedge the mouse fallback shut.
//
// KEYCODES COME FROM THE USER'S LAYOUT, never a table: `UCKeyTranslate` run backwards over the
// current layout (a US table would type wrong characters for a French or Dvorak user). Built once,
// ~60-85 ms, rebuilt only if the input source changes.
import AppKit
import ApplicationServices
import Carbon
import Foundation


// MARK: - keyboard layout

/// Character → keycode for the CURRENT keyboard layout, plus the named keys that have no character.
final class KeyboardLayout {
  private var characters: [Character: (code: CGKeyCode, flags: CGEventFlags)] = [:]
  private var builtForSource: String?

  /// The protocol's key names (case-insensitive) and their virtual keycodes.
  static let named: [String: CGKeyCode] = [
    "enter": 36, "return": 36, "tab": 48, "escape": 53, "esc": 53, "space": 49,
    "backspace": 51, "delete": 117, "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  static let modifiers: [String: CGEventFlags] = [
    "cmd": .maskCommand, "ctrl": .maskControl, "alt": .maskAlternate, "opt": .maskAlternate, "shift": .maskShift,
  ]

  static let supportedNames =
    "a single character, or Enter/Return, Tab, Escape/Esc, Space, Backspace, Delete, Up, Down, Left, Right, "
    + "Home, End, PageUp, PageDown, F1…F12; modifiers cmd, ctrl, alt/opt, shift joined with +"

  private static func currentSourceId() -> String? {
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let ptr = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
    else { return nil }
    return Unmanaged<CFString>.fromOpaque(ptr).takeUnretainedValue() as String
  }

  private func ensureMap() {
    let sourceId = Self.currentSourceId()
    if builtForSource != nil && sourceId == builtForSource { return }
    characters = Self.buildMap()
    builtForSource = sourceId ?? ""
  }

  /// Runs the layout backwards: for every keycode, what does it produce plain and with shift?
  private static func buildMap() -> [Character: (code: CGKeyCode, flags: CGEventFlags)] {
    var map: [Character: (code: CGKeyCode, flags: CGEventFlags)] = [:]
    guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
      let ptr = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else { return map }
    let data = Unmanaged<CFData>.fromOpaque(ptr).takeUnretainedValue() as Data
    let kbdType = UInt32(LMGetKbdType())
    // Plain first, then shift: a character reachable both ways prefers the cheaper chord.
    let modifierSets: [(UInt32, CGEventFlags)] = [(0, []), (UInt32(shiftKey >> 8), .maskShift)]
    data.withUnsafeBytes { raw in
      guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
      for (carbonModifiers, flags) in modifierSets {
        for code in UInt16(0)..<UInt16(128) {
          var deadKeys: UInt32 = 0
          var length = 0
          var chars = [UniChar](repeating: 0, count: 8)
          let status = UCKeyTranslate(
            layout, code, UInt16(kUCKeyActionDown), carbonModifiers, kbdType,
            OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars)
          guard status == noErr, length == 1, let character = String(utf16CodeUnits: chars, count: 1).first,
            !character.isNewline, !character.isWhitespace || character == " "
          else { continue }
          if map[character] == nil { map[character] = (CGKeyCode(code), flags) }
        }
      }
    }
    return map
  }

  /// Resolves `cmd+shift+s`, `Return`, `A` (uppercase implies shift), `cmd++` (a literal `+`).
  func resolve(_ chord: String) throws -> (code: CGKeyCode, flags: CGEventFlags) {
    ensureMap()
    var parts = chord.split(separator: "+", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
    if parts.count > 1, parts.last == "" {  // "cmd++" → the key is "+"
      parts.removeLast()
      parts[parts.count - 1] = "+"
    }
    guard let key = parts.popLast(), !key.isEmpty else {
      throw HelperError("bad_request", "chord \"\(chord)\" names no key; supported: \(Self.supportedNames)")
    }
    var flags: CGEventFlags = []
    for part in parts {
      guard let flag = Self.modifiers[part.lowercased()] else {
        throw HelperError("bad_request", "\"\(part)\" is not a modifier; supported: \(Self.supportedNames)")
      }
      flags.insert(flag)
    }
    if let code = Self.named[key.lowercased()] { return (code, flags) }
    if key.count == 1, let character = key.first {
      if let hit = characters[character] { return (hit.code, flags.union(hit.flags)) }
      if let hit = characters[Character(key.lowercased())] {
        return (hit.code, flags.union(hit.flags).union(character.isUppercase ? .maskShift : []))
      }
    }
    throw HelperError("bad_request", "unknown key \"\(key)\" (not on the current layout); supported: \(Self.supportedNames)")
  }
}

let keyboard = KeyboardLayout()

// MARK: - posted events

/// `.privateState` is load-bearing: with the combined session state a modifier the USER is holding
/// would merge into our event (Return while the human holds ⌘ would send ⌘Return).
func eventSource() throws -> CGEventSource {
  guard let source = CGEventSource(stateID: .privateState) else {
    throw HelperError("ax_error", "could not create an event source")
  }
  return source
}

/// `key {pid, chord}`: key-down then key-up, into ONE process's queue.
func postChord(pid: pid_t, chord: String) throws {
  try requirePostEvents()
  let (code, flags) = try keyboard.resolve(chord)
  let source = try eventSource()
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
  else { throw HelperError("ax_error", "could not build a key event for keycode \(code)") }
  down.flags = flags
  up.flags = flags
  down.postToPid(pid)
  up.postToPid(pid)
}

/// `type {pid, text}`: unicode key events, so any character lands regardless of layout or input
/// method. One CHARACTER per down/up pair: `keyboardSetUnicodeString` truncates long strings and
/// many apps insert only the first code point of a longer event. The short pause keeps apps that
/// rebuild their field per keystroke from dropping events posted faster than they redraw.
func typeText(pid: pid_t, text: String) throws {
  try requirePostEvents()
  let source = try eventSource()
  for character in text {
    var units = Array(String(character).utf16)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
      let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    else { throw HelperError("ax_error", "could not build a key event") }
    down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
    up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
    down.postToPid(pid)
    up.postToPid(pid)
    Thread.sleep(forTimeInterval: 0.003)
  }
}

/// `scroll {pid, x, y, dy, dx}`: a wheel event in LINE units at a screen point.
///
/// Sign: positive `dy` scrolls the content DOWN; a positive `wheel1` scrolls it UP, so `dy` is
/// negated. Lines rather than pixels, so the app applies its own acceleration.
///
/// Posted to the SESSION TAP: a pid-posted wheel scrolls nothing, in any variant. macOS scrolls the
/// window under the cursor without raising it. The tap event carries the real cursor along, so it
/// is put straight back with a `mouseMoved` (so hover state follows). The wheel goes to whatever is
/// UNDER the point, so a covered point is refused rather than scrolling another app's window.
func scrollWheel(pid: pid_t, x: Double, y: Double, dy: Double, dx: Double) throws {
  try requirePostEvents()
  let point = CGPoint(x: x, y: y)
  if let owner = windowOwnerBlocking(point, target: pid) {
    throw HelperError("no_window", "the point \(x),\(y) is covered by \(describeApp(owner))'s window")
  }
  let source = try eventSource()
  guard
    let event = CGEvent(
      scrollWheelEvent2Source: source, units: .line, wheelCount: 2,
      wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0)
  else { throw HelperError("ax_error", "could not build a scroll event") }
  let cursorBefore = CGEvent(source: nil)?.location
  event.location = point
  event.post(tap: .cgSessionEventTap)
  // A scroll is an act with a place, so it leaves the same mark a click does.
  showPointer(at: point, owner: pid, holding: false, pulse: true)
  if let cursorBefore,
    let back = CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: cursorBefore, mouseButton: .left)
  {
    back.post(tap: .cgSessionEventTap)
    notePointerAt(cursorBefore, owner: pid)
  }
}

/// Some helpers below are internal rather than file-private: `ax-pointer.swift` posts the same
/// events under the same guards, and a duplicate coverage check is how two files come to disagree.

/// `mouse {pid, x, y, button, count}`: a click at a screen point — mouse-down then mouse-up, `count`
/// times with the click state counting up so a double-click reads as one to the app.
///
/// On the SESSION TAP: `postToPid` mouse events land nowhere, Electron or AppKit, behind or in
/// front. (The subtype-3 click in ax-background-keys.swift only establishes a key window.) A tap
/// event is a real click: the window under the point is raised and takes focus, so a covered point
/// is refused and the user's cursor is put back afterwards. The driver's mouse notes say the app
/// was brought forward.
func mouseClick(pid: pid_t, x: Double, y: Double, button: String, count: Int) throws {
  try requirePostEvents()
  let point = CGPoint(x: x, y: y)
  try requireUncovered(point, pid: pid)
  let (btn, downType, upType) = mouseTypes(button)
  let source = try eventSource()
  let cursorBefore = CGEvent(source: nil)?.location
  // The pointer goes there FIRST: a hover-gated web button (a row's kebab that appears on hover)
  // is not hit-testable until the pointer enters it. An APPROACH, not a warp: a popup that watches
  // the pointer ignores a press it never saw arrive (`postApproach`).
  postApproach(to: point, owner: pid, source: source)
  Thread.sleep(forTimeInterval: HOVER_SETTLE_MS / 1000)
  for i in 1...max(1, count) {
    guard let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: btn),
      let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: btn)
    else { throw HelperError("ax_error", "could not build a mouse event") }
    down.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    up.setIntegerValueField(.mouseEventClickState, value: Int64(i))
    down.post(tap: .cgSessionEventTap)
    up.post(tap: .cgSessionEventTap)
    if i < count { Thread.sleep(forTimeInterval: 0.06) }
  }
  // The act's own mark, before the cursor goes home: "the agent clicked HERE".
  showPointer(at: point, owner: pid, holding: false, pulse: true)
  restoreCursor(to: cursorBefore, owner: pid, source: source)
}

/// `drag {pid, x, y, toX, toY}`: left button down at the start, a short run of drag events along the
/// line, up at the destination — the shape a slider, a resize handle or a drop target expects. Same
/// tap, same refusal, same cursor restore as `mouse`.
func mouseDrag(pid: pid_t, x: Double, y: Double, toX: Double, toY: Double) throws {
  try requirePostEvents()
  let from = CGPoint(x: x, y: y)
  let to = CGPoint(x: toX, y: toY)
  try requireUncovered(from, pid: pid)
  let source = try eventSource()
  let cursorBefore = CGEvent(source: nil)?.location
  guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left),
    let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)
  else { throw HelperError("ax_error", "could not build a mouse event") }
  down.post(tap: .cgSessionEventTap)
  let steps = 8
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    if let move = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left) {
      move.post(tap: .cgSessionEventTap)
    }
    Thread.sleep(forTimeInterval: 0.015)
  }
  up.post(tap: .cgSessionEventTap)
  restoreCursor(to: cursorBefore, owner: pid, source: source)
}

func mouseTypes(_ button: String) -> (CGMouseButton, CGEventType, CGEventType) {
  switch button {
  case "right": return (.right, .rightMouseDown, .rightMouseUp)
  case "middle": return (.center, .otherMouseDown, .otherMouseUp)
  default: return (.left, .leftMouseDown, .leftMouseUp)
  }
}

/// A tap event goes to whatever is under the point; refuse rather than click into another app.
func requireUncovered(_ point: CGPoint, pid: pid_t) throws {
  if let owner = windowOwnerBlocking(point, target: pid) {
    throw HelperError("no_window", "the point \(Int(point.x)),\(Int(point.y)) is covered by \(describeApp(owner))'s window")
  }
}

/// The human's cursor goes back where it was — a plain move, so hover state follows it.
private func restoreCursor(to before: CGPoint?, owner: pid_t, source: CGEventSource) {
  guard let before else { return }
  postMove(before, source: source)
  notePointerAt(before, owner: owner)
}

/// One `mouseMoved` on the session tap — the same delivery the click and the wheel ride, for the
/// same reason (`CGEventPostToPid` lands nowhere; see this file's header).
private func postMove(_ point: CGPoint, source: CGEventSource) {
  CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?
    .post(tap: .cgSessionEventTap)
}

/// How long web content is given to react to the pointer arriving. Chromium sets `:hover` and
/// re-lays-out on its next frame; 60 ms covers two at 30 fps.
private let HOVER_SETTLE_MS: Double = 60

/// `hover {pid, x, y}`: put the pointer on a point and LEAVE it there — the reveal half of a click,
/// for reading what only exists while hovered. It does not restore the cursor; the caller's note
/// has to say the user's pointer moved.
func mouseHover(pid: pid_t, x: Double, y: Double) throws {
  try requirePostEvents()
  let point = CGPoint(x: x, y: y)
  try requireUncovered(point, pid: pid)
  postApproach(to: point, owner: pid, source: try eventSource())
  Thread.sleep(forTimeInterval: HOVER_SETTLE_MS / 1000)
}
