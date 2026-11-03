// Evidence for typed input: bind read-back to the field and UTF-16 selection that existed
// immediately before the first event. Background callers capture after making their window key.
import ApplicationServices
import Foundation

extension AXEngine {
  func typeSnapshot(pid: pid_t) -> [String: Any] {
    let app = appElement(pid)
    guard let focused = attr(app, kAXFocusedUIElementAttribute as String),
          CFGetTypeID(focused) == AXUIElementGetTypeID() else { return [:] }
    let element = focused as! AXUIElement
    var snapshot: [String: Any] = ["typedKey": register(element, pid: pid)]
    if let value = attr(element, kAXValueAttribute as String) as? String {
      snapshot["typedValue"] = value
    }
    if let selection = attr(element, kAXSelectedTextRangeAttribute as String),
       CFGetTypeID(selection) == AXValueGetTypeID() {
      let value = selection as! AXValue
      var range = CFRange()
      if AXValueGetType(value) == .cfRange, AXValueGetValue(value, .cfRange, &range) {
        snapshot["typedRange"] = ["start": range.location, "length": range.length]
      }
    }
    // A focus change during the AX reads invalidates the baseline. Do not guess a new target.
    guard let current = attr(app, kAXFocusedUIElementAttribute as String),
          CFEqual(current, element) else { return [:] }
    return snapshot
  }

  /// Strict read for verification: absent/unsupported/non-string AXValue is not empty text.
  func textValue(key: String) throws -> String? {
    attr(try element(forKey: key), kAXValueAttribute as String) as? String
  }

  /// Foreground and remote-panel delivery share the same evidence as background typing.
  func typeInput(pid: pid_t, text: String) throws -> [String: Any] {
    try requireTrusted()
    try requirePostEvents()
    var result = typeSnapshot(pid: pid)
    var posted = 0
    do {
      for character in text {
        try typeText(pid: pid, text: String(character))
        posted += 1
      }
    } catch {
      let error = error as? HelperError ?? HelperError("ax_error", error.localizedDescription)
      throw HelperError(error.code, "\(posted) of \(text.count) characters were posted before interruption. \(error.message)",
                        ax: error.ax, postedCount: posted, requestedCount: text.count)
    }
    result["postedCount"] = posted
    result["requestedCount"] = text.count
    result["unit"] = "characters"
    return result
  }
}
