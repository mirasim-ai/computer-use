// The WALK: one window's accessibility tree → the nodes the client lists, under four budgets.
//
// ax-tree.swift holds the engine and its plumbing; this is the traversal. A window can hold more
// nodes than a model can read, and an app can answer slower than a turn can wait, so the walk is
// bounded four ways (nodes visited, wall clock, rows listed, text) and every overflow is COUNTED.
import AppKit
import ApplicationServices
import Foundation

extension AXEngine {
  // MARK: the walk

  /// Four budgets, never one: `maxVisited` and `deadline` bound TIME (every read is an IPC round
  /// trip); what the MODEL reads is bounded SEPARATELY for controls (`maxElements`) and static text
  /// (`maxText`), because text runs vastly outnumber controls in a chat window and a shared budget
  /// pushes the composer and its Send button into the overflow. Past a budget the walk keeps
  /// counting, so the observation can say how much it is not showing.
  private struct Walk {
    let maxVisited: Int
    /// When to stop regardless of the node count: a node costs ~0.06 ms on a healthy app but up to
    /// `AX_TIMEOUT` on one not answering. The count is the backstop for a pathological tree
    /// (Chrome: 873,086 nodes).
    let deadline: CFAbsoluteTime
    let maxElements: Int
    /// Off-screen elements get their OWN budget, so a scrolled-away list cannot eat the rows the
    /// model is shown (see `Snapshot.offscreenElements`).
    let maxOffscreen: Int
    /// How many ADDRESSABLE members of a bulk role may be listed. 100 is two-and-a-bit screens of a
    /// spreadsheet — enough to work in, an order of magnitude short of the ~800 a sheet answers.
    let maxBulk = 100
    let maxText: Int
    let maxDepth: Int
    /// The window's frame: a node with a real frame that does not touch it is off-screen.
    let viewport: CGRect
    var visited = 0
    /// The read budget ran out before the walk finished, and which of the two it was — the client
    /// advises differently: a node count says "narrow the window", a deadline says "the app is slow".
    var capped = false
    var cappedBy = ""

    /// Out of budget: the node count, or the clock. Sets `capped` so the caller only asks once.
    mutating func spent() -> Bool {
      if capped { return true }
      if visited >= maxVisited { capped = true; cappedBy = "nodes" }
      else if CFAbsoluteTimeGetCurrent() >= deadline { capped = true; cappedBy = "time" }
      return capped
    }
    /// Elements found but not listed: outside the window, past `maxElements`, past `maxText`. Text
    /// is counted apart because its way out is the text channel, not a narrower target.
    var offscreen = 0
    /// What is off-screen, LISTED rather than only counted — the rows a name search needs, and
    /// the reason the walk descends past an off-screen node instead of stopping there.
    var offscreenElements: [[String: Any]] = []
    var overflow = 0
    var textOverflow = 0
    /// Listed so far, by budget.
    var controls = 0
    var texts = 0
    /// Information-free structural nodes dropped before the budget saw them (`Node.bare`), counted.
    var folded = 0
    /// Rows spent on the bulk role at some parent — a sheet's cells, a table's rows. Its own budget,
    /// or a wall of them eats the rows the window's own toolbar needs.
    var bulk = 0
    var elements: [[String: Any]] = []

    func result(window: [String: Any], nudged: Bool) -> [String: Any] {
      [
        "window": window, "elements": elements, "visited": visited, "capped": capped, "cappedBy": cappedBy,
        "offscreen": offscreen, "offscreenElements": offscreenElements,
        "overflow": overflow, "textOverflow": textOverflow, "folded": folded, "nudged": nudged,
      ]
    }
  }

  /// How many unaddressable siblings of one role it takes before they are bulk rather than
  /// controls: Excel's sheet answers ~21 per row, every other window measured 0, 1 or 2.
  private static let FOLD_BULK = 8

  /// The only roles bulk folding may touch: table furniture. An allow-list, because Chromium names
  /// a link through a CHILD text node, so folding any unaddressable role would delete a page's links.
  private static let FOLD_ROLES: Set<String> = ["AXCell", "AXRow", "AXColumn"]

  /// Depth-first in the app's own order (the structure the text channel keeps). An off-screen node
  /// is listed apart (`offscreenElements`) and still descended. Off-screen means a frame wholly
  /// outside the window, OR a positioned zero-area frame (Chromium clips nodes scrolled out of their
  /// container to its edge). An all-zero frame means "no geometry" and is walked normally.
  private func walk(_ el: AXUIElement, depth: Int, pid: pid_t, _ w: inout Walk, foldRole: String = "") {
    if w.spent() { return }
    w.visited += 1
    let n = read(el, contentActions: false)
    let clipped = n.frame.isEmpty && n.frame != .zero
    if clipped || (!n.frame.isEmpty && !n.frame.intersects(w.viewport)) {
      if n.included {
        w.offscreen += 1
        // Listed, not merely counted, so `find` can name a row scrolled out of a list.
        if w.offscreenElements.count < w.maxOffscreen {
          w.offscreenElements.append(n.json(key: register(el, pid: pid), seq: w.visited, depth: depth, off: true))
        }
      }
      // And DESCENDED: a scrolled-away row's cells carry the names. It costs little (ChatGPT:
      // 1,966 nodes against 1,946); the visited/deadline budgets still bound it.
      if depth < w.maxDepth {
        for child in children(el) {
          if w.spent() { return }
          walk(child, depth: depth + 1, pid: pid, &w)
        }
      }
      return
    }
    if n.included {
      let isText = n.role == "AXStaticText"
      // Folded BEFORE the budget, or bulk starves the real controls. Its CHILDREN are walked as
      // usual — in a sheet they are the cells that carry an address.
      if !isText, n.bare, n.role == foldRole {
        w.folded += 1
      } else if !isText, n.role == foldRole, w.bulk < w.maxBulk {
        // Addressable but still bulk: listed, charged to the bulk budget.
        w.elements.append(n.json(key: register(el, pid: pid), seq: w.visited, depth: depth))
        w.bulk += 1
      } else if !isText, n.role == foldRole {
        w.overflow += 1
      } else if isText ? w.texts < w.maxText : w.controls < w.maxElements {
        w.elements.append(n.json(key: register(el, pid: pid), seq: w.visited, depth: depth))
        if isText { w.texts += 1 } else { w.controls += 1 }
      } else if isText {
        w.textOverflow += 1
      } else {
        w.overflow += 1
      }
    }
    if depth >= w.maxDepth { return }
    let kids = children(el)
    // A level that establishes its own bulk wins; otherwise the ancestor's carries on: Excel wraps
    // every cell in a one-child cell, so the real cells sit a level below the signal.
    let bulk = bulkRole(kids)
    let pass = bulk.isEmpty ? foldRole : bulk
    for child in kids {
      if w.spent() { return }
      // Once the bulk budget is spent its remaining members are not even READ: Excel's sheet
      // answers ~1.5 ms a node, so reading it all spends the deadline before the ribbon, which
      // comes AFTER the sheet in tree order.
      if !pass.isEmpty, w.bulk >= w.maxBulk, (attr(child, kAXRoleAttribute as String) as? String) == pass {
        w.overflow += 1
        continue
      }
      walk(child, depth: depth + 1, pid: pid, &w, foldRole: pass)
    }
  }

  /// The one role, if any, whose UNADDRESSABLE children are numerous enough here to be bulk. Read
  /// from the parent, where repetition is visible.
  private func bulkRole(_ kids: [AXUIElement]) -> String {
    guard kids.count >= AXEngine.FOLD_BULK else { return "" }
    // ROLE ONLY, never `read` (a batch of nine): a full read here spends the deadline inside
    // Excel's sheet and never reaches the ribbon.
    var counts: [String: Int] = [:]
    for k in kids {
      guard let role = attr(k, kAXRoleAttribute as String) as? String else { continue }
      if AXEngine.FOLD_ROLES.contains(role) { counts[role, default: 0] += 1 }
    }
    // Deterministic (a Dictionary has no order): the densest wins, ties broken by name.
    let over = counts.filter { $0.value >= AXEngine.FOLD_BULK }
    return over.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.first?.key ?? ""
  }

  func tree(pid: pid_t, windowId: Int?, maxVisited: Int, deadlineMs: Int, maxElements: Int, maxOffscreen: Int, maxText: Int, depth: Int)
    throws -> [String: Any]
  {
    var window = try pickWindow(pid: pid, windowId: windowId)
    replaceKeys(pid: pid)
    // The deadline is per WALK, so the nudge's second walk below gets its own.
    let fresh = { (json: [String: Any]) -> Walk in
      Walk(maxVisited: maxVisited, deadline: CFAbsoluteTimeGetCurrent() + Double(deadlineMs) / 1000,
           maxElements: maxElements, maxOffscreen: maxOffscreen, maxText: maxText, maxDepth: depth,
           viewport: windowFrame(json))
    }
    var w = fresh(window.json)
    walk(window.element, depth: 0, pid: pid, &w)
    // Thin tree: nudge Chromium/Electron, wait for it to build the tree, walk again. Only when the
    // set TOOK — a native app refuses it and would otherwise pay this for every small window.
    //
    // Retried on EVERY thin read, not once per pid: VS Code accepts the switch and stays empty far
    // longer than 0.4 s, then fills in later under continued AX traffic. `nudged` lets the client
    // say this window answered the switch and still shows nothing.
    if w.elements.count < 5 {
      guard setManualAccessibility(pid: pid, on: true) else { return w.result(window: window.json, nudged: false) }
      Thread.sleep(forTimeInterval: 0.4)
      window = try pickWindow(pid: pid, windowId: windowId)
      replaceKeys(pid: pid)
      w = fresh(window.json)
      walk(window.element, depth: 0, pid: pid, &w)
      return w.result(window: window.json, nudged: true)
    }
    return w.result(window: window.json, nudged: false)
  }

  /// `AXManualAccessibility` is the Electron/Chromium switch for a full tree. Native apps answer an
  /// error and do not care — the return value says whether it took. Off again through the hidden
  /// `unnudge` op, and for every nudged pid when the helper exits ({@link unnudgeAll}).
  @discardableResult
  func setManualAccessibility(pid: pid_t, on: Bool) -> Bool {
    let status = AXUIElementSetAttributeValue(appElement(pid), "AXManualAccessibility" as CFString, on ? kCFBooleanTrue : kCFBooleanFalse)
    guard status == .success else { return false }
    if on { nudged.insert(pid) } else { nudged.remove(pid) }
    return true
  }

  /// Switch every nudged app back: a full AX tree costs those apps for as long as the flag stays
  /// on, and nothing but this helper knows it was set.
  func unnudgeAll() {
    for pid in nudged { setManualAccessibility(pid: pid, on: false) }
  }

  /// The CGWindowID the tree walk would pick for this pid with no window named (focused → main →
  /// first), so a screenshot with no pinned window photographs the SAME window the tree reads —
  /// nil when AX has no window for it or the window has no window-server row.
  func defaultWindowId(pid: pid_t) -> Int? {
    guard let id = (try? pickWindow(pid: pid, windowId: nil))?.json["id"] as? Int, id >= 0 else { return nil }
    return id
  }

}
