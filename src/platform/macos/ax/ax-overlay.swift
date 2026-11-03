/// The agent's pointer, drawn on the user's screen.
///
/// macOS has exactly ONE cursor, carried by every session-tap event, so there is no second real
/// pointer. A posted event moves the real cursor and an accessibility act moves none; either way the
/// user cannot tell WHOSE hand acted. This panel says so: borderless, non-activating, click-through
/// (`ignoresMouseEvents`, never in the hit test), visible only over the target's uncovered area.
/// It never fails an action: every entry point is best-effort, and a session with no window server
/// (ssh, launchd) simply gets no overlay.
///
/// It STAYS between acts: for accessibility acts (most of them) the drawing is the only place the
/// agent's pointer exists. It dies with this helper, which the host retires with the task;
/// occlusion, app switching and window movement conceal it sooner, and the next visible act redraws.
///
/// The agent's own arrow TRAVELS: from where it last acted to the next act it glides along a gentle
/// curve, eased by a spring and leaning into its motion, so the eye can follow it from act to act.
/// A teleport between two controls says nothing about which one was hit. The glide is drawing only:
/// the act itself has already happened and never waits for it.
import AppKit
import CoreGraphics
import Foundation

/// How long one act's ripple takes to expand and fade.
private let PULSE_S: Double = 0.45
/// The ring's radius in points, and the width of its stroke.
private let RING_R: CGFloat = 9
private let RING_W: CGFloat = 1.8
/// Keep the arrow compact without moving its hotspot or changing event coordinates.
private let ARROW_SCALE: CGFloat = 0.8
/// Half the panel's side: room for the glow, the ripple and a leaning arrow around the hotspot.
private let PANEL_R: CGFloat = 32

/// A glide's spring: the response grows with distance between these bounds, so a hop is quick and
/// a trip across the screen still reads as one motion. Damped just short of critical: it lands
/// without a visible bounce.
private let GLIDE_RESPONSE_MIN: Double = 0.32
private let GLIDE_RESPONSE_MAX: Double = 0.6
private let GLIDE_RESPONSE_PER_PT: Double = 0.0004
private let GLIDE_DAMPING: Double = 0.86
/// Below this distance the path is straight: a bow on a short hop reads as a wobble.
private let GLIDE_STRAIGHT_PT: CGFloat = 48
/// How far the curve bows out, as a share of the distance, and its ceiling in points.
private let GLIDE_BOW: CGFloat = 0.16
private let GLIDE_BOW_MAX: CGFloat = 80
/// The most the arrow leans into its motion, and the speed (pt/s) at which it leans that far.
private let LEAN_MAX: CGFloat = 24 * .pi / 180
private let LEAN_FULL_SPEED: CGFloat = 900
/// Fade-in for an arrow that was not on screen, and the dip that says "pressed" when it lands.
private let APPEAR_S: Double = 0.16
private let TAP_S: Double = 0.18

/// Where the arrow POINTS, tail to tip, in event coordinates (y down): up and to the left.
private let ARROW_HEADING = atan2(-1.0, -1.0)

/// One glide: a cubic curve from where the arrow was drawn to where the agent acted.
private struct Glide {
  let from: CGPoint
  let to: CGPoint
  let c1: CGPoint
  let c2: CGPoint
  let response: Double
  let start: Date
  /// The act's ripple, held back until the arrow arrives: a ripple ahead of the arrow reads as two acts.
  var pulse: Bool

  init(from: CGPoint, to: CGPoint, pulse: Bool) {
    self.from = from
    self.to = to
    self.pulse = pulse
    start = Date()
    let dx = to.x - from.x, dy = to.y - from.y
    let dist = hypot(dx, dy)
    response = min(GLIDE_RESPONSE_MAX, max(GLIDE_RESPONSE_MIN, GLIDE_RESPONSE_MIN + Double(dist) * GLIDE_RESPONSE_PER_PT))
    // Bow to the side that lifts the path (a hand arcs over, not under), unless that side leaves
    // every screen. The second control sits nearer the target with less bow, so the arrow comes in
    // almost straight and the landing is easy to read.
    let bow = dist < GLIDE_STRAIGHT_PT ? 0 : min(dist * GLIDE_BOW, GLIDE_BOW_MAX)
    var n = dist > 0 ? CGPoint(x: -dy / dist, y: dx / dist) : .zero
    if n.y > 0 { n = CGPoint(x: -n.x, y: -n.y) }
    let mid = CGPoint(x: (from.x + to.x) / 2 + n.x * bow * 0.75, y: (from.y + to.y) / 2 + n.y * bow * 0.75)
    if !onAnyScreen(mid) { n = CGPoint(x: -n.x, y: -n.y) }
    c1 = CGPoint(x: from.x + dx * 0.3 + n.x * bow, y: from.y + dy * 0.3 + n.y * bow)
    c2 = CGPoint(x: from.x + dx * 0.75 + n.x * bow * 0.5, y: from.y + dy * 0.75 + n.y * bow * 0.5)
  }

  /// Progress along the curve at `t` seconds: a damped spring's step response.
  func progress(_ t: Double) -> Double {
    let w0 = 2 * Double.pi / response
    let z = GLIDE_DAMPING
    let wd = w0 * (1 - z * z).squareRoot()
    return 1 - exp(-z * w0 * t) * (cos(wd * t) + z * w0 / wd * sin(wd * t))
  }

  /// The spring has settled to well under a point by then.
  var duration: Double { response * 1.2 }

  func point(_ s: Double) -> CGPoint {
    let s = CGFloat(min(1, max(0, s))), r = 1 - s
    let a = r * r * r, b = 3 * r * r * s, c = 3 * r * s * s, d = s * s * s
    return CGPoint(x: a * from.x + b * c1.x + c * c2.x + d * to.x,
                   y: a * from.y + b * c1.y + c * c2.y + d * to.y)
  }
}

/// Whether a point in event coordinates (top-left origin of the primary screen) is on any screen.
private func onAnyScreen(_ p: CGPoint) -> Bool {
  guard let primary = NSScreen.screens.first else { return true }
  return NSScreen.screens.contains { s in
    CGRect(x: s.frame.minX, y: primary.frame.maxY - s.frame.maxY, width: s.frame.width, height: s.frame.height).contains(p)
  }
}

/// Everything AppKit here is main-thread only; the helper's ops run on a work queue, so every
/// entry point hops. The panel is built on first use and kept — building it per move would flicker.
private final class PointerOverlay {
  static let shared = PointerOverlay()
  private var panel: NSPanel?
  private var view: PointerView?
  private var holding = false
  private var animTimer: Timer?
  private var visibilityTimer: Timer?
  private var mark: (point: CGPoint, owner: pid_t)?
  private var workspaceObservers: [NSObjectProtocol] = []
  /// Where the panel is drawn right now, mid-glide included: the next glide starts from HERE.
  private var drawnAt: CGPoint?
  private var glide: Glide?
  private var lastTick = Date()

  private init() {
    let center = NSWorkspace.shared.notificationCenter
    for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.didHideApplicationNotification,
                 NSWorkspace.didTerminateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
      workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.checkVisibility()
      })
    }
  }

  /// Show the pointer at a screen point (top-left origin, the coordinates every event here uses).
  func show(at point: CGPoint, owner: pid_t, holding: Bool, shape: PointerShape, pulse: Bool = false) {
    guard pointShowing(point, of: owner, margin: RING_R * 2) else { conceal(); return }
    guard NSScreen.screens.first != nil else { return }
    mark = (point, owner)
    let panel = ensurePanel()
    let shown = panel.isVisible ? drawnAt : nil
    view?.holding = holding
    view?.shape = shape
    if glide?.to == point {
      // The same act's mark again: let the glide in flight finish rather than restart it.
      if pulse { glide?.pulse = true }
    } else if shape == .virtual, let from = shown, hypot(point.x - from.x, point.y - from.y) > 2 {
      glide = Glide(from: from, to: point, pulse: pulse)
    } else {
      // The ring follows the REAL cursor, which posted events already moved: it must not lag it.
      glide = nil
      place(at: point)
      // A ripple says an ACT happened here, which position alone cannot (two clicks on one control).
      if pulse { view?.pulseAt = Date() }
      if shown == nil { view?.appearAt = Date() }
    }
    armAnimation()
    view?.needsDisplay = true
    if !panel.isVisible { panel.orderFrontRegardless() }
    self.holding = holding
    if visibilityTimer == nil {
      // Window moves and ordering within one app have no workspace notification. Poll only
      // while a mark is drawn; its state stays on this main thread, never a competing queue.
      let timer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.checkVisibility() }
      RunLoop.main.add(timer, forMode: .common)
      visibilityTimer = timer
    }
  }

  /// Move the panel so the hotspot sits on `point`.
  private func place(at point: CGPoint) {
    guard let panel, let screen = NSScreen.screens.first else { return }
    drawnAt = point
    // AppKit's origin is bottom-left of the PRIMARY screen; the event world's is top-left.
    panel.setFrameOrigin(NSPoint(x: point.x - PANEL_R, y: screen.frame.maxY - point.y - PANEL_R))
  }

  private func checkVisibility() {
    guard let mark else { return }
    if !pointShowing(mark.point, of: mark.owner, margin: RING_R * 2) { conceal() }
  }

  /// The point the agent just acted on is not on screen — @see `overlayConceal`.
  func conceal() {
    mark = nil
    glide = nil
    drawnAt = nil
    visibilityTimer?.invalidate()
    visibilityTimer = nil
    animTimer?.invalidate()
    animTimer = nil
    view?.pulseAt = nil
    view?.appearAt = nil
    view?.lean = 0
    panel?.orderOut(nil)
  }

  /// The real cursor has left this point (a click or a scroll put it back), so the RING becomes the
  /// agent's own ARROW, in place.
  func handOff() {
    holding = false
    view?.holding = false
    view?.shape = .virtual
    view?.needsDisplay = true
  }

  private func ensurePanel() -> NSPanel {
    if let panel { return panel }
    let side = PANEL_R * 2
    let p = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: side, height: side),
      styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.ignoresMouseEvents = true          // never in the hit test: the overlay must not eat a click
    p.level = .screenSaver               // above ordinary windows, including full-screen apps
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    let v = PointerView(frame: NSRect(x: 0, y: 0, width: side, height: side))
    p.contentView = v
    panel = p
    view = v
    return p
  }

  /// ~60 fps while something moves — a glide, a ripple, a fade-in, a lean settling — then gone:
  /// nothing animates between acts.
  private func armAnimation() {
    guard animTimer == nil else { return }
    lastTick = Date()
    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.tick() }
    RunLoop.main.add(timer, forMode: .common)
    animTimer = timer
  }

  private func tick() {
    guard let view else { return }
    let now = Date()
    let dt = max(1.0 / 240, now.timeIntervalSince(lastTick))
    lastTick = now
    var leanTarget: CGFloat = 0
    if let g = glide, let before = drawnAt {
      let t = now.timeIntervalSince(g.start)
      if t >= g.duration {
        place(at: g.to)
        glide = nil
        if g.pulse { view.pulseAt = now }
      } else {
        let at = g.point(g.progress(t))
        place(at: at)
        // Lean the arrow's heading toward its motion, more the faster it goes: sin() makes it
        // zero both moving along the heading and straight against it, so it never flips over.
        let vx = (at.x - before.x) / CGFloat(dt), vy = (at.y - before.y) / CGFloat(dt)
        let speed = hypot(vx, vy)
        if speed > 1 {
          leanTarget = LEAN_MAX * CGFloat(sin(atan2(Double(vy), Double(vx)) - ARROW_HEADING)) * min(1, speed / LEAN_FULL_SPEED)
        }
      }
    }
    view.lean += (leanTarget - view.lean) * 0.3
    if let at = view.pulseAt, now.timeIntervalSince(at) > PULSE_S { view.pulseAt = nil }
    if let at = view.appearAt, now.timeIntervalSince(at) > APPEAR_S { view.appearAt = nil }
    view.needsDisplay = true
    if glide == nil, view.pulseAt == nil, view.appearAt == nil, abs(view.lean) < 0.002 {
      view.lean = 0
      animTimer?.invalidate()
      animTimer = nil
    }
  }
}

/// `.virtual`: an accessibility act posted nothing and the user's cursor is elsewhere, so the agent's
/// pointer is a tinted ARROW. `.real`: a posted event carried the system arrow here, and a second
/// arrow would read as a rendering fault, so it is a RING around it, filled while a button is held.
private enum PointerShape { case virtual, real }

private final class PointerView: NSView {
  var holding = false
  var shape: PointerShape = .real

  var pulseAt: Date?
  var appearAt: Date?
  /// Clockwise lean of the arrow, in radians, while it glides.
  var lean: CGFloat = 0

  override func draw(_ dirtyRect: NSRect) {
    guard let ctx = NSGraphicsContext.current?.cgContext else { return }
    let c = CGPoint(x: bounds.midX, y: bounds.midY)
    if let at = appearAt {
      let a = CGFloat(min(1, Date().timeIntervalSince(at) / APPEAR_S))
      ctx.setAlpha(a)
    }
    drawPulse(ctx, at: c)
    switch shape {
    case .real: drawRing(ctx, at: c)
    case .virtual:
      drawGlow(ctx, at: c)
      drawArrow(ctx, tipAt: c)
    }
  }

  /// One ring, expanding and fading, for the length of {@link PULSE_S}. Under the pointer, never
  /// over it: the thing that must stay readable is where the act landed.
  private func drawPulse(_ ctx: CGContext, at c: CGPoint) {
    guard let at = pulseAt else { return }
    let t = Date().timeIntervalSince(at) / PULSE_S
    guard t >= 0, t <= 1 else { return }
    let r = 4 + (RING_R + 5 - 4) * CGFloat(t)
    ctx.setLineWidth(2)
    ctx.setStrokeColor(NSColor.systemBlue.withAlphaComponent(0.75 * (1 - CGFloat(t))).cgColor)
    ctx.strokeEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
  }

  private func drawRing(_ ctx: CGContext, at c: CGPoint) {
    ctx.setLineWidth(RING_W)
    // A dark halo under the bright ring, so it stays visible on light and dark windows alike.
    ctx.setStrokeColor(NSColor.black.withAlphaComponent(0.35).cgColor)
    ctx.strokeEllipse(in: CGRect(x: c.x - RING_R - 1, y: c.y - RING_R - 1, width: (RING_R + 1) * 2, height: (RING_R + 1) * 2))
    ctx.setStrokeColor(NSColor.systemBlue.withAlphaComponent(0.95).cgColor)
    ctx.strokeEllipse(in: CGRect(x: c.x - RING_R, y: c.y - RING_R, width: RING_R * 2, height: RING_R * 2))
    if holding {
      ctx.setFillColor(NSColor.systemBlue.withAlphaComponent(0.45).cgColor)
      ctx.fillEllipse(in: CGRect(x: c.x - RING_R + 3, y: c.y - RING_R + 3, width: (RING_R - 3) * 2, height: (RING_R - 3) * 2))
    }
  }

  /// A soft tinted glow under the arrow's body: it finds the pointer on a busy window without a
  /// hard edge competing with the control beneath.
  private func drawGlow(_ ctx: CGContext, at c: CGPoint) {
    let center = CGPoint(x: c.x + 5, y: c.y - 5)
    let colors = [NSColor.systemBlue.withAlphaComponent(0.3).cgColor, NSColor.systemBlue.withAlphaComponent(0).cgColor] as CFArray
    guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) else { return }
    ctx.drawRadialGradient(gradient, startCenter: center, startRadius: 0, endCenter: center, endRadius: 17, options: [])
  }

  /// A notched arrow, HOTSPOT at the tip. Its own shape rather than the system arrow's, so it never
  /// passes for the user's cursor. Drawn in AppKit's upward y, so the body runs down and right.
  private func drawArrow(_ ctx: CGContext, tipAt t: CGPoint) {
    ctx.saveGState()
    defer { ctx.restoreGState() }
    ctx.translateBy(x: t.x, y: t.y)
    // AppKit's y runs up, so a clockwise lean is a negative rotation.
    ctx.rotate(by: -lean)
    // Landing on an act: a quick dip, as a fingertip presses.
    var press: CGFloat = holding ? 0.88 : 1
    if let at = pulseAt {
      let u = Date().timeIntervalSince(at) / TAP_S
      if u >= 0, u <= 1 { press *= 1 - 0.14 * CGFloat(sin(Double.pi * u)) }
    }
    ctx.scaleBy(x: ARROW_SCALE * press, y: ARROW_SCALE * press)
    let p = CGMutablePath()
    p.move(to: .zero)
    p.addLine(to: CGPoint(x: 4, y: -16))
    p.addLine(to: CGPoint(x: 7.4, y: -7.4))
    p.addLine(to: CGPoint(x: 16, y: -4))
    p.closeSubpath()
    // A solid fill with a faint shadow keeps the small pointer distinct from the app content beneath.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -1), blur: 3, color: NSColor.black.withAlphaComponent(0.4).cgColor)
    ctx.addPath(p)
    ctx.setFillColor(NSColor.systemBlue.cgColor)
    ctx.fillPath()
    ctx.restoreGState()
    // Round joins soften every corner, the tip included.
    ctx.addPath(p)
    ctx.setLineJoin(.round)
    ctx.setLineCap(.round)
    ctx.setStrokeColor(NSColor.white.withAlphaComponent(0.95).cgColor)
    ctx.setLineWidth(2)
    ctx.strokePath()
  }
}

/// Whether this process can draw at all. A helper started outside a window-server session must not
/// touch AppKit: `NSApplication.shared` there is at best useless and at worst a hang.
private let canDraw: Bool = {
  guard let info = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return (info["kCGSSessionOnConsoleKey"] as? Bool) ?? false
}()

/// Marks the pointer at a screen point. Best-effort, main-thread, never throws.
/// @param virtual the act posted no event, so the system cursor is elsewhere and this drawing is
///                the only pointer there is — @see PointerShape.
func overlayShow(at point: CGPoint, owner: pid_t, holding: Bool, virtual: Bool = false, pulse: Bool = false) {
  guard canDraw else { sayOnce("overlay: no window-server session, so the pointer is not drawn"); return }
  DispatchQueue.main.async {
    // `finishLaunching` is what makes a window appear at all when the main run loop was not started
    // by `NSApp.run()` — this helper runs a CFRunLoop on main and the stdio loop on a background one.
    let app = NSApplication.shared
    if !appReady {
      app.setActivationPolicy(.prohibited)
      app.finishLaunching()
      appReady = true
      sayOnce("overlay: drawing the agent pointer")
    }
    PointerOverlay.shared.show(at: point, owner: owner, holding: holding, shape: virtual ? .virtual : .real, pulse: pulse)
  }
}

/// AppKit set up once. Not a lock: everything here is already on the main queue.
private var appReady = false

/// One line to the helper's own log (the driver's diagnostics channel), once per reason, so an
/// overlay that does nothing is never silent.
private var said = Set<String>()
private func sayOnce(_ line: String) {
  guard !said.contains(line) else { return }
  said.insert(line)
  FileHandle.standardError.write(Data((line + "\n").utf8))
}

/// The act landed somewhere the user cannot see — another app's window covers it, or the target's
/// window is not on screen at all. The drawing is taken down for exactly as long as that is true.
///
/// Not drawn anyway: the panel sits at `.screenSaver` level on every Space, so a mark from an
/// occluded element's frame would land on TOP of whatever the user is looking at. The POSITION is
/// kept (`pointerAt`), so a capture of the target's own window still carries the mark.
func overlayConceal() {
  guard canDraw else { return }
  DispatchQueue.main.async { PointerOverlay.shared.conceal() }
}

/// The real cursor went home; the agent's pointer stays where it acted. @see PointerOverlay.handOff
func overlayHandOff() {
  guard canDraw else { return }
  DispatchQueue.main.async { PointerOverlay.shared.handOff() }
}
