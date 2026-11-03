/** Hermetic cover for the AX ↔ window-server pairing: the pure Swift geometry of
 * `platform/macos/ax/ax-window-match.swift` is compiled ALONE with a generated harness and driven
 * over stdin, so the rulings hold without an app, a helper or an Accessibility grant — two windows
 * sharing a frame get two different ids, and each id resolves to its own window.
 *
 * The Swift half stays a dumb calculator: cases and expectations live here. Skipped (exit 0) where
 * `swiftc` is not installed, so the suite still runs off a Mac. */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** frames: [x, y, w, h] per AX window; rows: [CGWindowID, x, y, w, h] per window-server row. */
interface Case {
  name: string;
  frames: number[][];
  rows: number[][];
  /** CGWindowIDs to resolve back to a window index (-1 = "no such window"). */
  picks?: number[];
  ids: number[];
  indices?: number[];
}

// Chrome's two windows, as measured: a new window opens at the previous
// one's size and position, so nothing but the title tells them apart.
const A = [0, 38, 1512, 906];
const B = [200, 100, 800, 600];

const CASES: Case[] = [
  {
    name: "two windows sharing a frame get two different ids, and each id picks its own window",
    frames: [A, A],
    rows: [[77567, ...A], [77568, ...A]],
    ids: [77567, 77568],
    picks: [77567, 77568],
    indices: [0, 1],
  },
  {
    name: "a row is paired with the window it belongs to, not with the first one listed",
    frames: [A, B],
    rows: [[11, ...B], [12, ...A]],
    ids: [12, 11],
    picks: [11],
    indices: [1],
  },
  {
    name: "more windows than rows: the surplus window says -1 rather than borrowing an id",
    frames: [A, A, A],
    rows: [[21, ...A], [22, ...A]],
    ids: [21, 22, -1],
  },
  {
    name: "a window with no window-server row at all is -1 (minimised or another Space)",
    frames: [A],
    rows: [],
    ids: [-1],
  },
  {
    name: "mid-resize, when no frame matches, a live row still resolves to the nearest window",
    frames: [[0, 38, 1512, 906], [200, 100, 458, 408]],
    rows: [[31, 210, 110, 458, 368]],
    ids: [-1, -1],
    picks: [31],
    indices: [1],
  },
  {
    // Calculator on macOS 26, measured: AX frame (27, -667, 230, 408) against the window
    // server's (29, -667, 226, 401) — a chrome inset, permanent, and the window is on screen.
    name: "a frame inset by a few points from its row is that row's window; a moved one is not",
    frames: [[27, -667, 230, 408], [200, 100, 458, 408]],
    rows: [[145133, 29, -667, 226, 401], [31, 210, 110, 458, 368]],
    ids: [145133, -1],
  },
  {
    name: "an exact twin keeps its own row; the inset window takes the one left over",
    frames: [[27, -667, 230, 408], [29, -667, 226, 401]],
    rows: [[51, 29, -667, 226, 401], [52, 29, -667, 226, 401]],
    ids: [52, 51],
  },
  {
    name: "an unknown id on an app with one window resolves to that window, on two it refuses",
    frames: [A],
    rows: [],
    ids: [-1],
    picks: [999],
    indices: [0],
  },
  {
    name: "an unknown id with several windows is no window at all",
    frames: [A, B],
    rows: [[41, ...A], [42, ...B]],
    ids: [41, 42],
    picks: [999],
    indices: [-1],
  },
];

/** The harness: decode cases, call the two functions under test, print what they answered. */
const HARNESS = `import CoreGraphics
import Foundation

let raw = FileHandle.standardInput.readDataToEndOfFile()
let cases = (try! JSONSerialization.jsonObject(with: raw)) as! [[String: Any]]
var out: [[String: Any]] = []
for c in cases {
  let frames = (c["frames"] as! [[NSNumber]]).map {
    CGRect(x: $0[0].doubleValue, y: $0[1].doubleValue, width: $0[2].doubleValue, height: $0[3].doubleValue)
  }
  let rows = (c["rows"] as! [[NSNumber]]).map {
    (id: $0[0].intValue, frame: CGRect(x: $0[1].doubleValue, y: $0[2].doubleValue, width: $0[3].doubleValue, height: $0[4].doubleValue))
  }
  let ids = matchWindowIds(frames, rows)
  let picks = (c["picks"] as! [NSNumber]).map {
    pickWindowIndex(windowId: $0.intValue, ids: ids, frames: frames, rows: rows) ?? -1
  }
  out.append(["ids": ids, "picks": picks])
}
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: out))
`;

async function main(): Promise<void> {
  if (process.platform !== "darwin") {
    console.log("macos-window-match: SKIP (not macOS)");
    return;
  }
  try {
    await run("swiftc", ["--version"]);
  } catch {
    console.log("macos-window-match: SKIP (no swiftc — install the Xcode command line tools)");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "computer-use-window-match-"));
  const harness = join(dir, "main.swift"); // top-level code is only allowed in main.swift
  writeFileSync(harness, HARNESS);
  const source = resolve(import.meta.dirname, "../src/platform/macos/ax/ax-window-match.swift");
  const bin = join(dir, "match");
  await run("swiftc", [source, harness, "-o", bin], { timeout: 180_000 });

  const child = execFile(bin, { timeout: 30_000 });
  child.stdin!.end(JSON.stringify(CASES.map((c) => ({ frames: c.frames, rows: c.rows, picks: c.picks ?? [] }))));
  let stdout = "";
  child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
  await new Promise<void>((ok, bad) => child.on("close", (code) => (code === 0 ? ok() : bad(new Error(`harness exited ${code}`)))));
  const answers = JSON.parse(stdout) as Array<{ ids: number[]; picks: number[] }>;

  for (const [i, c] of CASES.entries()) {
    const got = answers[i];
    const wantIndices = c.indices ?? [];
    check(
      c.name,
      JSON.stringify(got.ids) === JSON.stringify(c.ids) && JSON.stringify(got.picks) === JSON.stringify(wantIndices),
      `ids ${JSON.stringify(got.ids)} vs ${JSON.stringify(c.ids)}, picks ${JSON.stringify(got.picks)} vs ${JSON.stringify(wantIndices)}`,
    );
  }

  console.log(`\nmacos-window-match: ${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
