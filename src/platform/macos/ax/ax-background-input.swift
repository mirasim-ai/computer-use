// One resident routing tap, with a request-scoped target. Rebuilding is allowed only before a
// new operation; a disabled tap interrupts the current operation and never replays its input.
import AppKit
import ApplicationServices
import Foundation

final class BackgroundKeyGuard {
  static let shared = BackgroundKeyGuard()
  private var target: (pid: pid_t, front: pid_t)?
  private let lock = NSLock()
  private var tap: CFMachPort?
  private var tapSource: CFRunLoopSource?
  private var loop: CFRunLoop?
  private var startingLoop = false
  private let loopReady = DispatchSemaphore(value: 0)
  private var failure: String?
  private var returnedInput = false

  func start(pid: pid_t, front: pid_t) throws {
    lock.lock()
    target = (pid, front)
    failure = nil
    returnedInput = false
    let startLoop = loop == nil && !startingLoop
    if startLoop { startingLoop = true }
    let existingLoop = loop
    lock.unlock()
    if startLoop {
      Thread.detachNewThread {
        // Keep the loop alive even if a tap was invalidated and must be replaced.
        var context = CFRunLoopSourceContext()
        context.perform = { _ in }
        let keeper = CFRunLoopSourceCreate(kCFAllocatorDefault, 0, &context)!
        CFRunLoopAddSource(CFRunLoopGetCurrent(), keeper, .commonModes)
        self.lock.lock(); self.loop = CFRunLoopGetCurrent(); self.lock.unlock()
        self.loopReady.signal()
        CFRunLoopRun()
      }
    }
    if existingLoop == nil && loopReady.wait(timeout: .now() + 1) != .success {
      stop()
      throw HelperError("background_key_unsupported", "input protection did not start within 1 second; no input was posted")
    }
    lock.lock(); let activeLoop = loop!; lock.unlock()
    let ready = DispatchSemaphore(value: 0)
    CFRunLoopPerformBlock(activeLoop, CFRunLoopMode.defaultMode.rawValue) {
      self.installOrEnableTap()
      ready.signal()
    }
    CFRunLoopWakeUp(activeLoop)
    guard ready.wait(timeout: .now() + 1) == .success else {
      stop()
      throw HelperError("background_key_unsupported", "input protection did not become ready within 1 second; no input was posted")
    }
    do { try check() } catch { stop(); throw error }
  }

  /// Runs on the tap's own thread. A healthy tap is reused, a disabled one is enabled, and an
  /// invalid port is replaced. Accessibility/Post Events were checked by the operation first.
  private func installOrEnableTap() {
    lock.lock(); let oldTap = tap; let oldSource = tapSource; lock.unlock()
    if let oldTap, CFMachPortIsValid(oldTap) {
      if !CGEvent.tapIsEnabled(tap: oldTap) { CGEvent.tapEnable(tap: oldTap, enable: true) }
      if CGEvent.tapIsEnabled(tap: oldTap) { return }
    }
    if let oldSource { CFRunLoopRemoveSource(CFRunLoopGetCurrent(), oldSource, .commonModes) }
    if let oldTap { CFMachPortInvalidate(oldTap) }
    let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
    let context = Unmanaged.passUnretained(self).toOpaque()
    let newTap = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap,
      options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, info in
        let state = Unmanaged<BackgroundKeyGuard>.fromOpaque(info!).takeUnretainedValue()
        return state.filter(type, event)
      }, userInfo: context)
    let source = newTap.flatMap { CFMachPortCreateRunLoopSource(kCFAllocatorDefault, $0, 0) }
    lock.lock(); tap = newTap; tapSource = source; lock.unlock()
    guard let newTap, let source else { cancel("the input protection tap could not be installed"); return }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
    CGEvent.tapEnable(tap: newTap, enable: true)
  }

  private func cancel(_ reason: String) {
    lock.lock(); failure = failure ?? reason; lock.unlock()
  }

  private func filter(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      cancel("the input protection tap was disabled")
      return Unmanaged.passUnretained(event)
    }
    lock.lock(); let current = target; lock.unlock()
    guard let current, event.getIntegerValueField(.eventSourceUnixProcessID) == 0 else {
      return Unmanaged.passUnretained(event)
    }
    let (pid, front) = current
    if type == .leftMouseDown || type == .rightMouseDown {
      cancel("the user clicked while background input was being prepared")
      return Unmanaged.passUnretained(event)
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != front {
      cancel("the foreground app changed while background input was running")
      return Unmanaged.passUnretained(event)
    }
    if event.getIntegerValueField(.eventTargetUnixProcessID) == Int64(pid) {
      cancel("a real key was routed to the background app; it was returned to the foreground app")
      lock.lock(); returnedInput = true; lock.unlock()
      guard let copy = event.copy() else { return nil }
      copy.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(ProcessInfo.processInfo.processIdentifier))
      copy.postToPid(front)
      return nil
    }
    return Unmanaged.passUnretained(event)
  }

  func check() throws {
    lock.lock()
    let reason = failure
    let front = target?.front
    let activeTap = tap
    lock.unlock()
    if let reason { throw HelperError("background_key_interrupted", reason + "; observe before retrying") }
    guard let front, let activeTap, CFMachPortIsValid(activeTap), CGEvent.tapIsEnabled(tap: activeTap),
          NSWorkspace.shared.frontmostApplication?.processIdentifier == front, !screenLocked() else {
      throw HelperError("background_key_interrupted", "input protection or the foreground changed; observe before retrying")
    }
  }

  func stop() {
    // Per-operation tap installation lost key-downs in the typing probe. Leave the healthy tap
    // resident; without a target it passes every event through and records no input.
    lock.lock(); target = nil; lock.unlock()
  }

  func repairForegroundFocus() {
    lock.lock(); let repair = returnedInput; let front = target?.front; lock.unlock()
    if repair, let front, NSWorkspace.shared.frontmostApplication?.processIdentifier == front {
      NSRunningApplication(processIdentifier: front)?.activate(options: [])
    }
  }
}
