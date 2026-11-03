/** Round-trip coverage for browser state export/import (platform/browser/state.ts):
 * seed a cookie + a localStorage item in throwaway Chrome A, export, import into
 * throwaway Chrome B (an independent profile), and verify both arrived. localStorage
 * is seeded and verified on a fabricated origin via request interception, so the test
 * never touches the network — the same technique the import path itself uses. */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { exportStorageState, importStorageState, type BrowserStorageState } from "../src/platform/browser/state.ts";
import { spawnChrome } from "./helpers.ts";

const ORIGIN = "https://cu-roundtrip.test";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Open a page ON the fabricated origin without any real network (route + fulfill). */
async function openOriginPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>rt</title>" }));
  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" });
  return page;
}

async function main() {
  const a = await spawnChrome({});
  const b = await spawnChrome({});
  let browserA: Browser | null = null;
  let browserB: Browser | null = null;
  try {
    browserA = await chromium.connectOverCDP(a.cdpUrl);
    browserB = await chromium.connectOverCDP(b.cdpUrl);
    const ctxA = browserA.contexts()[0]!;
    const ctxB = browserB.contexts()[0]!;

    // Seed A: one cookie (HttpOnly, so document.cookie could never carry it — the CDP
    // jar must) + one localStorage item on a page that STAYS OPEN, because export
    // enumerates localStorage origins from open tabs.
    await ctxA.addCookies([{
      name: "cu_cookie", value: "roundtrip-42", domain: "cu-roundtrip.test", path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: "Lax",
    }]);
    const pageA = await openOriginPage(ctxA);
    await pageA.evaluate(() => localStorage.setItem("cu_key", "cu_value"));

    const state = await exportStorageState(browserA);
    check("export: storage_state shape", Array.isArray(state.cookies) && Array.isArray(state.origins));
    const cookie = state.cookies.find((c) => c.name === "cu_cookie");
    check("export: cookie present with its value", cookie?.value === "roundtrip-42");
    check(
      "export: cookie carries the full field set",
      !!cookie && cookie.domain === "cu-roundtrip.test" && cookie.path === "/"
        && cookie.httpOnly === true && cookie.secure === true && cookie.sameSite === "Lax"
        && typeof cookie.expires === "number",
      JSON.stringify(cookie),
    );
    const originEntry = state.origins.find((o) => o.origin === ORIGIN);
    check(
      "export: localStorage item listed under its origin",
      !!originEntry?.localStorage.some((i) => i.name === "cu_key" && i.value === "cu_value"),
      JSON.stringify(originEntry),
    );
    check("export: only http(s) origins are enumerated", state.origins.every((o) => /^https?:\/\//.test(o.origin)),
      state.origins.map((o) => o.origin).join(", "));

    // What travels between processes is the JSON — round-trip through it like the CLI does.
    const wire = JSON.parse(JSON.stringify(state)) as BrowserStorageState;

    await importStorageState(browserB, wire);
    const cookiesB = await ctxB.cookies();
    check("import: cookie landed in B", cookiesB.some((c) => c.name === "cu_cookie" && c.value === "roundtrip-42"));
    const pageB = await openOriginPage(ctxB);
    const value = await pageB.evaluate(() => localStorage.getItem("cu_key"));
    check("import: localStorage landed in B on the right origin", value === "cu_value", String(value));
    await pageB.close();

    // Idempotent: a second import neither throws nor duplicates.
    await importStorageState(browserB, wire);
    const again = (await ctxB.cookies()).filter((c) => c.name === "cu_cookie");
    check("import: re-run is idempotent (one cookie, same value)", again.length === 1 && again[0]!.value === "roundtrip-42");

    // Import must not leave its scaffolding behind: only B's own pages remain open.
    const leftover = ctxB.pages().filter((p) => !p.isClosed() && p.url().startsWith(ORIGIN));
    check("import: no page left on the seeded origin", leftover.length === 0, `${leftover.length} page(s)`);
  } finally {
    await browserA?.close().catch(() => {});
    await browserB?.close().catch(() => {});
    a.cleanup();
    b.cleanup();
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nall browser-state checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("FAIL  browser-state crashed:", e);
  process.exit(1);
});
