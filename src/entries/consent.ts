/**
 * The consent question as an MCP elicitation, and what its answer means.
 *
 * The form has ONE field: how long a yes holds. It is there for the client that knows nothing
 * of this server — Claude Code in a terminal shows it as a three-way choice and sends the pick
 * back as ordinary form content — because the other way to say it, `_meta.persist` on the
 * answer, is this server's own extension and only a host written for it sets it. Without the
 * field a plain client can answer nothing but a bare accept, which holds for one call, and its
 * user is asked again on every call.
 *
 * `_meta.persist` wins when both are there: a host that sets it has decided, whatever its form
 * rendering left in the content.
 */

import type { UserConsent } from "../platform/types.ts";

type Answer = Awaited<ReturnType<UserConsent["ask"]>>;
type Persist = NonNullable<Answer["persist"]>;

const LABELS: Record<"once" | Persist, string> = { once: "This call only", session: "This session", always: "Always" };

const isPersist = (v: unknown): v is Persist => v === "session" || v === "always";

interface ConsentForm {
  type: "object";
  properties: Record<string, { type: "string"; title: string; description: string; enum: string[]; enumNames: string[]; default: string }>;
}

/**
 * The elicitation's `requestedSchema`: `persist`, one of `once` and the durations the question
 * offers (`meta.persist`, platform/types.ts). It opens on the session — the answer most people
 * mean by "yes" to an app they just asked the agent to use — and is not required: an accept
 * that leaves it out is for this call.
 */
export function consentForm(meta: Record<string, unknown>): ConsentForm {
  const offered = (Array.isArray(meta.persist) ? meta.persist : []).filter(isPersist);
  if (!offered.length) return { type: "object", properties: {} };
  const values = ["once" as const, ...offered];
  return {
    type: "object",
    properties: {
      persist: {
        type: "string",
        title: "Allow for",
        description: "How long this answer holds",
        enum: values,
        enumNames: values.map((v) => LABELS[v]),
        default: offered.includes("session") ? "session" : "once",
      },
    },
  };
}

/** An elicitation result as the platform's answer. A `mirasim-computer-use/reason` in `_meta`
 *  travels with a non-accept, because "declined" misreports a prompt nobody saw. */
export function consentAnswer(r: { action: string; content?: Record<string, unknown> | null; _meta?: Record<string, unknown> | null }): Answer {
  const reason = r._meta?.["mirasim-computer-use/reason"];
  const allowed = r.action === "accept";
  const persist = allowed ? [r._meta?.persist, r.content?.persist].find(isPersist) : undefined;
  return {
    allowed,
    ...(persist ? { persist } : {}),
    ...(typeof reason === "string" && reason ? { reason } : {}),
  };
}
