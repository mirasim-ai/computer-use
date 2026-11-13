// computer-use-ax-helper — the native half of computer-use's macOS platform.
//
// One resident process, JSON lines in and out on stdio: `{"id":n,"op":"tree",...}` in,
// `{"id":n,"ok":true,"result":{...}}` or `{"id":n,"ok":false,"error":{code,message,ax?}}` out.
// Video workers also emit tagged `previewFrame` events; logs go to stderr. Exit on stdin EOF.
//
// Resident rather than one process per call because AX element handles are the whole state:
// a `tree` hands out keys (`k12`) that later `press`/`setvalue`/`focus` resolve back to the
// live AXUIElement, and the per-app messaging timeout has to be set once.
//
// Threading: stdin is read on its own thread, work runs on ONE serial queue (so pipelined
// requests are answered in order and AX round trips to one app never interleave), and the
// main thread parks on the run loop for NSWorkspace / ScreenCaptureKit callbacks.
//
// Rendering and diffing stay in computer-use's base class, not here.
import AppKit
import ApplicationServices
import Foundation

// MARK: - errors

/// The one error shape. `ax` carries the raw AXError only for `ax_error`, so the client can tell
/// "app not answering" (-25204) from "no such action" (-25206) without parsing prose.
struct HelperError: Error {
  let code: String
  let message: String
  let ax: Int32?
  let postedCount: Int?
  let requestedCount: Int?
  let capture: CaptureFailure?
  init(_ code: String, _ message: String, ax: Int32? = nil, postedCount: Int? = nil, requestedCount: Int? = nil, capture: CaptureFailure? = nil) {
    self.code = code
    self.message = message
    self.ax = ax
    self.postedCount = postedCount
    self.requestedCount = requestedCount
    self.capture = capture
  }
}

func notTrusted() -> HelperError {
  HelperError(
    "not_trusted",
    "Accessibility is not granted: enable it in System Settings → Privacy & Security → Accessibility. "
      + "The grant lands on the RESPONSIBLE app (the terminal or host that launched this helper), not on the helper itself.")
}

/// The guard every AX-reaching op shares. An op that forgets it MISDIAGNOSES rather than failing
/// loudly: an ungranted `press` answers `stale_key`, since the refused walk never filled the keys.
func requireTrusted() throws {
  guard AXIsProcessTrusted() else { throw notTrusted() }
}

/// Posting a CGEvent is its own capability, and an ungranted post is DISCARDED WITH NO ERROR, so
/// `key`/`type` would report typing that never happened. `CGPreflightPostEventAccess` is the exact
/// probe: true whenever Accessibility is granted, false without it.
func requirePostEvents() throws {
  guard CGPreflightPostEventAccess() else { throw notTrusted() }
}

/// Three failure modes stay distinguishable: the app has no such element (`no_element` / `stale_key`,
/// raised by the callers), the app is not answering AX (`ax_error` with -25204 and a message that says
/// so), and we were never authorised (`not_trusted`).
func axFailure(_ status: AXError, _ context: String) -> HelperError {
  switch status {
  case .apiDisabled:
    return notTrusted()
  case .cannotComplete:
    return HelperError(
      "ax_error", "\(context): the app did not answer Accessibility (timed out or does not support it)",
      ax: status.rawValue)
  case .invalidUIElement:
    return HelperError("ax_error", "\(context): that element no longer exists", ax: status.rawValue)
  case .attributeUnsupported, .actionUnsupported, .parameterizedAttributeUnsupported:
    return HelperError("ax_error", "\(context): the element does not support that", ax: status.rawValue)
  default:
    return HelperError("ax_error", "\(context): AXError \(status.rawValue)", ax: status.rawValue)
  }
}

// MARK: - request / response

struct Req {
  let id: Any
  let op: String
  let raw: [String: Any]

  func str(_ key: String) throws -> String {
    guard let v = raw[key] as? String else { throw HelperError("bad_request", "\(op) needs string \"\(key)\"") }
    return v
  }
  func int(_ key: String) throws -> Int {
    guard let v = raw[key] as? NSNumber else { throw HelperError("bad_request", "\(op) needs number \"\(key)\"") }
    return v.intValue
  }
  func int(_ key: String, _ fallback: Int) -> Int { (raw[key] as? NSNumber)?.intValue ?? fallback }
  func optInt(_ key: String) -> Int? { (raw[key] as? NSNumber)?.intValue }
  func dbl(_ key: String) throws -> Double {
    guard let v = raw[key] as? NSNumber else { throw HelperError("bad_request", "\(op) needs number \"\(key)\"") }
    return v.doubleValue
  }
  func dbl(_ key: String, _ fallback: Double) -> Double { (raw[key] as? NSNumber)?.doubleValue ?? fallback }
  func pid() throws -> pid_t { pid_t(try int("pid")) }
}

let stdoutLock = NSLock()

func emit(_ object: [String: Any]) {
  // `JSONSerialization` throws an NSException, which `try?` does not catch, for a value it cannot
  // write (AX's non-finite Doubles): the helper would die with SIGABRT. Values are sanitised at
  // the source (`jsonNumber`); this backstop turns an unwritable reply into an ERROR reply.
  guard JSONSerialization.isValidJSONObject(object) else {
    log("unserialisable reply for \(object["id"] ?? "?")")
    emit(["id": object["id"] ?? NSNull(), "ok": false,
          "error": ["code": "ax_error", "message": "the helper built a reply it could not serialise (a value outside JSON); this op is broken, the session is not"]])
    return
  }
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []) else {
    log("unserialisable reply for \(object["id"] ?? "?")")
    return
  }
  stdoutLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
  stdoutLock.unlock()
}

func log(_ text: String) {
  FileHandle.standardError.write(Data(("computer-use-ax-helper: " + text + "\n").utf8))
}

func fail(_ id: Any, _ error: Error) {
  let h = error as? HelperError ?? HelperError("ax_error", error.localizedDescription)
  var payload: [String: Any] = ["code": h.code, "message": h.message]
  if let ax = h.ax { payload["ax"] = Int(ax) }
  if let count = h.postedCount { payload["postedCount"] = count }
  if let count = h.requestedCount { payload["requestedCount"] = count }
  if let capture = h.capture { payload["capture"] = capture.json }
  emit(["id": id, "ok": false, "error": payload])
}

// MARK: - dispatch

let engine = AXEngine()

func handle(_ req: Req) throws -> [String: Any] {
  switch req.op {
  case "capabilities":
    // `postEvents` is not cosmetic: an ungranted post is discarded silently (`requirePostEvents`).
    return [
      "version": "1", "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(),
      "postEvents": CGPreflightPostEventAccess(),
      "pid": Int(ProcessInfo.processInfo.processIdentifier),
    ]
  case "apps": return ["apps": runningApps()]
  // A READ, not one of `ACT_OPS`: needs no grant, so an ungranted session still gets an answer.
  case "humanidle": return ["seconds": humanIdleSeconds()]
  // Which of these bundles EXIST, for the ones not running. LaunchServices: needs no grant.
  case "installed":
    return ["apps": installedApps(bundles: (req.raw["bundles"] as? [String]) ?? [])]
  case "lookup":
    return ["apps": lookupApps(
      bundles: (req.raw["bundles"] as? [String]) ?? [],
      pids: ((req.raw["pids"] as? [NSNumber]) ?? []).map { $0.int32Value })]
  // Both read channels carry `locked`, so an empty answer under a locked screen is never rendered
  // as "this app has no controls".
  case "windows": return ["windows": try engine.windows(pid: try req.pid()), "locked": screenLocked()]
  case "tree":
    // EVERY default here must equal the driver's constant in `ax-shapes.ts`, or a caller that
    // omits a parameter (a probe, a bench) walks a DIFFERENT tree than the product (a web app's
    // content can sit below depth 24). `macos-budgets.ts` pins the agreement.
    var tree = try engine.tree(
      pid: try req.pid(), windowId: req.optInt("window"), maxVisited: req.int("max", 8000),
      deadlineMs: req.int("deadlineMs", 1500),
      maxElements: req.int("maxElements", 300), maxOffscreen: req.int("maxOffscreen", 300),
      maxText: req.int("maxText", 2000),
      depth: req.int("depth", 64))
    tree["locked"] = screenLocked()
    return tree
  case "menu": return ["items": try engine.menu(pid: try req.pid())]
  case "selectall": return ["length": try engine.selectAll(pid: try req.pid(), key: req.raw["key"] as? String)]
  // The whole value of one element; the tree walk carries a preview and flags what it cut.
  case "value": return ["value": try engine.value(key: try req.str("key"))]
  case "textvalue": return ["value": try engine.textValue(key: try req.str("key")) as Any? ?? NSNull()]
  case "closewindow": try engine.closeWindow(pid: try req.pid(), windowId: req.optInt("window"))
  case "raisewindow": return try engine.raiseWindow(pid: try req.pid(), windowId: req.optInt("window"))
  case "at":
    return ["element": try engine.at(pid: try req.pid(), x: try req.dbl("x"), y: try req.dbl("y"))]
  case "press": try engine.press(key: try req.str("key"), action: (req.raw["action"] as? String) ?? "AXPress")
  // What the app itself says changed (ax-watch.swift): a mark before an action, the wait after it.
  case "watch":
    let pid = try req.pid()
    return try changeWatch.mark(
      pid: pid, appElement: engine.appElement(pid), quietMs: req.dbl("quietMs", 40), maxMs: req.dbl("maxMs", 300))
  case "settled":
    return try changeWatch.settled(
      pid: try req.pid(), mark: try req.int("mark"), firstMs: req.dbl("firstMs", 800),
      quietMs: req.dbl("quietMs", 150), maxMs: req.dbl("maxMs", 3000))
  // The rungs above the element itself: what CONTAINS it, and the one act a click means for a row.
  case "ancestors":
    return ["ancestors": try engine.ancestors(key: try req.str("key"), limit: req.int("limit", 5))]
  case "select": try engine.setSelected(key: try req.str("key"))
  case "setvalue": try engine.setValue(key: try req.str("key"), text: try req.str("text"))
  case "focused": return ["element": try engine.focusedElement(pid: try req.pid())]
  case "panelservice": return ["pid": Int(try engine.panelService(pid: try req.pid()) ?? 0)]
  case "clipboardstash":
    return ["stashed": engine.stashClipboard(text: try req.str("text"), html: req.raw["html"] as? String)]
  case "clipboardrestore": return ["restored": engine.restoreClipboard()]
  case "selectrange":
    try engine.selectRange(key: try req.str("key"), start: try req.int("start"), length: try req.int("length"))
  case "focus": return ["focused": try engine.focus(key: try req.str("key"))]
  case "key": try postChord(pid: try req.pid(), chord: try req.str("chord"))
  case "backgroundkey":
    return try engine.backgroundKey(pid: try req.pid(), windowId: try req.int("window"),
                                    chord: try req.str("chord"), count: req.int("count", 1))
  case "backgroundtype":
    return try engine.backgroundType(pid: try req.pid(), windowId: try req.int("window"), text: try req.str("text"))
  case "type":
    return try engine.typeInput(pid: try req.pid(), text: try req.str("text"))
  // The pointer-free rung: the area's own page action (@see ax-scroll.swift).
  case "scrollpage":
    return try engine.scrollPage(
      pid: try req.pid(), key: req.raw["key"] as? String, x: req.raw["x"] as? Double,
      y: req.raw["y"] as? Double, direction: (req.raw["direction"] as? String) ?? "down",
      pages: req.int("pages", 1))
  case "scroll":
    try scrollWheel(
      pid: try req.pid(), x: try req.dbl("x"), y: try req.dbl("y"), dy: try req.dbl("dy"), dx: req.dbl("dx", 0))
  case "mouse":
    try mouseClick(
      pid: try req.pid(), x: try req.dbl("x"), y: try req.dbl("y"),
      button: (req.raw["button"] as? String) ?? "left", count: req.int("count", 1))
  case "hover": try mouseHover(pid: try req.pid(), x: try req.dbl("x"), y: try req.dbl("y"))
  // The POINTER: moved along a path, pressed and released as separate acts (@see ax-pointer.swift).
  case "ptrmove":
    return try pointerMove(pid: try req.pid(), x: try req.dbl("x"), y: try req.dbl("y"), steps: req.optInt("steps"))
  case "ptrpress":
    return try pointerPress(pid: try req.pid(), button: (req.raw["button"] as? String) ?? "left")
  case "ptrrelease":
    return try pointerRelease(pid: try req.pid(), button: (req.raw["button"] as? String) ?? "left")
  case "ptrstate": return pointerState()
  case "drag":
    try mouseDrag(pid: try req.pid(), x: try req.dbl("x"), y: try req.dbl("y"), toX: try req.dbl("toX"), toY: try req.dbl("toY"))
  case "captureplan":
    return try prepareCapture(pid: try req.pid(), windowId: req.optInt("window"), engine: engine,
      scoped: (req.raw["scoped"] as? Bool) == true, region: req.raw["region"] as? [String: Any],
      key: req.raw["key"] as? String, padding: req.dbl("padding", 0), maxLongSide: req.int("maxLongSide", 1568))
  case "shot":
    let pid = try req.pid()
    return try shot(
      pid: pid, windowId: req.optInt("window"), preferredId: engine.defaultWindowId(pid: pid),
      maxLongSide: req.int("maxLongSide", 1568), expectedFrame: req.raw["expectedFrame"] as? [String: Any],
      mark: req.raw["mark"] as? [String: Any])
  case "previewstart":
    return try startWindowVideo(pid: try req.pid(), windowId: try req.int("window"), maxLongSide: req.int("maxLongSide", 2560), streamId: (req.raw["streamId"] as? String) ?? "default")
  case "shotscoped":
    return try scopedWindowShot(pid: try req.pid(), windowId: try req.int("window"), engine: engine,
                                region: req.raw["region"] as? [String: Any], key: req.raw["key"] as? String,
                                padding: req.dbl("padding", 0), expectedFrame: req.raw["expectedFrame"] as? [String: Any],
                                mark: req.raw["mark"] as? [String: Any])
  case "previewstop": stopWindowVideo(streamId: req.raw["streamId"] as? String)
  case "activate": try activate(pid: try req.pid())
  case "launch": return try launch(bundle: try req.str("bundle"))
  case "quit": try quit(pid: try req.pid())
  // Hidden: undo the Chromium/Electron nudge so an app stops paying for a full AX tree.
  case "unnudge": engine.setManualAccessibility(pid: try req.pid(), on: false)
  default:
    throw HelperError("unsupported", "unknown op \"\(req.op)\"")
  }
  return [:]
}

/// Serial: pipelined requests are answered in the order they arrived.
let workQueue = DispatchQueue(label: "mirasim-computer-use.ax.helper")

func readLoop() {
  var buffer = Data()
  while true {
    let chunk = FileHandle.standardInput.availableData
    if chunk.isEmpty { break }  // stdin closed: the host is gone.
    buffer.append(chunk)
    while let nl = buffer.firstIndex(of: 0x0A) {
      let line = buffer.subdata(in: buffer.startIndex..<nl)
      buffer.removeSubrange(buffer.startIndex...nl)
      guard !line.isEmpty else { continue }
      let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
      let id: Any = (obj?["id"] as? NSNumber) ?? NSNull()
      guard let obj, let op = obj["op"] as? String else {
        workQueue.async { fail(id, HelperError("bad_request", "each line must be a JSON object with \"id\" and \"op\"")) }
        continue
      }
      let req = Req(id: id, op: op, raw: obj)
      // One autorelease pool PER REQUEST: a dispatch queue makes no guarantee about when its own
      // pool drains, and every op returns autoreleased CF/AX objects, so the footprint would climb
      // ~33K a tree walk while `leaks` reports nothing.
      workQueue.async {
        autoreleasepool {
          // Bracketed for ax-watch.swift: a change the app posts while nothing here is running is
          // the app's own, not an effect of a request.
          changeWatch.workBegan()
          defer { changeWatch.workEnded() }
          do { emit(["id": req.id, "ok": true, "result": try handle(req)]) } catch { fail(req.id, error) }
        }
      }
    }
  }
  // Drain (an in-flight action is not cut in half), then undo the Chromium nudges: the flag would
  // otherwise outlive this process in the user's own apps.
  workQueue.sync { stopWindowVideo(); engine.unnudgeAll() }
  exit(0)
}

// The mouse must never be left cut off from its cursor (@see ax-pointer.swift's GRAB section).
// `atexit` and the signal handlers cover teardown mid-press. SIGKILL cannot be caught, so every
// start re-associates the mouse: a no-op when nothing broke.
if ProcessInfo.processInfo.environment["COMPUTER_USE_PREVIEW_WORKER"] != "1" {
  _ = CGAssociateMouseAndMouseCursorPosition(1)
}

var signalSources: [DispatchSourceSignal] = []
atexit { ungrabMouse() }
for sig in [SIGTERM, SIGINT, SIGHUP] {
  signal(sig, SIG_IGN)
  let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
  src.setEventHandler {
    restoreBackgroundKeys()
    ungrabMouse()
    workQueue.sync { stopWindowVideo(); engine.unnudgeAll() }
    exit(0)
  }
  src.resume()
  signalSources.append(src)
}

Thread.detachNewThread { readLoop() }
RunLoop.main.run()
