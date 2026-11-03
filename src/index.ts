/** Library surface, for TypeScript consumers that drive the platform in-process instead of
 *  spawning `mirasim-cu mcp`. There is no agent behind it: computer-use is an MCP server over these drivers. */

export {
  TOOL_NAMES,
  type ActResult,
  type Element,
  type ComputerUseToolSpec,
  type HeaderChanges,
  type ObservationCoverage,
  type OwnershipResource,
  type Snapshot,
  type SnapshotCapture,
  type TargetInfo,
  type TargetIdentity,
  type ToolResult,
  type VerbSpec,
  type Verdict,
} from "./platform/types.ts";
export { ComputerUseDriver } from "./platform/driver.ts";
export { createComputerUseTools } from "./platform/tools/index.ts";
export { createReplTools } from "./platform/tools/repl.ts";
export { resolveProfile, type Profile, type ProfileOptions } from "./platform/profile.ts";
export type { OwnershipProvider } from "./platform/ownership.ts";
export type { BrowserConfig, BrowserConfigOptions } from "./platform/browser/config.ts";
export { BrowserDriver } from "./platform/browser/driver.ts";
export { BridgeServer, type BridgeServerOptions } from "./platform/browser/bridge/server.ts";
export { MIRASIM_EXTENSION_ID, extensionDir, extensionIdFromKey } from "./platform/browser/bridge/extension-id.ts";
export { MacosDriver } from "./platform/macos/driver.ts";
