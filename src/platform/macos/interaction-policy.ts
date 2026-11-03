/** Driver-controlled effects only: an application's response to AX actions is still its own. */
export const DESKTOP_INPUT_OPS = new Set([
  "mouse", "hover", "drag", "scroll", "activate", "raisewindow", "clipboardstash", "ptrmove", "ptrpress",
]);

export class DesktopInteractionRequired extends Error {
  constructor(operation: string) {
    super(`${operation} requires desktop interaction; this call is background-only. The desktop operation was not dispatched. `
      + "Explain the app and foreground/pointer/focus/clipboard effects, obtain permission, then use interaction:'desktop' for the covered sequence. "
      + "Inspect any preceding AX action before retrying it.");
    this.name = "DesktopInteractionRequired";
  }
}

export function clipboardChord(chord: string): boolean {
  return /(?:\bcmd\b|\bcommand\b|\bmeta\b|⌘)/i.test(chord)
    && /(?:\+|⌘|⇧|⌥|\s)[cxv]$/i.test(chord.trim());
}
