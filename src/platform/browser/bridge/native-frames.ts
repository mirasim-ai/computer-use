/**
 * Chrome native-messaging framing: a 32-bit length in NATIVE byte order, then UTF-8 JSON.
 *
 * Used on BOTH legs of the native path (Chrome↔host over stdio, host↔bridge over the local
 * socket), so neither end has to re-frame.
 *
 * Chrome's caps are ASYMMETRIC: FROM the host at most 1 MB (CDP commands, kilobytes), TO the
 * host at most 64 MiB (screenshots). An oversized frame is an ERROR, never a silent drop: a
 * dropped screenshot is the least debuggable failure this transport can produce.
 */
import os from "node:os";

/** Chrome's cap on a message FROM the native host. */
export const HOST_TO_BROWSER_MAX = 1024 * 1024;
/** Chrome's cap on a message TO the native host. */
export const BROWSER_TO_HOST_MAX = 64 * 1024 * 1024;

const LITTLE_ENDIAN = os.endianness() === "LE";

/** A message too large for the leg it was to travel: nothing was sent, and the line is intact. */
export class FrameTooLargeError extends Error {
  constructor(readonly bytes: number, readonly max: number) {
    super(`native message of ${bytes} bytes exceeds the ${max}-byte limit`);
  }
}

/** One frame: length prefix + payload. Throws {@link FrameTooLargeError} when `text` exceeds `max`. */
export function encodeFrame(text: string, max: number): Buffer {
  const body = Buffer.from(text, "utf8");
  if (body.length > max) throw new FrameTooLargeError(body.length, max);
  const head = Buffer.allocUnsafe(4);
  if (LITTLE_ENDIAN) head.writeUInt32LE(body.length, 0);
  else head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Streaming decoder: chunks are arbitrary, so even the length prefix can arrive split. `max`
 *  guards against a desynchronised stream claiming a gigabyte; that is not recoverable by
 *  skipping, so {@link push} throws and the caller's job is to die. */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly max: number) {}

  /** Every complete frame in `chunk` (plus whatever was left over before it). */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const out: string[] = [];
    for (;;) {
      if (this.buffer.length < 4) return out;
      const length = LITTLE_ENDIAN ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (length > this.max) {
        throw new Error(`native frame claims ${length} bytes, over the ${this.max}-byte limit`);
      }
      if (this.buffer.length < 4 + length) return out;
      out.push(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
    }
  }
}
