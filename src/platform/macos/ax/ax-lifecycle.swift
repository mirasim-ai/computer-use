// App LIFECYCLE: bringing one forward, starting one, and stopping one — the three ops that change
// which apps are running rather than reading what is.
//
// ax-apps.swift holds every READ about apps and their windows; these are the writes, the ops with
// a cost to the USER.
import AppKit
import ApplicationServices
import Foundation

/// `activate {pid}`: brings every window of the app forward. AppKit work, so it runs on the main thread.
func activate(pid: pid_t) throws {
  let app = try runningApp(pid)
  let ok = DispatchQueue.main.sync { app.activate(options: [.activateAllWindows]) }
  if !ok { log("activate(\(pid)) returned false") }
}

/// `launch {bundle}` → `{app, ready}`: the app's own row, and whether it answers Accessibility
/// (`waitDrivable`). Opens the bundle WITHOUT activating it (the human keeps their focused
/// window) and waits ≤ 10 s for a process. Opening an already-running app is harmless, and makes a
/// document app with every window closed produce one again.
///
/// Answers with the whole row so the caller does NOT look it up again: this handle is live by
/// construction, and a lookup can miss a just-launched app.
func launch(bundle: String) throws -> [String: Any] {
  guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else {
    throw HelperError("no_app", "no installed application with bundle id \"\(bundle)\"")
  }
  // Asked BEFORE the open: afterwards a found app and a started one are indistinguishable. Whether
  // the process is ours or the user's decides what the caller may do to its windows.
  let started = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty
  let config = NSWorkspace.OpenConfiguration()
  config.activates = false
  config.addsToRecentItems = false
  final class Box: @unchecked Sendable {
    var app: NSRunningApplication?
    var error: Error?
  }
  let box = Box()
  let done = DispatchSemaphore(value: 0)
  NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
    box.app = app
    box.error = error
    done.signal()
  }
  guard done.wait(timeout: .now() + 10) == .success else {
    throw HelperError("no_app", "\"\(bundle)\" did not finish launching within 10 s")
  }
  if let error = box.error { throw HelperError("no_app", "launching \"\(bundle)\" failed: \(error.localizedDescription)") }
  guard let app = box.app else { throw HelperError("no_app", "\"\(bundle)\" reported no process") }
  let ready = waitDrivable(app)
  let wins = windowCount(app)
  return ["app": appRow(app), "ready": ready, "started": started, "windows": wins.count, "panel": wins.panelOnly]
}

/// How many windows the app has, and whether they are all Open/Save PANELS.
///
/// `waitDrivable` answers true for an app with NO window, so the count stops the caller promising a
/// window that is not there; the panel flag says the window there is not the app's own. A panel is
/// recognised as in `insideRemotePanel` (`AXIdentifier` ending in `-panel`); its SUBROLE is
/// `AXStandardWindow` like a document window's.
private func windowCount(_ app: NSRunningApplication) -> (count: Int, panelOnly: Bool) {
  let el = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(el, AX_TIMEOUT)
  var out: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &out) == .success,
    let wins = out as? [AXUIElement], !wins.isEmpty else { return (0, false) }
  let panels = wins.filter { w in
    var id: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w, "AXIdentifier" as CFString, &id) == .success else { return false }
    return ((id as? String) ?? "").hasSuffix("-panel")
  }
  return (wins.count, panels.count == wins.count)
}

/// How long a cold launch may take to become drivable, and how much longer to wait for a window
/// once Accessibility starts answering.
private let LAUNCH_READY_TIMEOUT: TimeInterval = 5
private let LAUNCH_WINDOW_GRACE: TimeInterval = 1

/// Wait until the app just opened can actually be DRIVEN, and say whether it got there.
///
/// `openApplication`'s callback fires when the process exists (~0.08 s), not when AX answers
/// (~0.5 s); an observation in that gap fails with -25204 for a launch that succeeded.
/// `isFinishedLaunching` is NOT the signal: it may never become true. The question is whether AX
/// answers.
func waitDrivable(_ app: NSRunningApplication) -> Bool {
  let el = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(el, AX_TIMEOUT)
  let start = Date()
  var answeredAt: Date?
  while Date().timeIntervalSince(start) < LAUNCH_READY_TIMEOUT {
    var out: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(el, kAXWindowsAttribute as CFString, &out)
    // Never granted: waiting cannot change that, and the caller's next call reports it properly.
    if status == .apiDisabled { return false }
    if status != .cannotComplete {
      if (out as? [AXUIElement])?.isEmpty == false { return true }
      // Answering but window-less is a real state: give a window a moment, then stop.
      let since = answeredAt ?? Date()
      answeredAt = since
      if Date().timeIntervalSince(since) >= LAUNCH_WINDOW_GRACE { return true }
    }
    usleep(50_000)
  }
  return false
}

/// `quit {pid}`: the polite Quit Apple Event, as ⌘Q would. Returns "sent", not "gone": unsaved
/// changes can object, and delivery is gated by TCC Automation. Never escalated to a kill.
func quit(pid: pid_t) throws {
  let app = try runningApp(pid)
  if !app.terminate() { log("terminate(\(pid)) returned false") }
}
