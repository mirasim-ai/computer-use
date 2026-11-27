/** An image's pixel size, read from its own header — for a shot written to disk and for a frame in flight. */

/** Pixel size from a PNG's IHDR or a JPEG's SOF; null when it is neither, or the header is not all there. */
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < buf.length;) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const m = buf[i + 1]!;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * The same for a base64 image, decoding only its head: a screencast frame is read for its size
 * many times a second, and the header of a PNG or of Chrome's JPEGs sits in its first bytes.
 */
export function base64ImageSize(data: string): { width: number; height: number } | null {
  return imageSize(Buffer.from(data.slice(0, 4096), "base64"));
}
