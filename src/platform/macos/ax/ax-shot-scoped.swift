// Native-resolution window detail. Crop the input before applying the output pixel budget.
import AppKit
import ApplicationServices
import Foundation
import ScreenCaptureKit

private let detailMaxPixels = 4_194_304.0
private let detailMaxLongSide = 4096.0
private let detailSourceMaxPixels = 33_554_432.0

func liveDetailFrame(pid: pid_t, windowId: CGWindowID) throws -> CGRect {
  let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowId) as? [[String: Any]]
  guard let row = rows?.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowId }),
        (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
        (row[kCGWindowIsOnscreen as String] as? Bool) == true,
        let raw = row[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else {
    throw HelperError("no_window", "the bound window is no longer visible to capture; observe or restore the intended window")
  }
  return rect
}

func detailRegion(_ raw: [String: Any]) throws -> CGRect {
  let names = ["x", "y", "width", "height"]
  let values = names.compactMap { (raw[$0] as? NSNumber)?.doubleValue }
  guard values.count == 4, values.allSatisfy({ $0.isFinite }), values[2] > 0, values[3] > 0,
        (values[0] + values[2]).isFinite, (values[1] + values[3]).isFinite else {
    throw HelperError("bad_request", "region needs finite x/y and positive width/height")
  }
  return CGRect(x: values[0], y: values[1], width: values[2], height: values[3])
}

func detailElement(engine: AXEngine, pid: pid_t, windowId: Int, key: String) throws -> CGRect {
  try requireTrusted()
  guard engine.keysByPid[pid]?.contains(key) == true, let element = engine.keys[key] else {
    throw HelperError("stale_key", "the scoped screenshot's element is not in the latest observation")
  }
  let selected = try engine.pickWindow(pid: pid, windowId: windowId)
  let owner = engine.attr(element, kAXWindowAttribute as String)
  guard CFEqual(element, selected.element) || (owner != nil && CFEqual(owner, selected.element)) else {
    throw HelperError("no_element", "the element does not identify the bound window; use a visible ref or a region")
  }
  let rect = engine.read(element, contentActions: false).frame
  guard rect.origin.x.isFinite, rect.origin.y.isFinite, rect.width.isFinite, rect.height.isFinite,
        rect.width > 0, rect.height > 0 else {
    throw HelperError("no_element", "the element has no capturable bounds; use a visible ref or a region")
  }
  return rect
}

func scopedWindowShot(pid: pid_t, windowId: Int, engine: AXEngine,
                      region: [String: Any]?, key: String?, padding: Double,
                      expectedFrame: [String: Any]? = nil, mark: [String: Any]? = nil) throws -> [String: Any] {
  guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "window capture needs macOS 14 or newer") }
  guard (region != nil) != (key != nil), padding.isFinite, padding >= 0, key != nil || padding == 0 else {
    throw HelperError("bad_request", "choose region or element key, with finite nonnegative padding for an element only")
  }
  let window = try shotWindow(pid: pid, windowId: windowId, preferredId: nil)
  let frame = window.frame
  try checkCaptureFrame(expectedFrame, frame)
  _ = try liveDetailFrame(pid: pid, windowId: window.windowID)
  let requested: CGRect
  if let key {
    let rect = try detailElement(engine: engine, pid: pid, windowId: windowId, key: key)
    requested = rect.offsetBy(dx: -frame.minX, dy: -frame.minY).insetBy(dx: -padding, dy: -padding)
  } else {
    requested = try detailRegion(region!)
  }
  let bounds = CGRect(origin: .zero, size: frame.size)
  let crop = requested.intersection(bounds)
  guard !crop.isNull, !crop.isEmpty, crop.width.isFinite, crop.height.isFinite else {
    throw HelperError("no_element", "the requested region is outside the bound window")
  }
  let nativeScale = window.pixelScale
  let sourceWidth = max(1, Int((frame.width * nativeScale).rounded()))
  let sourceHeight = max(1, Int((frame.height * nativeScale).rounded()))
  guard Double(sourceWidth) * Double(sourceHeight) <= detailSourceMaxPixels else {
    throw HelperError("unsupported", "the window exceeds the 32-megapixel native capture budget; resize the window and retry")
  }
  let configuration = SCStreamConfiguration()
  // ScreenCaptureKit ignores sourceRect for an independent window. Capture native pixels,
  // then crop them before resizing; a small crop must not inherit the full-window downscale.
  configuration.width = sourceWidth
  configuration.height = sourceHeight
  configuration.showsCursor = false
  configuration.ignoreShadowsSingleWindow = true
  let capture = try shotImage(window: window, configuration: configuration)
  let source = capture.image
  let current = try liveDetailFrame(pid: pid, windowId: window.windowID)
  guard abs(current.minX - frame.minX) < 0.5, abs(current.minY - frame.minY) < 0.5,
        abs(current.width - frame.width) < 0.5, abs(current.height - frame.height) < 0.5 else {
    throw HelperError("no_window", "the bound window moved or resized during capture (\(frame) → \(current)); observe it again and retry the screenshot")
  }
  let sourceScaleX = Double(source.width) / frame.width
  let sourceScaleY = Double(source.height) / frame.height
  let pixels = CGRect(x: crop.minX * sourceScaleX, y: crop.minY * sourceScaleY,
                      width: crop.width * sourceScaleX, height: crop.height * sourceScaleY)
    .integral.intersection(CGRect(x: 0, y: 0, width: source.width, height: source.height))
  guard let clipped = source.cropping(to: pixels) else {
    throw HelperError("ax_error", "the requested region could not be cropped from the captured window")
  }
  let actual = CGRect(x: pixels.minX / sourceScaleX, y: pixels.minY / sourceScaleY,
                      width: pixels.width / sourceScaleX, height: pixels.height / sourceScaleY)
  let image = try budgetDetail(clipped)
  let scaleX = actual.width / Double(image.width)
  let scaleY = actual.height / Double(image.height)
  let marked = withPointerMark(image, frameOrigin: CGPoint(x: frame.minX + actual.minX, y: frame.minY + actual.minY),
                               scale: scaleX, owner: pid, mark: mark)
  return [
    "png": try shotPNG(marked), "id": Int(window.windowID),
    "x": frame.minX, "y": frame.minY, "w": frame.width, "h": frame.height,
    "region": ["x": actual.minX, "y": actual.minY, "w": actual.width, "h": actual.height],
    "pixelWidth": image.width, "pixelHeight": image.height,
    "scale": scaleX, "scaleY": scaleY, "trimmed": crop != requested,
    "captureBackend": capture.backend,
  ]
}

private func budgetDetail(_ image: CGImage) throws -> CGImage {
  let width = Double(image.width), height = Double(image.height)
  let scale = min(1.0, detailMaxLongSide / max(width, height), sqrt(detailMaxPixels / (width * height)))
  if scale == 1 { return image }
  let w = max(1, Int((width * scale).rounded(.down)))
  let h = max(1, Int((height * scale).rounded(.down)))
  guard let context = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    throw HelperError("ax_error", "the detail capture could not allocate its bounded image")
  }
  context.interpolationQuality = .high
  context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  guard let resized = context.makeImage() else { throw HelperError("ax_error", "the detail capture could not be resized") }
  return resized
}
