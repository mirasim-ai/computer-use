// Finder's filename editor is a separate transient AX window. The usual app-local
// deactivation after each background key dismisses it between Enter, type and Enter.
// The focused file list and the editor both accept keys directed to Finder's pid.
import AppKit
import ApplicationServices
import Foundation

struct FinderRenameTarget {
  let focus: AXUIElement
  /// Present only on the Enter that opens the editor.
  let selectedName: String?
}

extension AXEngine {
  func finderRenameTarget(pid: pid_t, id: Int, window: AXUIElement, opening: Bool) throws -> FinderRenameTarget? {
    if let editor = finderEditor, editor.pid == pid, editor.window == id {
      let target = FinderRenameTarget(focus: editor.field, selectedName: nil)
      do { try checkFinderRenameTarget(target, pid: pid, window: window) } catch {
        finderEditor = nil
        throw error
      }
      return target
    }
    guard NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.finder",
          let main = attr(appElement(pid), kAXMainWindowAttribute as String), CFEqual(main, window),
          let focus = focusedAXElement(pid: pid)
    else { return nil }
    // A context-menu rename opens the same transient field without sending an Enter.
    // Bind it before the generic activation click can dismiss it, regardless of menu language.
    if isFinderFilenameEditor(focus) {
      finderEditor = (pid, id, focus)
      return FinderRenameTarget(focus: focus, selectedName: nil)
    }
    guard opening, let name = finderSelectedName(focus, in: window) else { return nil }
    return FinderRenameTarget(focus: focus, selectedName: name)
  }

  /// Check again at delivery, including between characters. A selection or focus change must
  /// not redirect a pending rename into a different row, a search field, or another window.
  func checkFinderRenameTarget(_ target: FinderRenameTarget, pid: pid_t, window: AXUIElement) throws {
    guard let main = attr(appElement(pid), kAXMainWindowAttribute as String), CFEqual(main, window),
          let focus = focusedAXElement(pid: pid), CFEqual(focus, target.focus),
          target.selectedName == nil || finderSelectedName(focus, in: window) == target.selectedName else {
      throw HelperError("background_key_interrupted", "the Finder filename selection or editor lost focus; inspect the window before continuing")
    }
  }

  func finishFinderRenameInput(_ target: FinderRenameTarget, pid: pid_t, id: Int, window: AXUIElement, protection: BackgroundKeyGuard) throws {
    guard let selection = target.selectedName else {
      if focusedAXElement(pid: pid).map({ CFEqual($0, target.focus) }) != true { finderEditor = nil }
      return
    }
    finderEditor = nil
    let deadline = ProcessInfo.processInfo.systemUptime + 0.3
    repeat {
      try protection.check()
      guard let main = attr(appElement(pid), kAXMainWindowAttribute as String), CFEqual(main, window) else {
        throw HelperError("background_key_interrupted", "the selected Finder window changed while opening the filename editor")
      }
      if let field = focusedAXElement(pid: pid),
         isFinderFilenameEditor(field),
         attr(field, kAXValueAttribute as String) as? String == selection {
        finderEditor = (pid, id, field)
        return
      }
      usleep(10_000)
    } while ProcessInfo.processInfo.systemUptime < deadline
    throw HelperError("background_key_interrupted", "Finder did not expose a filename editor for the selected item; inspect the window before typing")
  }

  private func isFinderFilenameEditor(_ field: AXUIElement) -> Bool {
    attr(field, kAXRoleAttribute as String) as? String == "AXTextField" &&
      attr(field, "AXIdentifier") as? String == "ShrinkToFit Text Field"
  }

  /// Finder treats text at list focus as type-to-select, even after an editor has closed.
  /// Require a live text receiver even if no editor survived long enough to register.
  func finderTypingField(pid: pid_t) throws -> AXUIElement? {
    guard NSRunningApplication(processIdentifier: pid)?.bundleIdentifier == "com.apple.finder" else { return nil }
    guard let focus = focusedAXElement(pid: pid),
          let role = attr(focus, kAXRoleAttribute as String) as? String,
          ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) else {
      throw HelperError("background_key_interrupted", "the Finder text editor lost focus; locate and focus the intended field before typing")
    }
    return focus
  }

  func checkFinderTypingField(_ field: AXUIElement?, pid: pid_t) throws {
    if let field, focusedAXElement(pid: pid).map({ CFEqual($0, field) }) != true {
      throw HelperError("background_key_interrupted", "the Finder text editor lost focus; locate and focus the intended field before typing")
    }
  }

  private func focusedAXElement(pid: pid_t) -> AXUIElement? {
    guard let value = attr(appElement(pid), kAXFocusedUIElementAttribute as String),
          CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }

  /// Only an actual filename in the single selected row of this window's file list.
  /// Enter in the sidebar, a search field, or another Finder window keeps its own meaning.
  private func finderSelectedName(_ list: AXUIElement, in window: AXUIElement) -> String? {
    guard attr(list, "AXIdentifier") as? String == "ListView",
          let owner = attr(list, kAXWindowAttribute as String), CFEqual(owner, window),
          let rows = attr(list, kAXSelectedRowsAttribute as String) as? [AXUIElement], rows.count == 1 else { return nil }
    for cell in children(rows[0]) {
      for field in children(cell) where attr(field, kAXRoleAttribute as String) as? String == "AXTextField" {
        if let url = attr(field, kAXURLAttribute as String) as? URL, url.isFileURL {
          return attr(field, kAXValueAttribute as String) as? String
        }
      }
    }
    return nil
  }
}
