/** Types shared by the persistent REPL and its tool boundary. Kept separate so the REPL's
 * execution/lifecycle module stays within the source read budget. */
import type { ComputerUseDriver } from "../driver.ts";
import type { TargetInfo } from "../types.ts";

export interface PlatformSlice {
  driver: ComputerUseDriver;
}

export interface Slice extends PlatformSlice {
  id: string;
  api: Record<string, unknown>;
  docsDue: boolean;
  lastMiss: string | null;
}

export type SurfaceHandle = Record<string, unknown> & {
  id: string;
  kind: string;
  title: string;
  own?: boolean;
};

export type MountedTarget = TargetInfo & { slice: Slice; inner: string };
