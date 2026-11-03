/** Native errors keep system capture diagnostics separate from Accessibility error codes. */
export type AxErrorCode =
  | "bad_request" | "not_trusted" | "not_granted_screen" | "no_app" | "no_window" | "no_element"
  | "no_scroll_area" | "stale_key" | "ax_error" | "unsupported" | "helper_gone" | "capture_timeout"
  | "capture_service_error" | "background_key_interrupted" | "background_key_unsupported";

export interface CaptureFailure {
  stage: string;
  domain: string;
  code: number;
  helperPid: number;
  screenRecording: boolean;
}

export class AxRequestError extends Error {
  constructor(readonly code: AxErrorCode, message: string, readonly ax?: number,
    readonly postedCount?: number, readonly requestedCount?: number, readonly capture?: CaptureFailure) {
    super(message);
  }
}
