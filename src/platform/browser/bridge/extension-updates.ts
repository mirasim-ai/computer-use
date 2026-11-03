/** Runtime compatibility and reload scheduling. A quiet socket is not an idle agent task. */
export interface ExtensionRuntimeInfo {
  id: string;
  version: string;
  build: string | null;
  protocol: number;
  capabilities: string[];
}

export function parseExtensionRuntime(value: unknown): ExtensionRuntimeInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^[a-p]{32}$/.test(v.id)
    || typeof v.version !== "string" || !/^\d+(\.\d+){0,3}$/.test(v.version)
    || !Number.isInteger(v.protocol) || !Array.isArray(v.capabilities)) return null;
  return { id: v.id, version: v.version, build: typeof v.build === "string" ? v.build : null,
    protocol: v.protocol as number, capabilities: v.capabilities.filter((c): c is string => typeof c === "string") };
}

function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export class ExtensionUpdates {
  runtime: ExtensionRuntimeInfo | null = null;
  updateVersion: string | null = null;
  pending = false;
  reloading = false;
  error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private readonly expected: { version: string; version_name?: string },
    private readonly busy: () => boolean, private readonly reload: () => Promise<unknown>) {}

  status(connected: boolean) {
    const r = this.runtime;
    const order = r ? compareVersions(r.version, this.expected.version) : 0;
    const compatibility = !connected ? 'unknown'
      : r && r.protocol > 1 ? 'app-update-required'
      : order < 0 ? 'update-required'
      : !r || r.protocol !== 1 || !['discarded-tabs', 'safe-reload'].every((c) => r.capabilities.includes(c))
        || (order === 0 && r.build && this.expected.version_name && r.build !== this.expected.version_name) ? 'reload-required' : 'ready';
    return { version: r?.version ?? null, expectedVersion: this.expected.version, compatibility,
      canReload: !!r?.capabilities.includes('safe-reload'), updateVersion: this.updateVersion,
      reloadPending: this.pending || this.reloading, error: this.error };
  }

  request(): void {
    if (!this.runtime?.capabilities.includes('safe-reload')) throw new Error('Reload the Mirasim extension from your browser’s extensions page, then check its connection again.');
    this.pending = true;
    this.error = null;
    this.schedule();
  }

  schedule(): void {
    if (!this.pending || this.reloading || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.busy()) { this.schedule(); return; }
      // Close admission BEFORE sending the command: no new client may race the reload.
      this.reloading = true;
      this.pending = false;
      const generation = this.generation;
      void this.reload().then(() => {
        if (generation !== this.generation) return;
        this.reconnectTimer = setTimeout(() => {
          this.reloading = false;
          this.error = 'The Mirasim extension did not reconnect after reloading. Check its extension page and that the browser bridge is running.';
        }, 15_000);
        this.reconnectTimer.unref();
      }).catch((e) => {
        if (generation !== this.generation) return;
        this.reloading = false;
        this.error = e instanceof Error ? e.message : String(e);
      });
    }, 250);
    this.timer.unref();
  }

  reset(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.timer = null;
    this.runtime = null;
    this.updateVersion = null;
    this.pending = false;
    this.reloading = false;
    this.error = null;
  }
}
