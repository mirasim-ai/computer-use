// CHANGE NOTIFICATIONS: the app's own account of when its UI changed, heard through an AXObserver.
//
// Why this exists: an accepted AXPress says nothing about its effect, and re-reading the window to
// compare is a SAMPLE of what the window lists. Two things escape a sample: an effect outside the
// window's frame (a list that grows past its edge reads the same however long it is watched), and
// timing (a read taken while a sheet is still being built). A notification is the app saying "I am
// changing now": a second witness for the first, and for the second the cue to read once the app
// has gone quiet.
//
// What it is NOT: evidence of WHAT changed, or that the change was the one intended. The caller
// still reads the tree. It also has to be heard with care: READING a lazily built list makes the
// app post notifications of its own (System Settings does, on every walk), so the caller marks
// only once the app is quiet and counts only what it hears before its next read. And silence is no
// verdict: web content and some toolkits post nothing, so the caller falls back to comparing walks.
//
// Threading: the observer's run-loop source sits on the MAIN run loop (parked in `main.swift` for
// exactly this kind of callback), so events arrive while the serial work queue is blocked inside
// `settled`. Everything shared is under one NSCondition.
import ApplicationServices
import Foundation

/// The notifications that mean "the UI changed". A FOCUS move is heard too but tallied apart: a
/// press moves the focus onto its control even when the app ignores the press, so it proves nothing.
private let CHANGE_NOTIFICATIONS: [String] = [
  "AXCreated", REMOVED_NOTIFICATION, "AXValueChanged", "AXTitleChanged", "AXLayoutChanged",
  "AXWindowCreated", "AXSheetCreated", "AXDrawerCreated", "AXMainWindowChanged", "AXFocusedWindowChanged",
  "AXSelectedChildrenChanged", "AXSelectedRowsChanged", "AXSelectedCellsChanged", "AXRowCountChanged",
  "AXRowExpanded", "AXRowCollapsed", "AXMenuOpened", "AXMenuClosed", "AXResized", "AXMoved",
  "AXElementBusyChanged",
]
private let FOCUS_NOTIFICATION = "AXFocusedUIElementChanged"
/// Heard, and it keeps the wait going, but it is no witness either: READING a lazily built list
/// makes the app build rows and throw them away again, so a walk alone produces a burst of these
/// (measured on System Settings: 18 per read, and nothing else).
private let REMOVED_NOTIFICATION = "AXUIElementDestroyed"
private func isWitness(_ name: String) -> Bool { name != FOCUS_NOTIFICATION && name != REMOVED_NOTIFICATION }

/// One heard notification: its place in the pid's stream, when, and which.
private struct Heard {
  let seq: Int
  let at: TimeInterval
  let name: String
}

/// One app's observer and what it has heard. The log is a bounded tail: a caller only ever asks
/// about what came after a mark it took moments ago.
private final class AppWatch {
  let observer: AXObserver
  var log: [Heard] = []
  var seq = 0
  /// How many notifications the app let us register for; 0 would be a watch that can hear nothing.
  var registered = 0
  /// How many witness notifications this app has ever posted while watched. Zero means its
  /// silence is not known to mean anything (web content never speaks).
  var spoken = 0
  /// What the quiet wait of a mark measures from while nothing has been heard yet.
  let since: TimeInterval
  init(observer: AXObserver, since: TimeInterval) { self.observer = observer; self.since = since }
}

private let HEARD_KEEP = 2048

final class ChangeWatch {
  private let cond = NSCondition()
  private var apps: [pid_t: AppWatch] = [:]

  private func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

  /// The C callback carries no context of its own, so the pid rides in `refcon`.
  private static let callback: AXObserverCallback = { _, _, notification, refcon in
    let pid = pid_t(Int(bitPattern: refcon))
    changeWatch.heard(pid: pid, name: notification as String)
  }

  fileprivate func heard(pid: pid_t, name: String) {
    cond.lock()
    if let app = apps[pid] {
      app.seq += 1
      app.log.append(Heard(seq: app.seq, at: now(), name: name))
      if isWitness(name) { app.spoken += 1 }
      if app.log.count > HEARD_KEEP { app.log.removeFirst(app.log.count - HEARD_KEEP / 2) }
      cond.broadcast()
    }
    cond.unlock()
  }

  /// Observers of apps that have quit: their run-loop source is dead weight on the main loop.
  private func dropDead() {
    for (pid, app) in apps where !processAlive(pid) {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(app.observer), .defaultMode)
      apps[pid] = nil
    }
  }

  /// `watch {pid, quietMs, maxMs}`: start listening to this app (once per pid) and answer the MARK —
  /// the place in its stream that everything heard from now on comes after. Taken BEFORE the action
  /// it brackets, and only once the app has been quiet for `quietMs`.
  ///
  /// The quiet wait is what keeps the caller's own READ out of the answer: walking a lazily built
  /// list makes the app post value changes of its own (System Settings does, on every read), and
  /// they are still arriving when the walk returns. An app that will not go quiet within `maxMs`
  /// is talking on its own (a clock, a streaming view) and answers `quiet: false`: nothing it says
  /// next can be pinned on the caller's action.
  func mark(pid: pid_t, appElement: AXUIElement, quietMs: Double, maxMs: Double) throws -> [String: Any] {
    try requireTrusted()
    cond.lock()
    dropDead()
    if let app = apps[pid] {
      defer { cond.unlock() }
      let start = now()
      var quiet = true
      while true {
        let last = app.log.last(where: { $0.name != FOCUS_NOTIFICATION })?.at ?? app.since
        let quietAt = last + quietMs / 1000
        let t = now()
        if t >= quietAt { break }
        if t >= start + maxMs / 1000 { quiet = false; break }
        cond.wait(until: Date(timeIntervalSinceNow: min(quietAt, start + maxMs / 1000) - t))
      }
      return [
        "mark": app.seq, "registered": app.registered, "quiet": quiet, "spoken": app.spoken,
        "waitedMs": Int((now() - start) * 1000),
      ]
    }
    cond.unlock()
    var made: AXObserver?
    let status = AXObserverCreate(pid, ChangeWatch.callback, &made)
    guard status == .success, let observer = made else { throw axFailure(status, "watch") }
    let refcon = UnsafeMutableRawPointer(bitPattern: Int(pid))
    var registered = 0
    for name in CHANGE_NOTIFICATIONS + [FOCUS_NOTIFICATION] {
      // Registered on the APPLICATION element, which hears its whole tree. An app that does not
      // support one of these refuses it alone; the rest still register.
      if AXObserverAddNotification(observer, appElement, name as CFString, refcon) == .success { registered += 1 }
    }
    guard registered > 0 else {
      throw HelperError("ax_error", "watch: the app accepted none of the change notifications")
    }
    // `since` is set back by the quiet period: nothing was being heard until now, so the first
    // mark has no silence to wait out (what a read stirred up before it was never heard at all).
    let app = AppWatch(observer: observer, since: now() - quietMs / 1000)
    app.registered = registered
    cond.lock()
    apps[pid] = app
    cond.unlock()
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    return ["mark": 0, "registered": registered, "quiet": true, "spoken": 0, "waitedMs": 0]
  }

  /// `settled {pid, mark, firstMs, quietMs, maxMs}`: wait for the app to SAY it changed, then for it
  /// to stop saying so.
  ///
  /// Two phases, both with early exit: up to `firstMs` for the first change notification after
  /// `mark` (none: answer at once with `changes: 0`, the caller's cue to compare walks instead);
  /// then until `quietMs` pass with nothing new, capped at `maxMs` from the call (an app that never
  /// stops talking — a ticking clock, a streaming view — answers `quiet: false` at the cap).
  func settled(pid: pid_t, mark: Int, firstMs: Double, quietMs: Double, maxMs: Double) throws -> [String: Any] {
    cond.lock()
    defer { cond.unlock() }
    guard let app = apps[pid] else { throw HelperError("bad_request", "settled: no watch on pid \(pid); call watch first") }
    let start = now()
    // Anything but a focus move starts and prolongs the wait, a removal included: the app is busy.
    func busyAfterMark() -> Bool { app.log.contains { $0.seq > mark && $0.name != FOCUS_NOTIFICATION } }
    let firstDeadline = start + firstMs / 1000
    while !busyAfterMark() {
      let left = firstDeadline - now()
      if left <= 0 { break }
      cond.wait(until: Date(timeIntervalSinceNow: left))
    }
    var quiet = true
    if busyAfterMark() {
      let cap = start + maxMs / 1000
      while true {
        let last = app.log.last(where: { $0.seq > mark && $0.name != FOCUS_NOTIFICATION })?.at ?? start
        let quietAt = last + quietMs / 1000
        let t = now()
        if t >= quietAt { break }
        if t >= cap { quiet = false; break }
        cond.wait(until: Date(timeIntervalSinceNow: min(quietAt, cap) - t))
      }
    }
    let after = app.log.filter { $0.seq > mark }
    let changes = after.filter { isWitness($0.name) }
    var kinds: [String: Int] = [:]
    for h in changes { kinds[h.name, default: 0] += 1 }
    var answer: [String: Any] = [
      "changes": changes.count,
      "removed": after.filter { $0.name == REMOVED_NOTIFICATION }.count,
      "focus": after.filter { $0.name == FOCUS_NOTIFICATION }.count,
      "kinds": kinds,
      "quiet": quiet,
      "waitedMs": Int((now() - start) * 1000),
      // The place in the stream this answer covers up to: the mark for a follow-up `settled`.
      "mark": after.last?.seq ?? mark,
    ]
    // Offsets from the start of THIS call: how long after the action the app first and last spoke.
    if let first = changes.first, let last = changes.last {
      answer["firstMs"] = Int((first.at - start) * 1000)
      answer["lastMs"] = Int((last.at - start) * 1000)
      // The longest silence INSIDE what was heard: what a quiet period has to outlast.
      let busy = after.filter { $0.name != FOCUS_NOTIFICATION }
      answer["maxGapMs"] = Int((zip(busy.dropFirst(), busy).map { $0.at - $1.at }.max() ?? 0) * 1000)
    }
    return answer
  }
}

let changeWatch = ChangeWatch()
