/** Live contexts of one debugger session. Keeping a snapshot, rather than an event
 *  history, lets navigation and destruction invalidate a pending initialization too. */
export class RuntimeContexts {
  private readonly contexts = new Map<number, unknown>();

  has(params: unknown): boolean {
    const id = (params as { context?: { id?: number } } | undefined)?.context?.id;
    return id !== undefined && this.contexts.has(id);
  }

  update(method: string, params: unknown): void {
    const p = params as { context?: { id?: number }; executionContextId?: number;
      executionContextUniqueId?: string } | undefined;
    if (method === "Runtime.executionContextCreated" && p?.context?.id !== undefined)
      this.contexts.set(p.context.id, params);
    else if (method === "Runtime.executionContextDestroyed") {
      if (p?.executionContextId !== undefined) this.contexts.delete(p.executionContextId);
      else if (p?.executionContextUniqueId) {
        for (const [id, value] of this.contexts) {
          if ((value as { context?: { uniqueId?: string } }).context?.uniqueId === p.executionContextUniqueId)
            this.contexts.delete(id);
        }
      }
    }
    else if (method === "Runtime.executionContextsCleared")
      this.clear();
  }

  values(): IterableIterator<unknown> { return this.contexts.values(); }
  clear(): void { this.contexts.clear(); }
}

/** Runtime stays enabled on the shared debugger until it detaches. Logical clients
 *  subscribe independently: a newcomer gets the live snapshot instead of toggling
 *  the domain underneath clients that are already evaluating. */
export class RuntimeDomain extends RuntimeContexts {
  private enabling: Promise<unknown> | undefined;

  enable(send: () => Promise<unknown>): Promise<unknown> {
    if (!this.enabling) {
      this.enabling = send().catch((error: unknown) => {
        this.enabling = undefined;
        throw error;
      });
    }
    return this.enabling;
  }
}

export function isRuntimeContextEvent(method: string): boolean {
  return method === "Runtime.executionContextCreated"
    || method === "Runtime.executionContextDestroyed"
    || method === "Runtime.executionContextsCleared";
}
