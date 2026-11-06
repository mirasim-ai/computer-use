/** Assemble the tools for one or more drivers. Written once — every platform
 * gets identical tool names, schemas, and wording by construction. */

import { SurfaceGoneError, SurfaceUnreadableError, spec, text, type ComputerUseToolSpec } from "../types.ts";
import { withoutBlankOptionals } from "./normalize.ts";
import { createReplTools, type PlatformSlice } from "./repl.ts";
import { argComplaint } from "./validate.ts";
import type { OwnershipProvider } from '../ownership.ts';

/**
 * Turn a vanished surface into an honest tool ANSWER rather than a thrown rejection: the model
 * must read "the browser is closed, stop" and end the task.
 *
 * The same wrapper SERIALIZES every call across the toolset: the agent loop may run one turn's
 * calls concurrently, but a GUI has one focus and one pointer — concurrent set_texts interleave
 * their focus+insertText halves into whichever field grabbed focus last, and a concurrent
 * observe reads mid-action state. The chain keeps arrival order; a failed call must never wedge
 * the ones behind it.
 *
 * It also drops blank optionals (normalize.ts) and THEN validates against the tool's schema. That
 * order is load-bearing: validating first would reject a call for blanks about to be deleted.
 */
function guarded(s: ComputerUseToolSpec, chain: { p: Promise<void>; epoch: number }): ComputerUseToolSpec {
  const inner = s.execute.bind(s);
  return spec({
    ...s,
    async execute(params: unknown) {
      const epoch = chain.epoch;
      const run = chain.p.then(async () => {
        if (epoch !== chain.epoch) return text("This queued call was cancelled by a runtime reset; bind fresh handles before continuing.", { error: "runtime_reset" });
        const cleaned = withoutBlankOptionals(params, s.parameters);
        const invalid = argComplaint(s.parameters, s.name, cleaned);
        if (invalid) return text(invalid, { error: "bad_arguments" });
        try {
          return await inner(cleaned);
        } catch (e) {
          if (e instanceof SurfaceGoneError) return text(e.message, { error: "surface_gone" });
          // The surface is readable again later (a locked screen, an off-screen window): the
          // reason is the answer, not a tool exception.
          if (e instanceof SurfaceUnreadableError) return text(e.message, { error: "surface_unreadable" });
          throw e;
        }
      });
      chain.p = run.then(() => {}, () => {});
      return run;
    },
  });
}

/**
 * The tool set a SESSION registers — `computer_repl` and `computer_repl_reset`, and nothing else.
 * The reset bypasses `guarded`: it must work while a call is wedged, and touches no surface.
 */
export function createComputerUseTools(
  mounted: PlatformSlice | PlatformSlice[],
  opts: { diagnostics?: boolean; docsDelivered?: boolean; ownership?: OwnershipProvider; idleReleaseMs?: number } = {},
): ComputerUseToolSpec[] {
  const slices = Array.isArray(mounted) ? mounted : [mounted];
  for (const { driver } of slices) {
    // Diagnostics ride the repl's diagnostics() read, opt-in per session — and only where the
    // platform can actually feed the channel, so a driver without a source never advertises one.
    if (opts.diagnostics && driver.supportsDiagnostics) driver.enableDiagnostics();
  }
  const [repl, reset] = createReplTools(slices, { docsDelivered: opts.docsDelivered, ownership: opts.ownership, idleReleaseMs: opts.idleReleaseMs });
  const chain = { p: Promise.resolve(), epoch: 0 };
  const resetRuntime = reset.execute.bind(reset);
  reset.execute = async params => { chain.epoch++; return resetRuntime(params); };
  return [guarded(repl, chain), reset];
}
