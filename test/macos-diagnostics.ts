/**
 * The macOS diagnostics channel — the helper's OWN log, and the one thing this platform can
 * answer that "what went wrong?" with.
 *
 * Driving an Electron app over CDP, one `diagnostics()` call settles whether an edit broke the
 * renderer; without this channel the same question on a native app has no answer — the helper's
 * complaints (a pid LaunchServices denies while the process is alive, an `activate` that
 * returned false, a reply it could not serialise) go to stderr and reach nobody unless the
 * helper also DIES, which is when they are least useful.
 *
 * Hermetic: the helper is a fake child process through `AxHelperOptions.spawn`, so this pins the
 * real wiring (driver → `onLog` → the shared buffer) without a Swift build or an app.
 */

import { PassThrough } from "node:stream";

import { MacosDriver } from "../src/platform/macos/driver.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const firstText = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === "text")?.text ?? "";

/** A child process that answers every request with a bare ok, and whose stderr the test writes. */
function fakeHelper() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const id = (JSON.parse(line) as { id: number }).id;
      stdout.write(`${JSON.stringify({ id, ok: true, result: {} })}\n`);
    }
  });
  const child = Object.assign(new PassThrough(), {
    stdin, stdout, stderr, exitCode: null as number | null,
    kill: () => true,
  });
  return { child, stderr };
}

async function main() {
  const { child, stderr } = fakeHelper();
  const driver = new MacosDriver({
    // Named, because an unnamed session refuses before it asks the helper anything — and
    // this suite needs the helper spawned so its stderr is wired up.
    bundle: "com.apple.calculator",
    helper: { bin: "/nonexistent/ax-helper", spawn: (() => child) as never },
  });

  check("the platform declares it can feed the channel", driver.supportsDiagnostics);

  driver.enableDiagnostics();
  const off = firstText(await driver.readDiagnostics());
  check("the empty answer describes THIS platform's sources, not a page's",
    /complaints from the accessibility helper/.test(off) && !/console|network/.test(off), off);

  // One request, so the helper is spawned and its stderr is wired up. What it answers does not
  // matter here — the driver is expected to complain about the empty result, and does.
  await driver.perform("activate", {}).catch(() => undefined);

  // Split mid-line on purpose: stderr arrives in chunks, and half a sentence in a diagnostics
  // entry is worse than waiting for the newline.
  stderr.write("computer-use-ax-helper: activate(482) returned false\ncomputer-use-ax-helper: pid 903 is alive but neit");
  await new Promise((r) => setImmediate(r));
  const one = firstText(await driver.readDiagnostics());
  check("a complete line lands, with the helper's own prefix stripped",
    /helper: activate\(482\) returned false/.test(one) && !/computer-use-ax-helper/.test(one), one.split("\n").at(-1) ?? one);
  check("the half line is held back until its newline", !/903/.test(one));

  stderr.write("her LaunchServices nor NSWorkspace lists it — retrying\n");
  await new Promise((r) => setImmediate(r));
  const two = firstText(await driver.readDiagnostics());
  check("...and arrives whole once it ends",
    /pid 903 is alive but neither LaunchServices nor NSWorkspace lists it — retrying/.test(two),
    two.split("\n").at(-1) ?? two);
  check("the header names the helper's log rather than a console",
    /the macOS accessibility helper's own log/.test(two), two.split("\n")[0] ?? "");

  await driver.close();
  console.log(failures ? `\nmacos-diagnostics: ${failures} FAILED` : "\nmacos-diagnostics: OK");
  process.exit(failures ? 1 : 0);
}

void main();
