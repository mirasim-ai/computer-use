/**
 * Which screencast frames a preview shows — `node scripts/test.mjs preview-stream-frames`.
 *
 * A preview asks for frames up to its size. A frame far smaller than that and than the page was made
 * under someone else's settings: an older extension bridge handed on the 64-px frames of its own
 * keep-drawing screencast when the preview's start crossed them, and shown, one of them was the
 * preview's whole picture, blurred past reading. Pinned here: such a frame is acknowledged and never
 * shown; the preview's own frames are.
 *
 * Hermetic: the real CdpPreviewStream against a WebSocket that answers like a flattened CDP
 * endpoint. No browser.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { CdpPreviewStream } from "../src/platform/chromium/preview-stream.ts";
import type { PreviewFrame } from "../src/platform/types.ts";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) { if (what()) return true; await sleep(10); }
  return what();
}
function png(width: number, height: number): string {
  const head = Buffer.alloc(33);
  head.writeUInt32BE(0x89504e47, 0); head.writeUInt32BE(0x0d0a1a0a, 4); head.writeUInt32BE(13, 8);
  head.write("IHDR", 12); head.writeUInt32BE(width, 16); head.writeUInt32BE(height, 20);
  return head.toString("base64");
}
function jpeg(width: number, height: number): string {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]).toString("base64");
}

async function main() {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const acks: number[] = [];
  let peer: WebSocket | null = null;
  server.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (data) => {
      const { id, method, params } = JSON.parse(String(data));
      const answer = (result: unknown) => ws.send(JSON.stringify({ id, result, ...(method === "Target.attachToTarget" ? {} : { sessionId: "S" }) }));
      if (method === "Target.attachToTarget") return answer({ sessionId: "S" });
      if (method === "Page.getLayoutMetrics") return answer({ cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } });
      if (method === "Page.captureScreenshot") return answer({ data: png(2560, 1600) });
      if (method === "Page.screencastFrameAck") acks.push(params.sessionId);
      answer({});
    });
  });
  const frames: PreviewFrame[] = [];
  const stream = new CdpPreviewStream(
    { kind: "browser", targetId: "T", title: "", url: "about:blank", appName: "Browser", capture: { type: "cdp", endpoint: `ws://127.0.0.1:${port}`, targetId: "T" } },
    { frame: (frame) => frames.push(frame), status: () => {}, gone: () => {} },
    2560,
  );
  const cast = (data: string, sessionId: number) => peer!.send(JSON.stringify({ sessionId: "S", method: "Page.screencastFrame",
    params: { data, sessionId, metadata: { deviceWidth: 1280, deviceHeight: 800 } } }));
  try {
    await stream.tick();
    await until(() => frames.length === 1);
    check("the first picture is the preview's own screenshot", frames.length === 1 && frames[0]!.data === png(2560, 1600));

    cast(jpeg(64, 40), 1);
    await until(() => acks.includes(1));
    await sleep(250);
    check("a 64-px frame made under another client's settings is never shown", frames.length === 1, JSON.stringify(frames.map((f) => f.data.slice(0, 8))));
    check("…and is acknowledged at once", acks.includes(1), JSON.stringify(acks));

    cast(png(2560, 1600), 2);
    await until(() => frames.length === 2);
    check("the preview's own frame is shown", frames.length === 2 && frames[1]!.data === png(2560, 1600));
    check("…in the page's CSS size", frames[1]?.width === 1280 && frames[1]?.height === 800, JSON.stringify(frames[1] && { w: frames[1].width, h: frames[1].height }));
  } finally {
    stream.dispose();
    server.close();
  }

  console.log(failures ? `\n${failures} check(s) failed` : "\nall preview-stream-frames checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
