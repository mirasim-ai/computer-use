// AX keys remain process-local. Prepare a window-pinned capture without using ScreenCaptureKit.
import AppKit
import Foundation

func prepareCapture(pid: pid_t, windowId: Int?, engine: AXEngine, scoped: Bool,
                    region: [String: Any]?, key: String?, padding: Double, maxLongSide: Int) throws -> [String: Any] {
  guard #available(macOS 14.0, *) else { throw HelperError("unsupported", "window capture needs macOS 14 or newer") }
  // Full screenshots need Screen Recording, not Accessibility. Only ref-based crops ask AX.
  let selected = try fallbackShotWindow(pid: pid, windowId: windowId, preferredId: engine.defaultWindowId(pid: pid))
  let id = Int(selected.windowID)
  let frame = try liveDetailFrame(pid: pid, windowId: CGWindowID(id))
  var result: [String: Any] = ["pid": Int(pid), "window": id, "maxLongSide": maxLongSide,
    "expectedFrame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]]
  if let mark = capturePointer(owner: pid) { result["mark"] = mark }
  if scoped {
    guard (region != nil) != (key != nil), padding.isFinite, padding >= 0, key != nil || padding == 0 else {
      throw HelperError("bad_request", "choose region or element key, with finite nonnegative padding")
    }
    let requested: CGRect
    if let key {
      requested = try detailElement(engine: engine, pid: pid, windowId: id, key: key)
        .offsetBy(dx: -frame.minX, dy: -frame.minY).insetBy(dx: -padding, dy: -padding)
    } else { requested = try detailRegion(region!) }
    result["region"] = ["x": requested.minX, "y": requested.minY, "width": requested.width, "height": requested.height]
  }
  return result
}

func checkCaptureFrame(_ expected: [String: Any]?, _ actual: CGRect) throws {
  guard let expected else { return }
  let wanted = try detailRegion(expected)
  guard abs(wanted.minX - actual.minX) < 0.5, abs(wanted.minY - actual.minY) < 0.5,
        abs(wanted.width - actual.width) < 0.5, abs(wanted.height - actual.height) < 0.5 else {
    throw HelperError("no_window", "the bound window moved or resized after its capture was prepared; observe it again")
  }
}
