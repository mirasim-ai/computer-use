// Pixels: one window, captured through ScreenCaptureKit while it may sit in the background.
//
// Window-scoped SCK capture (`SCContentFilter(desktopIndependentWindow:)`) photographs a window that
// is behind other windows, which a display grab cannot. Two limits are facts about the OS, not bugs
// here: a window on another Space or minimised cannot be captured at all (SCK refuses, -3811), and
// `SCShareableContent` has been seen hanging without an error. Each SCK call has a 4 s deadline;
// timeout falls back to a bounded capture of the same window, never a global daemon restart.
import AppKit
import Foundation
import ScreenCaptureKit

private final class ResultBox<T>: @unchecked Sendable {
  var result: Result<T, Error>?
}

/// Runs an async body from the synchronous work queue, with a hard deadline.
private func awaitSync<T>(_ what: String, timeout: TimeInterval, _ body: @escaping @Sendable () async throws -> T) throws -> T {
  let box = ResultBox<T>()
  let done = DispatchSemaphore(value: 0)
  let task = Task {
    do { box.result = .success(try await body()) } catch { box.result = .failure(error) }
    done.signal()
  }
  guard done.wait(timeout: .now() + timeout) == .success else {
    task.cancel()
    throw HelperError(
      "capture_timeout", "\(what) did not answer within \(Int(timeout)) s")
  }
  return try box.result!.get()
}

/// `shot {pid, window?, maxLongSide}` → `{png, id, x, y, w, h, scale}`; `id` is the CGWindowID that was
/// photographed and `scale` = window POINTS per image PIXEL, so a screen point is `window origin +
/// image px × scale`. `windowId` is the caller's pin (strict); `preferredId` is the window the tree
/// walk would pick, honoured when it is capturable so pixels and tree read the same window.
func shot(pid: pid_t, windowId: Int?, preferredId: Int?, maxLongSide: Int,
          expectedFrame: [String: Any]? = nil, mark: [String: Any]? = nil) throws -> [String: Any] {
  guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "window capture needs macOS 14 or newer") }
  let window = try shotWindow(pid: pid, windowId: windowId, preferredId: preferredId)
  let frame = window.frame
  try checkCaptureFrame(expectedFrame, frame)
  // Full-window screenshots retain one pixel per point as the point-action baseline.
  let pixelsPerPoint = min(1.0, Double(maxLongSide) / max(frame.width, frame.height))
  let config = SCStreamConfiguration()
  config.width = max(1, Int((frame.width * pixelsPerPoint).rounded()))
  config.height = max(1, Int((frame.height * pixelsPerPoint).rounded()))
  config.showsCursor = false
  config.ignoreShadowsSingleWindow = true
  let capture = try shotImage(window: window, configuration: config)
  let image = capture.image
  if expectedFrame != nil { try checkCaptureFrame(expectedFrame, liveDetailFrame(pid: pid, windowId: window.windowID)) }
  let scale = frame.width / Double(image.width)
  let marked = withPointerMark(image, frameOrigin: frame.origin, scale: scale, owner: pid, mark: mark)
  return [
    "png": try shotPNG(marked), "id": Int(window.windowID),
    "x": frame.origin.x, "y": frame.origin.y, "w": frame.width, "h": frame.height,
    "scale": scale,
    "captureBackend": capture.backend,
  ]
}

/// Resolve one capturable window, strictly honoring an explicit identity.
/// Gated in its signature, not its body: the helper ships for `-target …-macos11.0`,
/// where `SCWindow` in a signature does not compile at all.
@available(macOS 14.0, *)
func shotWindow(pid: pid_t, windowId: Int?, preferredId: Int?) throws -> ShotWindow {
  guard CGPreflightScreenCaptureAccess() else {
    throw HelperError(
      "not_granted_screen",
      "Screen Recording is not granted: enable it in System Settings → Privacy & Security → Screen Recording for the responsible app.")
  }
  _ = try runningApp(pid)
  let content: SCShareableContent
  do {
    content = try awaitSync("the window list", timeout: 4) {
      try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    }
  } catch let error as HelperError where error.code == "capture_timeout" {
    return try fallbackShotWindow(pid: pid, windowId: windowId, preferredId: preferredId)
  } catch { throw captureFailure(error, stage: "window-list") }
  // Three sort keys: Electron apps keep invisible placeholder windows with the real one's bounds,
  // so on-screen beats off-screen, titled beats untitled, then size. A requested id short-circuits.
  let candidates = content.windows
    .filter { $0.owningApplication?.processID == pid && $0.frame.width > 1 && $0.windowLayer == 0 }
    .sorted { a, b in
      if a.isOnScreen != b.isOnScreen { return a.isOnScreen }
      let (at, bt) = (!(a.title ?? "").isEmpty, !(b.title ?? "").isEmpty)
      if at != bt { return at }
      return a.frame.width * a.frame.height > b.frame.width * b.frame.height
    }
  let window: SCWindow
  if let windowId {
    guard let match = candidates.first(where: { Int($0.windowID) == windowId }) else {
      throw HelperError("no_window", "app \(pid) has no capturable window with id \(windowId)")
    }
    window = match
  } else if let preferredId, let match = candidates.first(where: { Int($0.windowID) == preferredId }) {
    window = match
  } else {
    guard let first = candidates.first else { throw HelperError("no_window", "app \(pid) has no capturable window") }
    window = first
  }

  return ShotWindow(windowID: window.windowID, pid: pid, frame: window.frame, isOnScreen: window.isOnScreen, screenKit: window)
}

/// Shared capture deadline and OS failure wording for full-window and detail captures.
@available(macOS 14.0, *)
func shotImage(window: ShotWindow, configuration: SCStreamConfiguration) throws -> (image: CGImage, backend: String) {
  guard let screenKit = window.screenKit else {
    return (try fallbackShotImage(window: window, width: configuration.width, height: configuration.height), "screencapture")
  }
  let filter = SCContentFilter(desktopIndependentWindow: screenKit)
  do {
    let image = try awaitSync("the window capture", timeout: 4) {
      try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
    }
    return (image, "screencapturekit")
  } catch let error as HelperError where error.code == "capture_timeout" {
    return (try fallbackShotImage(window: window, width: configuration.width, height: configuration.height), "screencapture")
  } catch let error as HelperError {
    throw error
  } catch {
    // The lock comes first: `isOnScreen` can read true under it, and the Space/minimised wording
    // would name the wrong reason. It reports THIS refusal only — a locked screen can still be
    // photographed from the backing store while the display is awake.
    if screenLocked() {
      throw HelperError(
        "no_window",
        "macOS refused to photograph this window while the screen is LOCKED; windows become readable again when the user unlocks it")
    }
    if !window.isOnScreen {
      throw HelperError(
        "no_window", "window \(window.windowID) is on another Space or minimised, and macOS cannot photograph it there")
    }
    throw captureFailure(error, stage: "window-image")
  }
}

func shotPNG(_ image: CGImage) throws -> String {
  guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
    throw HelperError("ax_error", "could not encode the capture as PNG")
  }
  return png.base64EncodedString()
}
