// A read-only window video stream. Runs in a separate helper from GUI input and AX walks.
import AppKit
import CoreImage
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 14.0, *)
// Frame state is confined to `queue`; the cross-thread stop and stream handle use `stateLock`.
private final class WindowVideo: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let streamId: String
  init(streamId: String) { self.streamId = streamId; super.init() }
  private func publish(_ value: [String: Any]) { emit(value.merging(["streamId": streamId]) { _, next in next }) }
  private func publishFailure(_ error: Error, stage: String) {
    let failure = captureFailure(error, stage: stage)
    var event: [String: Any] = ["event": "previewError", "message": failure.message, "code": failure.code]
    if let capture = failure.capture { event["capture"] = capture.json }
    publish(event)
  }

  private let context = CIContext(options: [.cacheIntermediates: false])
  private let queue = DispatchQueue(label: "mirasim-computer-use.preview.video")
  private var stream: SCStream?
  private let stateLock = NSLock()
  private var width = 0.0
  private var height = 0.0
  private var stopped = false
  private var windowId: CGWindowID = 0
  private var maxLongSide = 2560
  private var pixelsPerPoint = 1.0
  private var checkingSizeAt = 0.0
  private var changingSize = false
  private var unavailable = false

  private var isStopped: Bool {
    stateLock.lock(); defer { stateLock.unlock() }
    return stopped
  }

  private func configuration(width: Double, height: Double) -> SCStreamConfiguration {
    // Capture the window's backing pixels; frame metadata stays in points for the pointer.
    let scale = min(pixelsPerPoint, Double(maxLongSide) / max(width, height))
    let configuration = SCStreamConfiguration()
    configuration.width = max(1, Int(width * scale))
    configuration.height = max(1, Int(height * scale))
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 10)
    configuration.queueDepth = 3
    configuration.showsCursor = false
    configuration.capturesAudio = false
    configuration.ignoreShadowsSingleWindow = true
    if #available(macOS 14.2, *) { configuration.includeChildWindows = true }
    return configuration
  }

  private func install(_ stream: SCStream) -> Bool {
    stateLock.lock(); defer { stateLock.unlock() }
    guard !stopped else { return false }
    self.stream = stream
    return true
  }

  func start(pid: pid_t, windowId: Int, maxLongSide: Int) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
      throw HelperError("not_granted_screen", "Screen Recording permission is required to preview this application.")
    }
    let content: SCShareableContent
    do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
    catch { throw captureFailure(error, stage: "preview-window-list") }
    guard !isStopped else { throw HelperError("unsupported", "Application capture was cancelled.") }
    guard let window = content.windows.first(where: {
      $0.owningApplication?.processID == pid && Int($0.windowID) == windowId
    }) else { throw HelperError("no_window", "The application window is no longer available.") }
    guard window.frame.width > 0 && window.frame.height > 0 else {
      throw HelperError("no_window", "The application window cannot be captured here.")
    }
    width = window.frame.width
    height = window.frame.height
    self.windowId = CGWindowID(windowId)
    self.maxLongSide = maxLongSide
    let filter = SCContentFilter(desktopIndependentWindow: window)
    pixelsPerPoint = max(1.0, Double(filter.pointPixelScale))
    let stream = SCStream(filter: filter,
                          configuration: configuration(width: width, height: height), delegate: self)
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
    guard install(stream) else { throw HelperError("unsupported", "Application capture was cancelled.") }
    do { try await stream.startCapture() }
    catch { throw captureFailure(error, stage: "preview-start") }
    if isStopped {
      try? await stream.stopCapture()
      throw HelperError("unsupported", "Application capture was cancelled.")
    }
    var result: [String: Any] = ["w": window.frame.width, "h": window.frame.height]
    if let icon = NSRunningApplication(processIdentifier: pid)?.icon,
       let tiff = icon.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
       let png = bitmap.representation(using: .png, properties: [:]) {
      result["icon"] = "data:image/png;base64,\(png.base64EncodedString())"
    }
    return result
  }

  func stop() {
    stateLock.lock()
    stopped = true
    let stream = self.stream
    self.stream = nil
    stateLock.unlock()
    if let stream { Task { try? await stream.stopCapture() } }
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard !isStopped, !changingSize, type == .screen, sampleBuffer.isValid,
          let buffer = sampleBuffer.imageBuffer else { return }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
       let status = attachments.first?[.status] as? Int,
       status != SCFrameStatus.complete.rawValue {
      if status == SCFrameStatus.blank.rawValue || status == SCFrameStatus.suspended.rawValue || status == SCFrameStatus.stopped.rawValue {
        if !unavailable {
          unavailable = true
          publish(["event": "previewUnavailable", "message": "The window is not visible to macOS capture. Restore it or unlock the Mac to resume."])
        }
      }
      return
    }
    unavailable = false
    // A user may resize the real window while watching it. Reconfigure the video size
    // without rebuilding the stream or emitting frames with mismatched pointer geometry.
    let now = ProcessInfo.processInfo.systemUptime
    if now - checkingSizeAt > 0.5 {
      checkingSizeAt = now
      if let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowId) as? [[String: Any]],
         let raw = rows.first?[kCGWindowBounds as String] as? [String: Any],
         let rect = CGRect(dictionaryRepresentation: raw as CFDictionary), rect.width > 0, rect.height > 0,
         (abs(rect.width - width) > 1 || abs(rect.height - height) > 1) {
        changingSize = true
        let next = configuration(width: rect.width, height: rect.height)
        Task {
          do {
            try await stream.updateConfiguration(next)
            queue.async { self.width = rect.width; self.height = rect.height; self.changingSize = false }
          } catch {
            queue.async { self.changingSize = false }
            if !isStopped { publishFailure(error, stage: "preview-update") }
          }
        }
        return
      }
    }
    autoreleasepool {
      let input = CIImage(cvPixelBuffer: buffer)
      guard let image = context.createCGImage(input, from: input.extent),
            let jpeg = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.9]) else { return }
      publish(["event": "previewFrame", "data": jpeg.base64EncodedString(), "w": width, "h": height,
            "capturedAt": Date().timeIntervalSince1970 * 1000])
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    guard !isStopped else { return }
    publishFailure(error, stage: "preview-stream")
  }
}

private var videos = [String: AnyObject]()
private final class VideoResult: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Result<[String: Any], Error>?
  func set(_ value: Result<[String: Any], Error>) { lock.lock(); self.value = value; lock.unlock() }
  func get() throws -> [String: Any] { lock.lock(); defer { lock.unlock() }; return try value!.get() }
}

func startWindowVideo(pid: pid_t, windowId: Int, maxLongSide: Int, streamId: String = "default") throws -> [String: Any] {
  guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "Application preview requires macOS 14 or newer.") }
  stopWindowVideo(streamId: streamId)
  let capture = WindowVideo(streamId: streamId)
  videos[streamId] = capture
  let done = DispatchSemaphore(value: 0)
  let result = VideoResult()
  Task {
    do { result.set(.success(try await capture.start(pid: pid, windowId: windowId, maxLongSide: maxLongSide))) }
    catch { result.set(.failure(error)) }
    done.signal()
  }
  guard done.wait(timeout: .now() + 8) == .success else {
    stopWindowVideo(streamId: streamId)
    throw HelperError("unsupported", "The window capture service did not respond. Reopen the application and retry.")
  }
  do { return try result.get() }
  catch { stopWindowVideo(streamId: streamId); throw error }
}

func stopWindowVideo(streamId: String? = nil) {
  if #available(macOS 14.0, *) {
    if let streamId { (videos.removeValue(forKey: streamId) as? WindowVideo)?.stop() }
    else { for capture in videos.values { (capture as? WindowVideo)?.stop() }; videos.removeAll() }
  }
}
