/** A postcondition is a read, never a replay of the action it checks. */
import type { ComputerUseDriver } from "../driver.ts";
import { options, type RunLedger } from "./api-contract.ts";

export function expectVerb(
  driver: ComputerUseDriver,
  ledger: () => RunLedger,
  value: (target: unknown) => Promise<string>,
) {
  return async (raw: unknown) => {
    const opts = options<Record<string, unknown>>("expect", raw,
      "expect({text:'Saved', ms:3000}) or expect({value:field, equals:'draft', ms:3000})");
    const allowed = new Set(["text", "control", "url", "value", "equals", "ms"]);
    if (Object.keys(opts).some(k => !allowed.has(k))) throw new Error("expect received an unknown option");
    const conditions = ["text", "control", "url", "value"].filter(k => opts[k] !== undefined);
    if (conditions.length !== 1) throw new Error("expect needs exactly one of text, control, url, or value");
    const kind = conditions[0]!;
    if (kind === "value" ? typeof opts.equals !== "string" : typeof opts[kind] !== "string" || !opts[kind]) {
      throw new Error("expect needs a nonempty condition string, or a value target with equals:string");
    }
    if (opts.ms !== undefined && (typeof opts.ms !== "number" || !Number.isFinite(opts.ms) || opts.ms < 0 || opts.ms > 16_000)) {
      throw new Error("expect ms must be between 0 and 16000");
    }
    const cap = Number(opts.ms ?? 3000);
    ledger().charge("expect");
    driver.noteContentRead();
    const label = kind === "value" ? "field value" : `${kind} ${JSON.stringify(opts[kind])}`;
    let ok = false;
    try {
      if (kind === "value") {
        const deadline = Date.now() + cap;
        do {
          // Read-only polling, with a ceiling even if the underlying read stops responding.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const remaining = Math.max(1, deadline - Date.now());
            const actual = await Promise.race([value(opts.value), new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("value read timed out")), remaining);
            })]);
            if (driver.valueMatches(actual, opts.equals as string)) { ok = true; break; }
          } finally { clearTimeout(timer); }
          if (Date.now() >= deadline) break;
          await new Promise(r => setTimeout(r, Math.min(100, deadline - Date.now())));
        } while (Date.now() <= deadline);
      } else {
        const condition = String(opts[kind]);
        const result = kind === "text" ? await driver.waitForText(condition, false, cap)
          : kind === "control" ? await driver.waitForControl(condition, false, cap)
            : await driver.waitForUrl(condition, false, cap);
        ok = result.ok;
      }
    } catch (e) {
      ledger().push("expect", label, false, `verification unavailable: ${(e as Error).message}; do not replay the preceding action`, true, "uncertain");
      throw e;
    }
    ledger().push("expect", label, ok, ok ? "condition verified" : "condition was not verified; subsequent steps stopped, preceding action was not replayed", true, ok ? "verified" : "uncertain");
    if (!ok) throw new Error(`Expectation failed for ${label}. Observe the result before deciding whether any earlier action can be retried.`);
    return true;
  };
}
