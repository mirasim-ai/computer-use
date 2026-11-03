/// The agent's POINTER: a position this helper owns, moved along a path and pressed and released as
/// separate acts — where `mouseClick` is one indivisible warp-and-click.
///
/// An app that polls input per frame and tracks whether the pointer is INSIDE its popup (Blender,
/// reachable only by pointer) ignores `mouse` and `drag`; it wants what a hand does — stepped
/// motion, a press that lasts, a release where the press was — each its own op.
///
/// Rules:
///   · events go on the SESSION TAP: `postToPid` mouse events land nowhere;
///   · a point another app's window covers is refused (`requireUncovered`), as in `mouseClick`;
///   · the cursor is NOT put back: snapping it home between steps makes a sequence unreadable and
///     cancels a popup that closes when the pointer leaves.
///
/// While a button is down, motion must be a DRAG (`.leftMouseDragged`), not a move: toolkits read a
/// move with the button held as a teleport with no button state.
import CoreGraphics
import Foundation

/// Where the agent's pointer is, and whether it is holding a button. `nil` until the first move —
/// then the pointer has a position of its own, independent of where the user's cursor was.
private var pointerAt: CGPoint?
private var pointerDown: CGMouseButton?

/// WHOSE interface that point belongs to. A bare coordinate cannot be checked later against the
/// window order or a capture, so the owner travels with the position everywhere it is set.
private var pointerOwner: pid_t?

/// How long one step of a path takes: under one frame at 60 Hz, so a per-frame poller sees motion
/// rather than a teleport.
private let STEP_SLEEP_MS: Double = 12
/// Steps a path is cut into by default: several events for a short hop, within a call's budget.
private let DEFAULT_STEPS = 12

/// ── The GRAB ────────────────────────────────────────────────────────────────────────────────
///
/// `CGAssociateMouseAndMouseCursorPosition(false)` cuts the physical mouse off from the on-screen
/// cursor (macOS has exactly one): the agent's moves still place it, the user's hand does not.
///
/// Held only while the agent holds a button — where a human hand would corrupt a drag or a press.
///
/// Restored on every road out, because the failure mode is a user whose mouse stopped working:
///   · the release that ends the press;
///   · a WATCHDOG, for a sequence that never releases, after {@link GRAB_MAX_S};
///   · `atexit` and the signal sources in main.swift. The state is believed to be per-process;
///     "believed" is not the standard for something that can lock a person out of their machine.
private var grabbed = false
private var grabbedAt = Date.distantPast

/// How long the physical mouse may stay cut off with nothing happening.
private let GRAB_MAX_S: Double = 20

/// Cut the hardware off — only from {@link pointerPress}, only while a button is held.
private func grabMouse() {
  guard !grabbed else { grabbedAt = Date(); return }
  guard CGAssociateMouseAndMouseCursorPosition(0) == .success else { return }
  grabbed = true
  grabbedAt = Date()
  DispatchQueue.global().asyncAfter(deadline: .now() + GRAB_MAX_S + 1) { watchdog() }
}

/// Give it back. Safe to call at any time, from any road, however many times.
func ungrabMouse() {
  guard grabbed else { return }
  grabbed = false
  _ = CGAssociateMouseAndMouseCursorPosition(1)
  // Logged every time: the proof the user's mouse was given back.
  FileHandle.standardError.write(Data("pointer: the physical mouse is reconnected to the cursor\n".utf8))
}

/// The road for a press that never released. Re-arms itself while the grab is still young, so a
/// long legitimate drag is not cut off at a fixed instant.
private func watchdog() {
  guard grabbed else { return }
  let idle = Date().timeIntervalSince(grabbedAt)
  if idle >= GRAB_MAX_S {
    FileHandle.standardError.write(Data("pointer: the mouse was held for \(Int(idle))s with no release — giving it back\n".utf8))
    ungrabMouse()
    pointerDown = nil
    return
  }
  DispatchQueue.global().asyncAfter(deadline: .now() + (GRAB_MAX_S - idle) + 1) { watchdog() }
}

/// The pointer's position as everything here understands it: the last place we put it, or — before
/// the first move — wherever the user's cursor is.
private func currentPointer() -> CGPoint {
  pointerAt ?? CGEvent(source: nil)?.location ?? .zero
}

/// `ptrstate {}` → where the pointer is and what it is holding. The one read; everything else acts.
func pointerState() -> [String: Any] {
  let p = currentPointer()
  return ["x": p.x, "y": p.y, "down": pointerDown != nil, "owned": pointerAt != nil, "grabbed": grabbed]
}

/// `ptrmove {pid, x, y, steps?}` — move the pointer along a PATH to the point and leave it there.
///
/// Returns how many events it posted: the fact the caller reports.
func pointerMove(pid: pid_t, x: Double, y: Double, steps requested: Int?) throws -> [String: Any] {
  try requirePostEvents()
  let to = CGPoint(x: x, y: y)
  // NOT `requireUncovered`: a move posts no button and may cross other windows. The guard
  // belongs on the PRESS.
  let from = currentPointer()
  let steps = max(1, min(60, requested ?? DEFAULT_STEPS))
  let source = try eventSource()
  let dragging = pointerDown
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let at = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    // A held button makes every intermediate point a DRAG.
    let type: CGEventType = dragging == nil ? .mouseMoved : dragType(dragging!)
    CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: dragging ?? .left)?
      .post(tap: .cgSessionEventTap)
    pointerAt = at
    pointerOwner = pid
    if dragging != nil { grabbedAt = Date() }   // a drag in progress is not an idle grab
    showPointer(at: at, owner: pid, holding: dragging != nil)
    if i < steps { Thread.sleep(forTimeInterval: STEP_SLEEP_MS / 1000) }
  }
  return ["x": to.x, "y": to.y, "steps": steps, "dragging": dragging != nil]
}

/// `ptrpress {pid, button?}` — press and HOLD at the pointer's position.
///
/// Separate from the release: a slider, a drag handle or a popup wanting a real press needs a hold.
func pointerPress(pid: pid_t, button: String) throws -> [String: Any] {
  try requirePostEvents()
  let at = currentPointer()
  // Here, and only here: a press is what would go to whatever window is on top at this point.
  try requireUncovered(at, pid: pid)
  if pointerDown != nil { throw HelperError("ax_error", "the pointer is already holding a button — release it first") }
  let (btn, downType, _) = mouseTypes(button)
  guard let down = CGEvent(mouseEventSource: try eventSource(), mouseType: downType, mouseCursorPosition: at, mouseButton: btn)
  else { throw HelperError("ax_error", "could not build a mouse event") }
  down.setIntegerValueField(.mouseEventClickState, value: 1)
  down.post(tap: .cgSessionEventTap)
  pointerAt = at
  pointerOwner = pid
  pointerDown = btn
  // From here until the release the cursor is the agent's alone — @see the GRAB section above.
  grabMouse()
  showPointer(at: at, owner: pid, holding: true, pulse: true)
  return ["x": at.x, "y": at.y, "button": button]
}

/// `ptrrelease {pid, button?}` — release at wherever the pointer is NOW, which is what makes a
/// press, a path and a release add up to a drag the app understands.
func pointerRelease(pid: pid_t, button: String) throws -> [String: Any] {
  try requirePostEvents()
  let at = currentPointer()
  let (btn, _, upType) = mouseTypes(button)
  guard let up = CGEvent(mouseEventSource: try eventSource(), mouseType: upType, mouseCursorPosition: at, mouseButton: pointerDown ?? btn)
  else { throw HelperError("ax_error", "could not build a mouse event") }
  up.setIntegerValueField(.mouseEventClickState, value: 1)
  up.post(tap: .cgSessionEventTap)
  let held = pointerDown != nil
  pointerDown = nil
  ungrabMouse()
  pointerOwner = pid
  showPointer(at: at, owner: pid, holding: false)
  return ["x": at.x, "y": at.y, "wasHolding": held]
}

/// A short approach PATH for `mouseClick`, and the pointer state it leaves behind.
///
/// A per-frame poller asking "is the pointer inside me" must SEE it arrive: Blender's File menu
/// ignores a press after ONE motion event and honours one after three. ~36 ms per click.
func postApproach(to: CGPoint, owner: pid_t, source: CGEventSource) {
  let from = currentPointer()
  for i in 1...APPROACH_STEPS {
    let t = Double(i) / Double(APPROACH_STEPS)
    let at = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left)?
      .post(tap: .cgSessionEventTap)
    showPointer(at: at, owner: owner, holding: false)
    if i < APPROACH_STEPS { Thread.sleep(forTimeInterval: STEP_SLEEP_MS / 1000) }
  }
  pointerAt = to
  pointerOwner = owner
}

/// Steps in that approach: the measured minimum (three, on one app) plus one.
private let APPROACH_STEPS = 4

/// Draw the pointer mark. The overlay owns visibility tracking on the main thread.
func showPointer(at point: CGPoint, owner: pid_t, holding: Bool, virtual: Bool = false, pulse: Bool = false) {
  overlayShow(at: point, owner: owner, holding: holding, virtual: virtual, pulse: pulse)
}

/// Where the pointer IS, when that place cannot honestly be drawn — @see `overlayConceal`.
func notePointerHidden(_ point: CGPoint, owner: pid_t) {
  pointerAt = point
  pointerOwner = owner
  overlayConceal()
}

/// Where the pointer IS, told by something other than a posted event. `mouseClick` ends by putting
/// the user's cursor back (`drawn: false`), so the ring is redrawn as the arrow in place; an
/// ACCESSIBILITY act (`drawn: true`) never moved a cursor, so it is the arrow from the start.
func notePointerAt(_ point: CGPoint, owner: pid_t, drawn: Bool = false) {
  pointerAt = point
  pointerOwner = owner
  // The hand-off changes the panel's shape, not its position; the overlay keeps point and owner.
  if drawn { showPointer(at: point, owner: owner, holding: false, virtual: true, pulse: true) }
  else { overlayHandOff() }
}

/// The drag event type that belongs to a held button — the one thing a path has to know about.
private func dragType(_ button: CGMouseButton) -> CGEventType {
  switch button {
  case .right: return .rightMouseDragged
  case .center: return .otherMouseDragged
  default: return .leftMouseDragged
  }
}

/// The pointer's mark for a capture of `owner`'s window, or nil when the pointer is not ours yet or
/// belongs to ANOTHER app: windows overlap, and a session driving two apps is ordinary, so without
/// the owner one app's act would be drawn into a picture of the other.
func capturePointer(owner: pid_t) -> [String: Any]? {
  guard let at = pointerAt, pointerOwner == owner else { return nil }
  return ["x": Double(at.x), "y": Double(at.y), "down": pointerDown != nil]
}

/// The pointer, drawn into a window capture — @see `shot`. The image comes back unchanged when
/// there is no mark or it sits outside this window: a mark at the edge would be a lie.
func withPointerMark(_ image: CGImage, frameOrigin: CGPoint, scale: Double, owner: pid_t,
                     mark: [String: Any]? = nil) -> CGImage {
  let value = mark ?? capturePointer(owner: owner)
  guard let value, let x = value["x"] as? Double, let y = value["y"] as? Double,
        x.isFinite, y.isFinite, scale > 0 else { return image }
  let at = CGPoint(x: x, y: y)
  // Screen point → image pixel: the inverse of what `toScreen` does on the TS side.
  let px = (at.x - frameOrigin.x) / scale
  let py = (at.y - frameOrigin.y) / scale
  let w = image.width, h = image.height
  guard px >= 0, py >= 0, px <= Double(w), py <= Double(h) else { return image }
  guard let space = image.colorSpace,
        let ctx = CGContext(
          data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
          space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return image }
  ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
  // CoreGraphics draws from the bottom-left; the capture's own y runs the other way.
  let c = CGPoint(x: px, y: Double(h) - py)
  let r = MARK_R * (1.0 / max(scale, 0.0001))
  ctx.setLineWidth(max(2.0, r * 0.22))
  ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.35))
  ctx.strokeEllipse(in: CGRect(x: c.x - r - 1, y: c.y - r - 1, width: (r + 1) * 2, height: (r + 1) * 2))
  ctx.setStrokeColor(CGColor(red: 0.13, green: 0.47, blue: 1.0, alpha: 0.95))
  ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
  if (value["down"] as? Bool) == true {
    ctx.setFillColor(CGColor(red: 0.13, green: 0.47, blue: 1.0, alpha: 0.45))
    ctx.fillEllipse(in: CGRect(x: c.x - r * 0.6, y: c.y - r * 0.6, width: r * 1.2, height: r * 1.2))
  }
  return ctx.makeImage() ?? image
}

/// The mark's radius in window POINTS, so it looks the same size at any downscale.
private let MARK_R: Double = 8
