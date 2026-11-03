/**
 * The WAITS every platform gets for free: for text, a control, a URL, the document, and the bare
 * "has it stopped changing". Each polls ONE condition and says whether it held or the budget ran
 * out. Defaults are over reads every platform has; a platform overrides where it can do better
 * (Chromium reads `document.readyState` for {@link waitForLoad}).
 */

import { waitForControlImpl, waitForTextImpl, waitForUrlImpl, waitSettledOverText } from "./driver-wait.ts";
import type { ActResult } from "./types.ts";
import { ComputerUseDriverBase } from "./driver-base.ts";

export abstract class ComputerUseDriverWaits extends ComputerUseDriverBase {
  /** Wait until the surface stops changing (`wait` without `ms`), polling the text.
   *  @see waitSettledOverText */
  async waitSettled(capMs = 16_000): Promise<ActResult> {
    return waitSettledOverText(() => this.readText(), capMs);
  }

  /** Wait for a CONDITION rather than for quiet (`wait {text}` / `{text_gone}`): a spinner that
   * never resolves still settles, and a fixed `ms` misses a value arriving during a lull. The
   * poll and its wording live in driver-wait.ts. */
  async waitForText(needle: string, gone: boolean, capMs = 16_000): Promise<ActResult> {
    return waitForTextImpl(() => this.readTextForWait(), needle, gone, capMs);
  }

  /** The text {@link waitForText} searches, and find's "is it in the TEXT" check on a miss. A
   *  platform whose `text()` reads only a REGION overrides it: presence must not depend on the
   *  region (Chromium: page-text.ts WAIT_TEXT_JS). */
  async readTextForWait(): Promise<string> {
    return this.readText();
  }

  /** The same wait over CONTROLS ("until the Stop button is gone"), which the text poll cannot
   *  say honestly (see driver-wait.ts). Matching rule is `find`'s. */
  async waitForControl(name: string, gone: boolean, capMs = 16_000): Promise<ActResult> {
    return waitForControlImpl(async () => (await this.readElements()).elements, name, gone, capMs);
  }

  /**
   * The same wait over the surface's LOCUS (`Snapshot.url`: page URL, or a stable locus id). A
   * driver that can read its locus cheaply overrides this rather than polling a full walk.
   */
  async waitForUrl(want: string, gone: boolean, capMs = 16_000): Promise<ActResult> {
    return waitForUrlImpl(async () => (await this.readElements()).url, want, gone, capMs);
  }

  /**
   * Wait until the surface finished LOADING. No cross-platform notion of it (an app window is not
   * loading), so the base refuses BY NAME: a silent success would defeat the caller, who asked
   * precisely to tell "not yet" from "nothing there".
   */
  async waitForLoad(_capMs?: number): Promise<ActResult> {
    return { ok: false, note: "this surface has no load state — it is not a document. "
      + "Wait for a control or some text instead (w.wait({control}) / w.wait({text}))" };
  }
}
