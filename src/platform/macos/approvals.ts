/**
 * The "always allow" answers this platform keeps itself — for a host that asks its user but keeps
 * no approvals of its own (a generic MCP client). Codex Computer Use keeps the same thing on the
 * tool side (`ComputerUseAppApprovals.json`, `approvedBundleIdentifiers`), which is why a
 * `persist: "always"` answer outlives the session there and here.
 *
 * A host that DOES keep them (an allow-list in its own settings, say) turns this off with
 * `COMPUTER_USE_MACOS_APPROVALS=""`, so exactly one list decides and removing an app there is the whole of
 * revoking it.
 */

import { ApprovalsStore } from "../approvals-store.ts";

/** The macOS store: bundle ids, compared as written. */
export class MacosApprovals extends ApprovalsStore {
  constructor(env: NodeJS.ProcessEnv) {
    super(env, { variable: "COMPUTER_USE_MACOS_APPROVALS", fileName: "macos-approvals.json", field: "approvedBundleIdentifiers" });
  }
}
