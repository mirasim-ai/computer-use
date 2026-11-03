// A ScreenCaptureKit rejection after an allowed preflight is not proof that the user denied it.
import CoreGraphics
import Foundation

struct CaptureFailure {
  let stage: String
  let domain: String
  let code: Int
  let helperPid: Int
  let screenRecording: Bool
  var json: [String: Any] {
    ["stage": stage, "domain": domain, "code": code, "helperPid": helperPid, "screenRecording": screenRecording]
  }
}

func captureFailure(_ error: Error, stage: String) -> HelperError {
  if let error = error as? HelperError { return error }
  let native = error as NSError
  let granted = CGPreflightScreenCaptureAccess()
  let details = CaptureFailure(stage: stage, domain: native.domain, code: native.code,
    helperPid: Int(ProcessInfo.processInfo.processIdentifier), screenRecording: granted)
  return HelperError(granted ? "capture_service_error" : "not_granted_screen",
    granted
      ? "macOS capture failed during \(stage) although Screen Recording preflight is granted (\(native.domain) \(native.code), helper \(details.helperPid)): \(native.localizedDescription)"
      : "Screen Recording is not granted for this capture process (\(native.domain) \(native.code), helper \(details.helperPid)).",
    capture: details)
}
