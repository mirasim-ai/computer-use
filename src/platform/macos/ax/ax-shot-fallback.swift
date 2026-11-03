// A bounded, window-pinned system capture when ScreenCaptureKit stops answering.
import AppKit
import Darwin
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
struct ShotWindow {
  let windowID: CGWindowID
  let pid: pid_t
  let frame: CGRect
  let isOnScreen: Bool
  let screenKit: SCWindow?

  var pixelScale: Double {
    if let screenKit { return max(1, Double(SCContentFilter(desktopIndependentWindow: screenKit).pointPixelScale)) }
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(UInt32(ids.count), &ids, &count) == .success else { return 1 }
    let display = ids.prefix(Int(count)).max { a, b in
      let ar = frame.intersection(CGDisplayBounds(a)), br = frame.intersection(CGDisplayBounds(b))
      return (ar.isNull ? 0 : ar.width * ar.height) < (br.isNull ? 0 : br.width * br.height)
    }
    guard let display, let mode = CGDisplayCopyDisplayMode(display), mode.width > 0 else { return 1 }
    return max(1, Double(mode.pixelWidth) / Double(mode.width))
  }
}

@available(macOS 14.0, *)
func fallbackShotWindow(pid: pid_t, windowId: Int?, preferredId: Int?) throws -> ShotWindow {
  let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
  let windows = rows.compactMap { row -> (ShotWindow, Bool)? in
    guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
          let id = (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
          let raw = row[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: raw as CFDictionary), frame.width > 1, frame.height > 1 else { return nil }
    return (ShotWindow(windowID: id, pid: pid, frame: frame,
      isOnScreen: (row[kCGWindowIsOnscreen as String] as? Bool) == true, screenKit: nil),
      !(row[kCGWindowName as String] as? String ?? "").isEmpty)
  }.sorted { a, b in
    if a.0.isOnScreen != b.0.isOnScreen { return a.0.isOnScreen }
    if a.1 != b.1 { return a.1 }
    return a.0.frame.width * a.0.frame.height > b.0.frame.width * b.0.frame.height
  }.map { $0.0 }
  if let id = windowId {
    guard let window = windows.first(where: { Int($0.windowID) == id }) else {
      throw HelperError("no_window", "app \(pid) has no window with id \(id)")
    }
    return window
  }
  if let id = preferredId, let window = windows.first(where: { Int($0.windowID) == id }) { return window }
  guard let window = windows.first else { throw HelperError("no_window", "app \(pid) has no capturable window") }
  return window
}

@available(macOS 14.0, *)
func fallbackShotImage(window: ShotWindow, width: Int, height: Int) throws -> CGImage {
  guard CGPreflightScreenCaptureAccess() else { throw HelperError("not_granted_screen", "Screen Recording is not granted") }
  let before = try fallbackShotWindow(pid: window.pid, windowId: Int(window.windowID), preferredId: nil)
  guard before.isOnScreen, before.frame == window.frame else {
    throw HelperError("no_window", "the bound window moved, resized or became hidden; observe it again before capturing")
  }
  guard before.frame.width * before.frame.height * before.pixelScale * before.pixelScale <= 33_554_432 else {
    throw HelperError("unsupported", "the window exceeds the 32-megapixel capture budget; resize it and retry")
  }
  let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mirasim-capture-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
  defer { try? FileManager.default.removeItem(at: directory) }
  let file = directory.appendingPathComponent("window.png")
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x", "-o", "-l", String(window.windowID), "-t", "png", file.path]
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  let done = DispatchSemaphore(value: 0)
  process.terminationHandler = { _ in done.signal() }
  try process.run()
  guard done.wait(timeout: .now() + 4) == .success else {
    if process.isRunning { process.terminate() }
    if done.wait(timeout: .now() + 0.25) == .timedOut, process.isRunning {
      kill(process.processIdentifier, SIGKILL)
      _ = done.wait(timeout: .now() + 0.25)
    }
    throw HelperError("capture_timeout", "both window capture paths timed out; Accessibility reads and actions remain available")
  }
  guard process.terminationStatus == 0,
        let data = try? Data(contentsOf: file),
        let bitmap = NSBitmapImageRep(data: data), let image = bitmap.cgImage else {
    throw HelperError("ax_error", "the system could not capture the bound window; no alternate window or display was captured")
  }
  let after = try fallbackShotWindow(pid: window.pid, windowId: Int(window.windowID), preferredId: nil)
  guard after.isOnScreen, after.frame == before.frame else {
    throw HelperError("no_window", "the bound window moved, resized or became hidden during capture; observe it again")
  }
  // Materialize a standalone bitmap before the temporary decoder/file goes away. Detail
  // capture crops this image later; it must not depend on the decoder's backing storage.
  guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw HelperError("ax_error", "the capture could not allocate its bounded image")
  }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  guard let scaled = context.makeImage() else { throw HelperError("ax_error", "the capture could not be resized") }
  return scaled
}
