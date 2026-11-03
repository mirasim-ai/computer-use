// A document shortcut without taking the system's foreground or keyboard focus.
// AppKit must believe it is active AND have a key window: an activation notification followed
// by a subtype-3 activation click establishes those two app-local facts. All events go to the
// target pid. The target is never activated through NSWorkspace, SetFrontProcess or key-focus
// stealing APIs. A detected input-routing failure repairs only the existing foreground app.
import AppKit
import ApplicationServices
import Foundation

private func backgroundNotification(pid: pid_t, type: UInt, subtype: Int16, window: Int = 0,
                                    flags: NSEvent.ModifierFlags = []) throws {
  guard let kind = NSEvent.EventType(rawValue: type),
        let event = NSEvent.otherEvent(with: kind, location: .zero, modifierFlags: flags,
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window, context: nil,
          subtype: subtype, data1: 0, data2: 0)?.cgEvent else {
    throw HelperError("background_key_unsupported", "macOS could not build a background activation notification")
  }
  event.postToPid(pid)
}

/// One live cleanup, also invoked when the helper receives a termination signal.
private let backgroundCleanupLock = NSLock()
private var backgroundCleanup: (() -> Void)?
func restoreBackgroundKeys() {
  backgroundCleanupLock.lock()
  let cleanup = backgroundCleanup
  backgroundCleanup = nil
  backgroundCleanupLock.unlock()
  cleanup?()
}

extension AXEngine {
  /// Only a pinned, on-screen window is eligible. Remote panels and sheets keep their existing
  /// foreground path; synthesizing activation in a different process is not covered here.
  func backgroundKey(pid: pid_t, windowId: Int, chord: String, count: Int) throws -> [String: Any] {
    let requested = min(max(count, 1), 20)
    do { _ = try keyboard.resolve(chord) } catch {
      let error = error as? HelperError ?? HelperError("bad_request", error.localizedDescription)
      throw HelperError(error.code, "0 of \(requested) key presses were posted. \(error.message)",
                        ax: error.ax, postedCount: 0, requestedCount: requested)
    }
    return try backgroundInput(pid: pid, windowId: windowId, requested: requested, unit: "key presses") { protection, posted, lastInputAt in
      for _ in 0..<requested {
        try protection.check()
        guard cgWindowRows(pid: pid).contains(where: { $0.id == windowId }) else {
          throw HelperError("no_window", "the bound window closed; no further keys were posted")
        }
        try postChord(pid: pid, chord: chord)
        lastInputAt = Int64(Date().timeIntervalSince1970 * 1000)
        posted += 1
        usleep(30_000)
      }
    }
  }

  func backgroundType(pid: pid_t, windowId: Int, text: String) throws -> [String: Any] {
    var snapshot: [String: Any] = [:]
    var result = try backgroundInput(pid: pid, windowId: windowId, requested: text.count, unit: "characters") { protection, posted, lastInputAt in
      // Capture the field before cleanup restores the user's other main window. Reading the
      // app's focus afterwards could verify a different document that happens to end alike.
      snapshot = self.typeSnapshot(pid: pid)
      let deadline = ProcessInfo.processInfo.systemUptime + 10
      for character in text {
        try protection.check()
        guard ProcessInfo.processInfo.systemUptime < deadline else {
          throw HelperError("background_key_interrupted", "background typing reached its 10 second budget; read back the field before continuing")
        }
        try typeText(pid: pid, text: String(character))
        lastInputAt = Int64(Date().timeIntervalSince1970 * 1000)
        posted += 1
      }
    }
    result.merge(snapshot) { _, captured in captured }
    return result
  }

  private func waitForBackgroundState(_ protection: BackgroundKeyGuard, ready: () -> Bool) throws {
    let deadline = ProcessInfo.processInfo.systemUptime + 0.3
    while !ready() {
      try protection.check()
      guard ProcessInfo.processInfo.systemUptime < deadline else {
        throw HelperError("background_key_unsupported", "the app did not acknowledge background activation within 300 ms")
      }
      usleep(5000)
    }
  }

  private func backgroundInput(pid: pid_t, windowId: Int, requested: Int, unit: String,
                               deliver: (BackgroundKeyGuard, inout Int, inout Int64?) throws -> Void) throws -> [String: Any] {
    var posted = 0
    var lastInputAt: Int64?
    do {
      try requireTrusted()
      try requirePostEvents()
      guard !screenLocked(), let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
            front != pid else {
        throw HelperError("background_key_interrupted", "the app is no longer in the background; observe before retrying")
      }
      let picked = try pickWindow(pid: pid, windowId: windowId)
      guard picked.json["id"] as? Int == windowId,
            let row = cgWindowRows(pid: pid).first(where: { $0.id == windowId }) else {
        throw HelperError("no_window", "the pinned window is gone or off-screen; no shortcut was sent")
      }
      let children = (attr(picked.element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
      guard try panelService(pid: pid) == nil,
            !children.contains(where: { (attr($0, kAXRoleAttribute as String) as? String) == "AXSheet" }) else {
        throw HelperError("background_key_unsupported", "a panel or sheet is up; activate the app to send its shortcut, or use its fields and buttons by ref")
      }
      let originalMain = attr(appElement(pid), kAXMainWindowAttribute as String).flatMap { value -> AXUIElement? in
        CFGetTypeID(value) == AXUIElementGetTypeID() ? (value as! AXUIElement) : nil
      }
      let protection = BackgroundKeyGuard.shared
      try protection.start(pid: pid, front: front)
      backgroundCleanupLock.lock()
      backgroundCleanup = {
        // A user who brought the target forward owns its real activation now; do not undo that.
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
          if let originalMain, !CFEqual(originalMain, picked.element) {
            AXUIElementSetAttributeValue(originalMain, kAXMainAttribute as CFString, kCFBooleanTrue)
          }
          try? backgroundNotification(pid: pid, type: 21, subtype: 0x4000)
          try? backgroundNotification(pid: pid, type: 13, subtype: 2)
        }
        protection.repairForegroundFocus()
        protection.stop()
      }
      backgroundCleanupLock.unlock()
      defer { restoreBackgroundKeys() }

      try protection.check()
      try backgroundNotification(pid: pid, type: 13, subtype: 1, window: windowId,
                                 flags: NSEvent.ModifierFlags(rawValue: 0xc0000))
      // AXFrontmost reflects the app-local activation on AppKit. Poll when it is exposed;
      // an app without that attribute keeps the measured bounded settle.
      if attr(appElement(pid), kAXFrontmostAttribute as String) is Bool {
        try waitForBackgroundState(protection) { (self.attr(self.appElement(pid), kAXFrontmostAttribute as String) as? Bool) == true }
      } else { usleep(40_000) }
      try protection.check()
      let focusedBeforeClick = attr(appElement(pid), kAXFocusedWindowAttribute as String)
      let alreadyFocused = focusedBeforeClick.map { CFEqual($0, picked.element) } ?? false
      // Subtype 3 is an activation click, not a caret click. Stamping the window fields is what
      // makes it key inside the target without moving the real pointer or changing the selection.
      let point = CGPoint(x: row.frame.midX, y: row.frame.midY)
      for (type, number) in [(NSEvent.EventType.leftMouseDown, 1), (.leftMouseUp, 2)] {
        guard let event = NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
          timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: windowId, context: nil,
          eventNumber: number, clickCount: 1, pressure: 1)?.cgEvent else {
          throw HelperError("background_key_unsupported", "macOS could not build a window activation click")
        }
        event.flags = []
        event.location = point
        event.setIntegerValueField(.mouseEventSubtype, value: 3)
        event.setIntegerValueField(CGEventField(rawValue: 91)!, value: Int64(windowId))
        event.setIntegerValueField(CGEventField(rawValue: 92)!, value: Int64(windowId))
        event.postToPid(pid)
      }
      if alreadyFocused {
        // AXFocusedWindow can name the remembered window while it is not key. Equality with
        // the pre-click value cannot acknowledge this click, so retain its measured settle.
        usleep(60_000)
      } else {
        try waitForBackgroundState(protection) {
          self.attr(self.appElement(pid), kAXFocusedWindowAttribute as String).map { CFEqual($0, picked.element) } ?? false
        }
      }
      try protection.check()
      guard let focused = attr(appElement(pid), kAXFocusedWindowAttribute as String),
            CFGetTypeID(focused) == AXUIElementGetTypeID(), CFEqual(focused, picked.element) else {
        throw HelperError("background_key_unsupported", "the app did not give the pinned window keyboard focus; no shortcut was sent")
      }
      try deliver(protection, &posted, &lastInputAt)
      usleep(80_000)
      try protection.check()
      restoreBackgroundKeys()
      let cleanupDeadline = ProcessInfo.processInfo.systemUptime + 0.2
      while (attr(appElement(pid), kAXFrontmostAttribute as String) as? Bool) == true,
            ProcessInfo.processInfo.systemUptime < cleanupDeadline,
            NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
        usleep(5000)
      }
      let verified = (attr(appElement(pid), kAXFrontmostAttribute as String) as? Bool).map { !$0 }
      return ["posted": true, "postedCount": posted, "requestedCount": requested, "unit": unit,
              "cleanupVerified": verified as Any? ?? NSNull(), "lastInputAt": lastInputAt as Any? ?? NSNull()]
    } catch {
      let error = error as? HelperError ?? HelperError("ax_error", error.localizedDescription)
      throw HelperError(error.code, "\(posted) of \(requested) \(unit) were posted before interruption. \(error.message)",
                        ax: error.ax, postedCount: posted, requestedCount: requested)
    }
  }
}
