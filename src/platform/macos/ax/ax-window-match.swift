// AX windows ↔ the window server's rows: pure geometry, no I/O.
//
// AX has no window id; the window server has CGWindowID, and the two share only the frame. So the
// pairing is by frame and must be ONE-TO-ONE: Chrome opens a new window on top of the previous
// one, and a per-window `rows.first { … }` would give both the same id.
//
// Kept free of AppKit and the window server: `test/macos-window-match.ts` compiles this file alone.
import CoreGraphics
import Foundation

/// The window server and AX describing the same window: frames equal within a point.
func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
  abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
}

/// The same window seen through a chrome inset: every edge within 8 pt, so a window that MOVED
/// never qualifies. Calculator on macOS 26 permanently reports an AX frame up to 7 pt off.
func insetFrame(_ a: CGRect, _ b: CGRect) -> Bool {
  abs(a.minX - b.minX) <= 8 && abs(a.minY - b.minY) <= 8 && abs(a.maxX - b.maxX) <= 8 && abs(a.maxY - b.maxY) <= 8
}

/// One CGWindowID per AX window, in the order given, each row consumed by at most one window;
/// -1 for a window with no row left (minimised, or on another Space).
///
/// Both lists run front-to-back, so the first unused match pairs front with front. Residual: for
/// windows sharing a frame, should the orders disagree, their titles swap ids; both stay reachable.
/// Exact frames are paired first and inset ones from what is left, so a near-twin never takes an
/// exact match's row.
func matchWindowIds(_ frames: [CGRect], _ rows: [(id: Int, frame: CGRect)]) -> [Int] {
  var used = Set<Int>()
  var ids = frames.map { frame -> Int in
    guard let i = rows.indices.first(where: { !used.contains($0) && sameFrame(rows[$0].frame, frame) }) else { return -1 }
    used.insert(i)
    return rows[i].id
  }
  for (k, frame) in frames.enumerated() where ids[k] == -1 {
    guard let i = rows.indices.first(where: { !used.contains($0) && insetFrame(rows[$0].frame, frame) }) else { continue }
    used.insert(i)
    ids[k] = rows[i].id
  }
  return ids
}

/// Which window a pinned CGWindowID means, as an index into the `frames` / `ids` pair above.
///
/// In order: the window that OWNS the id; else the window nearest that row's centre (mid-resize
/// the two frames disagree for a few frames); else an app's single window.
func pickWindowIndex(windowId: Int, ids: [Int], frames: [CGRect], rows: [(id: Int, frame: CGRect)]) -> Int? {
  if let i = ids.firstIndex(of: windowId) { return i }
  if let row = rows.first(where: { $0.id == windowId }) {
    return frames.indices.min { centreDistance(frames[$0], row.frame) < centreDistance(frames[$1], row.frame) }
  }
  return frames.count == 1 ? 0 : nil
}

/// Manhattan distance between two frames' centres — the tie-breaker when no frame matches exactly.
func centreDistance(_ a: CGRect, _ b: CGRect) -> CGFloat {
  abs(a.midX - b.midX) + abs(a.midY - b.midY)
}
