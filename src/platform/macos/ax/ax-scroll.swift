// Scrolling a scroll area through its OWN accessibility actions — no pointer, no event tap.
//
// The wheel (`scrollWheel`, ax-events.swift) rides the session tap, so it must REFUSE a point
// another window covers — on a typical desktop, the whole of a background window. This route never
// touches the pointer.
//
// Three measured facts shape the code below:
//
//  1. A SUCCESS returns a NON-ZERO AXError (-25205, kAXErrorAttributeUnsupported, while the content
//     moved a page). The return code is ignored and the verdict comes from DISPLACEMENT, the same
//     rule chromium/scroll.ts lives by.
//  2. -25204 (kAXErrorCannotComplete) is what an area with nothing to scroll answers, not
//     "this route is unsupported".
//  3. The action names are CONTENT-relative, the inverse of what a caller means: AXScrollUpByPage
//     shows what is FURTHER DOWN (measured from the top of Finder and System Settings lists).
//
// Horizontal is NOT offered: its direction could not be measured, and guessing would scroll the
// wrong way under the right word. `direction:'left'|'right'` keeps the wheel.

import AppKit
import ApplicationServices
import Foundation

/// Pages one request may apply. `to:'top'|'bottom'` asks for this many and stops as soon as one
/// page moves nothing: a jump where macOS offers no seek.
let MAX_SCROLL_PAGES = 60

/// How long a page takes to land before the next sample: 250 ms reads the full displacement; less
/// catches the animation.
private let PAGE_SETTLE_US: UInt32 = 250_000

extension AXEngine {
  /// `scrollpage {pid, key?, x?, y?, direction, pages}` → `{applied, moved, delta, unit, area}`.
  ///
  /// `key` names an element INSIDE the area to scroll; without one, the point is hit-tested (the
  /// wheel's target). Either way the area is the nearest AXScrollArea ancestor.
  func scrollPage(pid: pid_t, key: String?, x: Double?, y: Double?, direction: String, pages: Int) throws -> [String: Any] {
    try requireTrusted()
    let start: AXUIElement
    if let key, !key.isEmpty {
      start = try element(forKey: key)
    } else if let x, let y {
      var hit: AXUIElement?
      let status = AXUIElementCopyElementAtPosition(appElement(pid), Float(x), Float(y), &hit)
      guard status == .success, let el = hit else {
        throw HelperError("no_element", "nothing of app \(pid) at \(x),\(y) to find a scrolling area from")
      }
      start = el
    } else {
      throw HelperError("bad_request", "scrollpage needs key or x/y")
    }
    guard let area = scrollAreaFor(start) else {
      // Electron exposes no AXScrollArea at all; the caller falls back to the wheel.
      throw HelperError("no_scroll_area", "no accessibility scrolling area here — this app does not expose one")
    }
    let action = direction == "up" ? "AXScrollDownByPage" : "AXScrollUpByPage"  // inverted: see the header
    let want = max(1, min(pages, MAX_SCROLL_PAGES))

    // Posts nothing, so it marks the way every other accessibility act does.
    markPointer(at: area)

    let before = position(of: area)
    var applied = 0
    var last = before
    for _ in 0..<want {
      _ = AXUIElementPerformAction(area, action as CFString)  // the code lies; displacement does not
      usleep(PAGE_SETTLE_US)
      let now = position(of: area)
      // `applied` counts pages that MOVED, never attempts.
      if let now, let l = last, abs(now.value - l.value) < 0.5 { break }
      applied += 1
      last = now
    }
    let raw = (before?.value).flatMap { b in (last?.value).map { abs($0 - b) } } ?? 0
    let unit = before?.unit ?? "unknown"
    let n = read(area)
    return [
      "applied": applied,
      "moved": raw >= 0.5,
      // A fraction of the document for the bar, points for a frame; the scaling above exists only
      // so one threshold serves both.
      "delta": unit == "bar" ? raw / 10_000 : raw,
      "unit": unit,
      "area": n.desc.isEmpty ? n.role : n.desc,
    ]
  }

  /// The nearest AXScrollArea at or above this element. Bounded: a runaway parent chain is a
  /// broken tree, not something to walk forever.
  private func scrollAreaFor(_ el: AXUIElement) -> AXUIElement? {
    var cur: AXUIElement? = el
    for _ in 0..<24 {
      guard let c = cur else { return nil }
      if (attr(c, kAXRoleAttribute as String) as? String) == "AXScrollArea" { return c }
      guard let p = attr(c, kAXParentAttribute as String), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
      cur = (p as! AXUIElement)
    }
    return nil
  }

  /// Where this area is scrolled to, in whatever unit it will answer in.
  ///
  /// The scrollbar's value is exact and cheap, but SwiftUI exposes NO scroll bar while still
  /// scrolling by page, so the fallback is the y of the first descendant with a real frame.
  private func position(of area: AXUIElement) -> (value: Double, unit: String)? {
    if let bar = attr(area, kAXVerticalScrollBarAttribute as String), CFGetTypeID(bar) == AXUIElementGetTypeID(),
      let v = attr(bar as! AXUIElement, kAXValueAttribute as String) as? Double {
      return (v * 10_000, "bar")  // scaled so the 0.5 threshold means a real move, not rounding
    }
    guard let y = firstFramedDescendantY(area, 0) else { return nil }
    return (y, "px")
  }

  private func firstFramedDescendantY(_ el: AXUIElement, _ depth: Int) -> Double? {
    if depth > 12 { return nil }
    for child in children(el) {
      let f = read(child, contentActions: false).frame
      if !f.isEmpty { return Double(f.origin.y) }
      if let deeper = firstFramedDescendantY(child, depth + 1) { return deeper }
    }
    return nil
  }
}
