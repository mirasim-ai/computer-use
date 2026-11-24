/** Read-only witnesses for a host that dispatches ordinary clicks inside a webview. */
import type { Locator } from "playwright-core";
import { pageFn } from "./collect.ts";

const CHECKBOX = `el => {
  const control = el.closest('input[type=checkbox],[role=checkbox],[role=switch]') ?? el.closest('label')?.control;
  if (!control?.matches('input[type=checkbox],[role=checkbox],[role=switch]')) return null;
  const checked = () => !control.isConnected ? null : control.matches('input[type=checkbox]')
    ? String(control.checked) : control.getAttribute('aria-checked');
  return { before: checked(), checked };
}`;

type Entry = { href: string; key?: string; next?: { key: string; url: string }; origin: number };

async function bounded<T>(read: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([read, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]);
  } catch { return null; } finally { clearTimeout(timer); }
}

export async function embeddedClickEvidence(loc: Locator, timeout: number) {
  const state = await loc.evaluateHandle(pageFn(CHECKBOX), undefined, { timeout });
  try {
    const checkbox = !!await state.evaluate(pageFn("s => !!s"));
    const history = () => loc.page().mainFrame().evaluate<Entry>(`(() => {
      const nav = window.navigation, current = nav?.currentEntry;
      const next = current && nav.entries()[current.index + 1];
      return { href: location.href, key: current?.key, origin: performance.timeOrigin,
        next: next && { key: next.key, url: next.url } };
    })()`);
    const before = checkbox ? null : await bounded(history(), 500);
    return {
      checkbox,
      drop() { void state.dispose().catch(() => {}); },
      async confirm(deadline: number): Promise<boolean> {
        if (!checkbox && !before?.next) return false;
        do {
          const remaining = Math.max(1, Math.min(500, deadline - Date.now()));
          if (checkbox) {
            const changed = await bounded(state.evaluate(pageFn("s => s.before !== null && s.checked() !== null && s.checked() !== s.before")), remaining);
            if (changed === true) return true;
            if (changed === null) return false;
          } else {
            const entry = await bounded(history(), remaining);
            if (entry && entry.key === before!.next!.key && entry.href === before!.next!.url && entry.key !== before!.key) return true;
          }
          const left = deadline - Date.now();
          if (left <= 0) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(100, left)));
        } while (Date.now() < deadline);
        return false;
      },
    };
  } catch (error) {
    await state.dispose().catch(() => {});
    throw error;
  }
}
