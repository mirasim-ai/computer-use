// Menu commands, and the AX-native equivalents of the ⌘ shortcuts a background app will not run.
//
// AXPress on a menu item runs app-level commands (New, Preferences) with the app in the
// BACKGROUND. Items AppKit validates against the key window (Select All, Close, Save, Undo, Copy,
// Paste) read `enabled=false` while the app is inactive, and pressing them is a no-op. Two have an
// activation-free AX primitive: Select All is `AXSelectedTextRange` over the whole value, Close is
// the window's `AXCloseButton`. Electron's `role:` items are the same selectors and behave the same.
import AppKit
import ApplicationServices
import Foundation

extension AXEngine {
  /// `menu {pid}` → every leaf item of the app's menu bar as `{key, path, title, enabled, cmd, mods}`.
  /// `cmd` is the ⌘ character and `mods` the AX modifier mask (0 = ⌘ alone, 1 = ⇧, 2 = ⌥, 4 = ⌃,
  /// 8 = no ⌘). Keys join the pid's current table — the next `tree` replaces them, so list right
  /// before pressing. Titles are localised; match on `cmd`/`mods` or on the path the model was shown.
  func menu(pid: pid_t) throws -> [[String: Any]] {
    try requireTrusted()
    _ = try runningApp(pid)
    guard let bar = attr(appElement(pid), kAXMenuBarAttribute as String), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
      throw HelperError("no_element", "app \(pid) exposes no menu bar")
    }
    var out: [[String: Any]] = []
    var isAppMenu = true
    for top in children(bar as! AXUIElement) {
      let title = (attr(top, kAXTitleAttribute as String) as? String) ?? ""
      if title == "Apple" { continue }  // the system's menu, not the app's: About This Mac, Sleep, Log Out…
      // The application menu's only submenu is Services — dozens of other apps' commands. Skipped.
      for menu in children(top) { collectMenu(menu, path: [title], pid: pid, depth: 0, submenus: !isAppMenu, into: &out) }
      isAppMenu = false
    }
    return out
  }

  private func collectMenu(_ menu: AXUIElement, path: [String], pid: pid_t, depth: Int, submenus: Bool, into out: inout [[String: Any]]) {
    for item in children(menu) {
      let title = (attr(item, kAXTitleAttribute as String) as? String) ?? ""
      if title.isEmpty { continue }  // separators
      let full = path + [title]
      let subs = children(item)
      if !subs.isEmpty {
        if submenus, depth < 3 {
          for sub in subs { collectMenu(sub, path: full, pid: pid, depth: depth + 1, submenus: true, into: &out) }
        }
        continue
      }
      out.append([
        "key": register(item, pid: pid), "path": full.joined(separator: " › "), "title": title,
        "enabled": (attr(item, kAXEnabledAttribute as String) as? NSNumber)?.boolValue ?? false,
        "cmd": (attr(item, kAXMenuItemCmdCharAttribute as String) as? String) ?? "",
        "mods": (attr(item, kAXMenuItemCmdModifiersAttribute as String) as? NSNumber)?.intValue ?? 8,
      ])
    }
  }

  /// `selectall {pid, key?}` → the selected length. Selects the whole value of an element (the app's
  /// focused element when no key is given) — ⌘A's effect, without the menu item a background app
  /// leaves disabled.
  func selectAll(pid: pid_t, key: String?) throws -> Int {
    // The keyless branch needs its own guard (`element(forKey:)` has one), or ungranted it would
    // blame the app: "no focused element".
    try requireTrusted()
    let el: AXUIElement
    if let key {
      el = try element(forKey: key)
    } else {
      guard let f = attr(appElement(pid), kAXFocusedUIElementAttribute as String), CFGetTypeID(f) == AXUIElementGetTypeID() else {
        throw HelperError("no_element", "app \(pid) has no focused element to select in")
      }
      el = f as! AXUIElement
    }
    let value = (attr(el, kAXValueAttribute as String) as? String) ?? ""
    var range = CFRange(location: 0, length: (value as NSString).length)
    guard let v = AXValueCreate(.cfRange, &range) else { throw HelperError("ax_error", "could not build a text range") }
    let status = AXUIElementSetAttributeValue(el, kAXSelectedTextRangeAttribute as CFString, v)
    if status != .success { throw axFailure(status, "select all") }
    return range.length
  }

  /// `closewindow {pid, window?}`: press the window's own close button — ⌘W's effect for a window the
  /// app will not close through its menu while in the background. The app may answer with a save
  /// sheet; that sheet is part of the next tree, where its buttons are pressable like any other.
  func closeWindow(pid: pid_t, windowId: Int?) throws {
    let picked = try pickWindow(pid: pid, windowId: windowId)
    guard let btn = attr(picked.element, kAXCloseButtonAttribute as String), CFGetTypeID(btn) == AXUIElementGetTypeID() else {
      throw HelperError("no_element", "the window has no close button")
    }
    let status = AXUIElementPerformAction(btn as! AXUIElement, kAXPressAction as CFString)
    if status != .success { throw axFailure(status, "close window") }
  }

  /// `raisewindow {pid, window?}` → `{raised}`: make the driven window the app's main (and so key)
  /// window, so a menu command lands on IT rather than whichever window the app had in front.
  /// `raised` is false when it already was.
  func raiseWindow(pid: pid_t, windowId: Int?) throws -> [String: Any] {
    let picked = try pickWindow(pid: pid, windowId: windowId)
    if (attr(picked.element, kAXMainAttribute as String) as? Bool) == true { return ["raised": false] }
    AXUIElementSetAttributeValue(picked.element, kAXMainAttribute as CFString, kCFBooleanTrue)
    let status = AXUIElementPerformAction(picked.element, kAXRaiseAction as CFString)
    if status != .success { throw axFailure(status, "raise window") }
    return ["raised": true]
  }
}
