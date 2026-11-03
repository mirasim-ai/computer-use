// Apps and windows: what is running and the window server's view of a pid. The writes (launch /
// activate / quit) are in ax-lifecycle.swift.
//
// Apps are identified by BUNDLE ID, never by localized name: on a zh-CN machine Calculator is
// localized on a Chinese Mac, and so is Finder, so a name match works on the author's laptop and nowhere else.
import AppKit
import CoreGraphics
import CoreServices
import Foundation

/// The row shape every app listing hands back. Identity is the bundle id; `name` is display only.
///
/// `background` is `.prohibited` (LSBackgroundOnly): a process with no UI, which a NAMED lookup
/// can reach (see `liveApps`). It is a row, not an omission, so the client can refuse it in its
/// own words instead of answering "is not running" about a process that is.
func appRow(_ app: NSRunningApplication) -> [String: Any] {
  [
    "bundle": app.bundleIdentifier ?? "", "name": app.localizedName ?? "", "pid": Int(app.processIdentifier),
    "active": app.isActive, "hidden": app.isHidden,
    "background": app.activationPolicy == .prohibited,
    "webShell": isWebShell(app),
  ]
}

/// Does this app draw its interface with Chromium? Answered from the BUNDLE: an Electron app's
/// element may support neither `AXManualAccessibility` (-25205) nor `AXEnhancedUserInterface`
/// (-25208), yet publish its full tree later, once Chromium has built it (VS Code does the same).
///
/// It feeds the thin-window note: such an app has content not published YET, where a self-drawn
/// one never will — "act and read again" versus "stop reading, use the picture".
func isWebShell(_ app: NSRunningApplication) -> Bool {
  guard let url = app.bundleURL else { return false }
  let fm = FileManager.default
  for framework in ["Electron Framework.framework", "Chromium Embedded Framework.framework"] {
    if fm.fileExists(atPath: url.appendingPathComponent("Contents/Frameworks/\(framework)").path) { return true }
  }
  return false
}

/// The localized display name of an app bundle — the localized name on a Chinese Mac, not Calculator, matching what a RUNNING
/// row carries. A quit app has no process to ask, and every route the BUNDLE offers
/// (`FileManager.displayName`, `localizedInfoDictionary`, `.lproj` strings) answers English;
/// Spotlight's `kMDItemDisplayName` is the localized name and needs no permission.
/// `FileManager.displayName` is the fallback for a volume Spotlight has not indexed.
private func localizedAppName(_ url: URL) -> String {
  if let item = MDItemCreateWithURL(kCFAllocatorDefault, url as CFURL),
    let name = MDItemCopyAttribute(item, kMDItemDisplayName) as? String, !name.isEmpty {
    return (name as NSString).deletingPathExtension
  }
  return (FileManager.default.displayName(atPath: url.path) as NSString).deletingPathExtension
}

/// What the named bundles are, for the ones that are NOT running: an allowed app the user closed
/// is as nameable as a running one (`launch` starts it). A bundle nothing installs yields no row —
/// "not installed" is the absence, as in `lookup`.
func installedApps(bundles: [String]) -> [[String: Any]] {
  var out: [[String: Any]] = []
  var seen = Set<String>()
  for bundle in bundles where seen.insert(bundle).inserted {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { continue }
    out.append(["bundle": bundle, "name": localizedAppName(url)])
  }
  return out
}

/// The ONE live way to ask whether an app is running.
///
/// Never believe `NSWorkspace.shared.runningApplications` here: its updates are installed on the
/// thread that FIRST touches it, and this helper's work queue has no run loop, so the array
/// freezes for the life of a resident helper (launched apps never appear, quit ones never leave).
/// This class method asks LaunchServices per call.
///
/// `regularOnly` is for ENUMERATION only: a caller who NAMED a bundle (an allow-listed menu-bar
/// extra, the screen-capture toolbar) must not hear "is not running" about a process that is.
/// Unfiltered, `.prohibited` daemons come back too; `appRow`'s `background` flag lets the client
/// refuse them rather than spend the AX timeout on a process with no UI.
func liveApps(bundle: String, regularOnly: Bool = true) -> [NSRunningApplication] {
  NSRunningApplication.runningApplications(withBundleIdentifier: bundle)
    // LaunchServices also returns entries with no process (pid -1); binding one fails every read.
    .filter { $0.processIdentifier > 0 && (!regularOnly || $0.activationPolicy == .regular) }
}

/// `lookup {bundles?, pids?}` → rows for exactly the apps ASKED FOR, front-to-back, live.
///
/// The path a hosted session always takes: under an allow-list the helper never enumerates, so it
/// neither reads nor reports an app the user did not allow.
func lookupApps(bundles: [String], pids: [pid_t]) -> [[String: Any]] {
  var found: [NSRunningApplication] = []
  var seen = Set<pid_t>()
  for bundle in bundles {
    for app in liveApps(bundle: bundle, regularOnly: false) where seen.insert(app.processIdentifier).inserted { found.append(app) }
  }
  // `liveApp`, not the bare lookup: the caller named this pid, and an intermittent nil would
  // cost its whole target. An enumeration keeps the plain call: a miss there costs one row.
  for pid in pids where !seen.contains(pid) {
    guard let app = liveApp(pid) else { continue }
    seen.insert(pid)
    found.append(app)
  }
  return sortFrontToBack(found).map(appRow)
}

/// `apps` → every `.regular` app: the ones a user can see in the Dock and switch to, FRONT-TO-BACK
/// by their topmost window, so the caller's first candidate is the frontmost app even after it
/// skips the active one. Apps with no on-screen window come last.
///
/// Only the standalone CLI needs this. Built from the window server, which is live; the frozen
/// `runningApplications` array is used only as a list of BUNDLE IDS to re-ask via `liveApps`.
/// Residual: a window-less app launched after this helper started is not listed.
func runningApps() -> [[String: Any]] {
  var found: [NSRunningApplication] = []
  var seen = Set<pid_t>()
  for pid in windowOwnerOrder().sorted(by: { $0.value < $1.value }).map(\.key) {
    guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular,
      seen.insert(pid).inserted
    else { continue }
    found.append(app)
  }
  for bundle in Set(NSWorkspace.shared.runningApplications.compactMap(\.bundleIdentifier)) {
    for app in liveApps(bundle: bundle) where seen.insert(app.processIdentifier).inserted { found.append(app) }
  }
  return sortFrontToBack(found).map(appRow)
}

/// Front-to-back by topmost window; window-less apps keep their incoming order, last.
func sortFrontToBack(_ apps: [NSRunningApplication]) -> [NSRunningApplication] {
  let order = windowOwnerOrder()
  return apps.enumerated()
    .sorted { a, b in
      let (ra, rb) = (order[a.element.processIdentifier] ?? Int.max, order[b.element.processIdentifier] ?? Int.max)
      return ra != rb ? ra < rb : a.offset < b.offset
    }
    .map(\.element)
}

/// pid → rank in the window server's front-to-back list (layer-0, on-screen windows only).
func windowOwnerOrder() -> [pid_t: Int] {
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return [:] }
  var order: [pid_t: Int] = [:]
  for entry in raw {
    guard (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
      let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, order[pid] == nil
    else { continue }
    order[pid] = order.count
  }
  return order
}

/// Whether the screen is LOCKED — the state an unattended run sits in. Locking takes every window
/// off-screen at once: AX answers with zero frames and capture fails, until unlock.
/// `CGSSessionScreenIsLocked` is ABSENT while unlocked, so a missing key is "not locked".
///
/// Read per call (0.2 ms), never cached: the screen locks and unlocks under a resident helper.
func screenLocked() -> Bool {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue ?? false
}

/// Seconds since the HUMAN last touched this machine — what the mouse fallback asks before taking
/// the screen away from the user.
///
/// `.hidSystemState` is the HARDWARE source and stays clean of this helper's input: a key by
/// `postToPid` moves neither counter, and a session-tap MOUSE event resets only
/// `.combinedSessionState` (hence not that one). A session-tap KEY resets BOTH — why keys stay on
/// `postToPid` (ax-events.swift). Needs no grant and costs a syscall.
func humanIdleSeconds() -> Double {
  CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
}

/// What a "no window" refusal must carry when the screen is locked: the reason, in the message.
/// Empty while unlocked — there the window really is gone and the plain wording is the honest one.
func lockedSuffix() -> String {
  screenLocked()
    ? " — the screen is LOCKED, and macOS reports no windows while it is; they come back when the user unlocks it"
    : ""
}

/// The window server's on-screen, layer-0 windows of one pid — the rows that carry a CGWindowID,
/// front-to-back. AX has no id of its own, so its windows are paired with these rows one-to-one by
/// frame (`matchWindowIds`, `ax-window-match.swift`).
///
/// `panels` also takes the layers below the status level: a panel an app opens as its own window
/// sits above layer 0 (Chrome's "Ask where to save" for a background tab is at layer 8), and
/// without a row it has no id to target. A row only pairs with an AX window of the same frame, so
/// a tooltip or a menu never becomes a target.
func cgWindowRows(pid: pid_t, panels: Bool = false) -> [(id: Int, frame: CGRect)] {
  let top = panels ? Int(CGWindowLevelForKey(.statusWindow)) : 1
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return [] }
  return raw.compactMap { entry in
    guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
      let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue, layer >= 0, layer < top,
      let id = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue,
      let bounds = entry[kCGWindowBounds as String] as? [String: Any],
      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { return nil }
    return (id, frame)
  }
}

/// The frame a window json row describes (the `pickWindow` / `windows` shape).
func windowFrame(_ json: [String: Any]) -> CGRect {
  let d = { (k: String) -> CGFloat in CGFloat((json[k] as? NSNumber)?.doubleValue ?? 0) }
  return CGRect(x: d("x"), y: d("y"), width: d("w"), height: d("h"))
}

/// How a covering app is NAMED in a refusal: a bare pid is nothing the caller can act on; the
/// bundle id is, and the display name is what the user would call it.
func describeApp(_ pid: pid_t) -> String {
  guard let app = liveApp(pid) else { return "pid \(pid)" }
  let name = app.localizedName ?? ""
  let bundle = app.bundleIdentifier ?? ""
  if name.isEmpty && bundle.isEmpty { return "pid \(pid)" }
  if bundle.isEmpty { return "\(name) (pid \(pid))" }
  return name.isEmpty ? "\(bundle) (pid \(pid))" : "\(name) (\(bundle), pid \(pid))"
}

/// Who would receive a tap at `point` instead of `pid`, or nil when nobody would. The list is
/// front-to-back, so the first window containing the point decides.
///
/// A TARGET window at any layer means the point is the target's: its floating panels (the
/// screen-capture toolbar, a status-item popover) live above layer 0. For anyone else only layer 0
/// counts: the menu bar, the Dock and click-through overlays are not what "covered" means.
/// Residual: another app's floating panel that does take the click is not reported, since
/// `ignoresMouseEvents` is not in `CGWindowListCopyWindowInfo`.
func windowOwnerBlocking(_ point: CGPoint, target pid: pid_t) -> pid_t? {
  guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return nil }
  for entry in raw {
    guard ((entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
      let bounds = entry[kCGWindowBounds as String] as? [String: Any],
      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.contains(point),
      let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    else { continue }
    if owner == pid { return nil }
    if (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0 { return owner }
  }
  return nil
}

/// Would the user SEE something drawn at this point of this app's interface? Bare desktop means no.
func pointShowing(_ point: CGPoint, of pid: pid_t, margin: CGFloat = 0) -> Bool {
  guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
  else { return false }
  let area = CGRect(x: point.x - margin, y: point.y - margin, width: max(1, margin * 2), height: max(1, margin * 2))
  for window in windows {
    guard let owner = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
          owner != getpid(), // Our own click-through panel must not hide itself.
          ((window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary), frame.intersects(area)
    else { continue }
    // A decoration has no reason to cover another app's floating panel or menu either. Unlike
    // the input guard, every visible layer counts, and the WHOLE mark must fit the target.
    return owner == pid && frame.contains(area)
  }
  return false
}

/// Is this pid a live application, and what is its record?
///
/// `NSRunningApplication(processIdentifier:)` (a LaunchServices lookup) answers nil
/// INTERMITTENTLY for a long-running process, seconds apart in the same helper. Trusted alone it
/// costs the whole session: the client reads `no_app` as "the surface is gone" and drops its
/// target. So when it comes back empty the KERNEL is asked (`processAlive`): a gone pid answers at
/// once, a live one gets the lookup retried briefly.
func liveApp(_ pid: pid_t) -> NSRunningApplication? {
  // `NSWorkspace` keeps its own notification-fed array: a genuinely different second question.
  let byWorkspace = { NSWorkspace.shared.runningApplications.first { $0.processIdentifier == pid } }
  if let app = NSRunningApplication(processIdentifier: pid) ?? byWorkspace() { return app }
  guard processAlive(pid) else { return nil }
  // Alive, but no record: the fault itself, not reproducible on demand, so it LOGS — a real
  // occurrence decides whether 3 × 80 ms is enough. A non-app pid (`distnoted`) also lands here
  // and always pays 240 ms; read a run of these logs as that before the intermittent fault.
  log("pid \(pid) is alive but neither LaunchServices nor NSWorkspace lists it — retrying")
  for attempt in 0..<3 {
    usleep(80_000)
    if let app = NSRunningApplication(processIdentifier: pid) ?? byWorkspace() {
      log("pid \(pid) resolved after \((attempt + 1) * 80) ms")
      return app
    }
  }
  log("pid \(pid) still unresolved after 240 ms — reporting it as gone")
  return nil
}

/// Is this pid a live process? The kernel's own answer — EPERM means it exists and belongs to
/// someone else. "Is the app still there" asks THIS, never LaunchServices (see `liveApp`).
func processAlive(_ pid: pid_t) -> Bool {
  kill(pid, 0) == 0 || errno == EPERM
}

func runningApp(_ pid: pid_t) throws -> NSRunningApplication {
  guard let app = liveApp(pid) else {
    throw HelperError("no_app", "no running app with pid \(pid)")
  }
  return app
}
