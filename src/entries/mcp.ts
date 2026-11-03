/**
 * MCP stdio server — computer-use's ONLY runtime. The host's own agent loop drives our tools;
 * there is no model or loop on this side. Platforms come from env (COMPUTER_USE_PLATFORMS),
 * surface targeting from the platform env knobs
 * (COMPUTER_USE_PROFILE_DIR / COMPUTER_USE_CDP_URL / COMPUTER_USE_ELECTRON_CDP_URL) — so a host
 * keys one child per surface, and refs stay valid between an observe and the act that uses them.
 * Whether a macOS app may be driven is asked back over the same link ({@link consentChannel}).
 *
 * Uses the low-level Server (not McpServer) so TypeBox schemas — plain JSON Schema — pass
 * through without a zod duplicate.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { resolveProfile, type Profile } from "../platform/profile.ts";
import { SurfaceGoneError, type UserConsent } from "../platform/types.ts";
import { ownVersion } from "./version.ts";
import { PreviewService, type TargetRef } from "../platform/preview.ts";

/**
 * One JSON line per tool call to COMPUTER_USE_MCP_LOG, off unless the knob is set — the only
 * per-call record this path leaves (stdout is protocol-only, `details` is dropped here).
 *
 * Appended synchronously: a driving script often kills the server, and a buffered stream would
 * lose exactly the tail being debugged. Best-effort — a failed write never fails the call.
 */
function callLogger(): (entry: Record<string, unknown>) => void {
  const file = process.env.COMPUTER_USE_MCP_LOG?.trim();
  if (!file) return () => {};
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch { /* the append below will fail too, and stay silent */ }
  return (entry) => {
    try {
      appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    } catch { /* observing the surface must not break it */ }
  };
}

/** The one operational rule no observation restates at runtime (observations carry the rest). */
const VERBATIM_RULE =
  "Copy literal values verbatim when filling forms. Never guess or invent URLs, ids, or names.";

/**
 * What an MCP host cannot learn anywhere else: the addressing model (ref or x/y, viewport-clipped
 * lists, ref lifetime), sent once as the initialize result's `instructions` since the host never
 * sees a system prompt of ours. Deliberately just the drivers' grounding plus
 * {@link VERBATIM_RULE}: every host pays for it on every session.
 */
function instructions(profile: Profile): string {
  // One grounding per MOUNTED platform: a macOS observation is not a web page's.
  const grounding = [...new Set(profile.drivers.map((d) => d.promptFragment()))];
  return `${grounding.join("\n\n")}\n\n${VERBATIM_RULE}`;
}

/** The host takes clearances back with this notification: `{ ids: string[] }` (macOS bundle ids). */
const REVOKE_METHOD = "notifications/mirasim-computer-use/revoke";

/**
 * The live-preview extension (docs/embedding.md → "Live preview"). A client turns it on by
 * declaring `capabilities.experimental["mirasim-computer-use/preview"]` at initialize; one that
 * does not gets no preview work at all.
 */
const PREVIEW_EXTENSION = "mirasim-computer-use/preview";
const PREVIEW_WATCH = `${PREVIEW_EXTENSION}/watch`;
/** A frame waits for no one: while this much output is still queued for the client, a new frame
 *  is dropped, so a tool result is never stuck behind video. */
const FRAME_BACKLOG_MAX = 4 * 1024 * 1024;

/** How long one question may wait on its person. Longer than any host's own dialog timeout, so the
 *  HOST decides when nobody answered and says so, rather than this side cutting it short. */
const ASK_TIMEOUT_MS = 15 * 60_000;

/**
 * The platform's way to ask the user, over MCP elicitation: the tool asks, the HOST decides how
 * to put it to its person and where "always" is kept. Without client elicitation support the
 * platform falls back to its static list (macos/driver.ts).
 *
 * An empty form, so `accept` IS the yes; `_meta.persist` (`session` | `always`) says how long it
 * holds — absent, this one action. A host's `_meta` `mirasim-computer-use/reason` travels with a
 * non-accept, because "declined" misreports a prompt nobody saw.
 */
function consentChannel(): { consent: UserConsent; attach: (server: Server) => void } {
  // Late-bound: the profile must exist before the server (its `instructions` are read off the
  // profile); a question only ever comes from inside a tool call, after the server is up.
  let server: Server | null = null;
  const revokes: Array<(ids: string[]) => void> = [];
  return {
    consent: {
      available: () => server?.getClientCapabilities()?.elicitation?.form !== undefined,
      ask: async (message, meta) => {
        const r = await server!.elicitInput(
          { mode: "form", message, requestedSchema: { type: "object", properties: {} }, _meta: meta },
          { timeout: ASK_TIMEOUT_MS },
        );
        const m = r._meta as Record<string, unknown> | undefined;
        const reason = m?.["mirasim-computer-use/reason"];
        const persist = m?.persist === "session" || m?.persist === "always" ? m.persist : undefined;
        return {
          allowed: r.action === "accept",
          ...(persist ? { persist } : {}),
          ...(typeof reason === "string" && reason ? { reason } : {}),
        };
      },
      onRevoke: (cb) => { revokes.push(cb); },
    },
    attach: (s) => {
      server = s;
      s.fallbackNotificationHandler = async (n) => {
        if (n.method !== REVOKE_METHOD) return;
        const ids = (n.params as { ids?: unknown } | undefined)?.ids;
        if (Array.isArray(ids)) for (const cb of revokes) cb(ids.filter((v): v is string => typeof v === "string"));
      };
    },
  };
}

export async function serveMcp(): Promise<void> {
  const channel = consentChannel();
  // Diagnostics are on BY DEFAULT (COMPUTER_USE_DIAGNOSTICS=0 opts out): an MCP host is a coding agent —
  // the one caller that can read the source a console error points at.
  const profile = resolveProfile({ diagnostics: process.env.COMPUTER_USE_DIAGNOSTICS !== "0", consent: channel.consent });
  const tools = profile.tools;
  const log = callLogger();
  // `turn_ended` is a host lifecycle hook (Codex's shape), not a model tool: managed hosts may end
  // a turn; clients that never send it keep computer_repl's persistent behavior.
  const endedTurns = new Set<string>();

  const server: Server = new Server(
    { name: "mirasim-cu", version: ownVersion() },
    { capabilities: { tools: {}, experimental: { [PREVIEW_EXTENSION]: { version: 1 } } },
      instructions: instructions(profile) },
  );
  channel.attach(server);

  const notify = (method: string, params: Record<string, unknown>): void => {
    void server.notification({ method: `notifications/${PREVIEW_EXTENSION}/${method}`, params }).catch(() => {});
  };
  let preview: PreviewService | null = null;
  server.oninitialized = () => {
    if (!server.getClientCapabilities()?.experimental?.[PREVIEW_EXTENSION]) return;
    const service = new PreviewService({
      targets: (targets) => notify("targets", { targets }),
      frame: (ref, frame) => { if (process.stdout.writableLength < FRAME_BACKLOG_MAX) notify("frame", { ...ref, ...frame }); },
      status: (ref, status) => notify("status", { ...ref, ...status }),
    });
    for (const driver of profile.drivers) driver.onPreview = (target, at) => service.publish(target, at);
    channel.consent.onRevoke((apps) => service.revoke(apps));
    preview = service;
  };
  server.fallbackRequestHandler = async (req) => {
    if (req.method !== PREVIEW_WATCH || !preview) throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${req.method}`);
    const p = (req.params ?? {}) as { targets?: unknown; maxSize?: unknown };
    const refs = (Array.isArray(p.targets) ? p.targets : []).flatMap((t): TargetRef[] => {
      const r = t as { kind?: unknown; targetId?: unknown };
      return (r.kind === "browser" || r.kind === "electron" || r.kind === "macos") && typeof r.targetId === "string"
        ? [{ kind: r.kind, targetId: r.targetId }] : [];
    });
    preview.watch(refs, typeof p.maxSize === "number" ? p.maxSize : undefined);
    return {};
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters as unknown as { type: "object" },
    })),
  }));

  let endingTurn = false;
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const started = Date.now();
    const args = req.params.arguments ?? {};
    if (endingTurn) return { content: [{ type: "text" as const, text: "Turn cleanup is in progress; no new operation was started. Rebind after cleanup." }], isError: true };
    const previewTask = req.params._meta?.['mirasim-computer-use/previewTask'];
    if (req.params.name !== 'turn_ended') preview?.setTaskId(typeof previewTask === 'string' ? previewTask : null);
    if (req.params.name === "turn_ended") {
      const p = args as Record<string, unknown>;
      const sessionId = typeof p.session_id === "string" ? p.session_id : "";
      const turnId = typeof p.turn_id === "string" ? p.turn_id : "";
      const hook = typeof p.hook_event_name === "string" ? p.hook_event_name : "turn_ended";
      const keepBrowserTabs = p.keep_browser_tabs === true;
      if (!sessionId || !turnId) {
        return { content: [{ type: "text" as const, text: "turn_ended needs session_id and turn_id" }], isError: true };
      }
      const key = `${sessionId}\0${turnId}`;
      if (endedTurns.has(key)) return { content: [{ type: "text" as const, text: "turn_ended already applied" }] };
      const reset = tools.find((t) => t.name === "computer_repl_reset");
      endingTurn = true;
      try {
        // Reset the resident JS state, let the platform clean only its own resources, then
        // disconnect the driver. User-owned apps/tabs are never closed by this edge.
        await reset?.execute({ waitForIdle: true });
        for (const driver of profile.drivers) {
          await driver.turnEnded({ sessionId, turnId, hookEventName: hook, keepBrowserTabs });
          await driver.close();
        }
        endedTurns.add(key);
        if (endedTurns.size > 512) endedTurns.delete(endedTurns.values().next().value as string);
        log({ type: "turn_ended", session_id: sessionId, turn_id: turnId, hook_event_name: hook, keep_browser_tabs: keepBrowserTabs });
        return { content: [{ type: "text" as const, text: `turn_ended applied (${hook})` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `turn_ended failed: ${(e as Error).message}` }], isError: true };
      } finally {
        endingTurn = false;
      }
    }
    const wanted = req.params.name;
    const tool = tools.find((t) => t.name === wanted);
    if (!tool) {
      log({ type: "call", tool: req.params.name, args, isError: true, ms: 0, details: { error: "unknown_tool" } });
      return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      const r = await tool.execute(args);
      log({ type: "call", tool: tool.name, args, isError: typeof r.details.error === "string", ms: Date.now() - started, details: r.details });
      return {
        content: r.content.map((c) =>
          c.type === "image" ? { type: "image" as const, data: c.data, mimeType: c.mimeType } : { type: "text" as const, text: c.text },
        ),
        // Tool-declared failures (bad ref, act_failed…) surface as isError so a host that
        // only reads the flag still branches right; the text already carries the reason.
        ...(typeof r.details.error === "string" ? { isError: true } : {}),
      };
    } catch (e) {
      log({
        type: "call", tool: tool.name, args, isError: true, ms: Date.now() - started,
        details: { error: (e as Error).message, ...(e instanceof SurfaceGoneError ? { surfaceGone: true } : {}) },
      });
      // A GONE surface is a stop, not a retry: say so explicitly so the driving loop halts
      // instead of re-observing a browser window the user deliberately closed.
      const stop = e instanceof SurfaceGoneError
        ? " The surface is gone (window closed / device detached) — stop; do not retry or recreate it."
        : "";
      return { content: [{ type: "text", text: `error: ${(e as Error).message}${stop}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  /**
   * Every way this server is ended. An MCP client closes stdin or sends SIGTERM (not SIGINT);
   * unhandled, SIGTERM exits 143 with nothing of ours run, and an ended stdin skips the driver
   * close. Both exit 0 through the teardown here, which owes the disconnect and, on the MANAGED
   * browser, `journal.drain()` (the last action's evidence shot).
   *
   * stdin needs our own (additive) listener: the SDK's stdio transport subscribes to `data` and
   * `error` only, so an ended stdin never reaches `transport.onclose`.
   *
   * Idempotent: a host that SIGTERMs also closes the pipe, and the second call must not race a
   * teardown already under way.
   */
  let ending: Promise<void> | null = null;
  const shutdown = (code: number): void => {
    endingTurn = true;
    ending ??= (async () => {
      // Never release a claim while a previously dispatched operation is still draining.
      try { await tools.find((t) => t.name === "computer_repl_reset")?.execute({ waitForIdle: true }); }
      catch { /* Claims left behind are reclaimed once this process and its helpers have exited. */ }
      preview?.close();
      await Promise.all(profile.drivers.map((d) => d.close().catch(() => {})));
    })();
    void ending.then(() => process.exit(code));
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  const disconnected = (): void => shutdown(0);
  server.onclose = disconnected;
  process.stdin.on("end", disconnected);
  process.stdin.on("close", disconnected);
  // Logged first: calls are only readable against the configuration that produced them.
  const platforms = profile.drivers.map((d) => d.platform).join(",");
  log({ type: "server_start", version: ownVersion(), platforms, tools: tools.map((t) => t.name) });
  console.error(`mirasim-cu MCP server on stdio (platforms=${platforms})`);
}
