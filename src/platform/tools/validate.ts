/**
 * One schema check, for both places arguments arrive: the TOOL boundary (a model's `computer_repl`
 * call) and the VERB boundary (what the script inside it passes to a driver verb).
 *
 * The verb boundary is why this exists: repl code calls verbs DIRECTLY, so without it an argument
 * the schema forbids reaches the driver and is answered by whatever it happens to mean there
 * (`caret:'end'` silently placed the caret at the START). The wording is for the caller: what
 * failed, where, and for a closed set the values that ARE accepted.
 */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** How many complaints are shown: one is rarely the whole story (a wrong `kind` invalidates
 *  every field of its branch), twenty is unread. */
const MAX_COMPLAINTS = 3;

/** What one failing value produced: its JSON Pointer, and the literals a closed set allows. */
interface Complaint { where: string; message: string; allowed: string[] }

/**
 * Why `params` does not fit `schema`, as a sentence — or null when it fits.
 *
 * `label` names what was called (`computer_repl`, `selectText`), so the sentence stands on its own
 * in a journal line or a thrown error.
 */
export function argComplaint(schema: TSchema, label: string, params: unknown): string | null {
  if (Value.Check(schema, params)) return null;
  const byPath = new Map<string, Complaint>();
  for (const e of Value.Errors(schema, params)) {
    const err = e as { keyword?: string; instancePath?: string; message: string; params?: { allowedValue?: unknown } };
    // `instancePath` is a JSON Pointer into the arguments ("/region/width"); empty at the root.
    const where = String(err.instancePath ?? "");
    const at = byPath.get(where) ?? { where, message: err.message, allowed: [] };
    // A union of literals reports one `const` failure per member: collected, they are the list
    // the caller needs.
    if (err.keyword === "const" && err.params?.allowedValue !== undefined) at.allowed.push(String(err.params.allowedValue));
    else if (!at.allowed.length) at.message = err.message;
    byPath.set(where, at);
    if (byPath.size > MAX_COMPLAINTS) break;
  }
  const said = [...byPath.values()].slice(0, MAX_COMPLAINTS).map((c) => {
    const body = c.allowed.length ? `must be one of ${c.allowed.join(", ")}` : c.message;
    return c.where ? `${c.where}: ${body}` : body;
  });
  return `invalid arguments for ${label} — ${said.join("; ") || "they do not match the schema"}`;
}
