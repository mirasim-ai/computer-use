/**
 * The two ways this worker reaches the local mirasim bridge, behind one shape.
 *
 * `RelayConnection` speaks JSON objects; which pipe carries them is this file's business:
 *
 *  - **native** — `chrome.runtime.connectNative`: Chrome spawns `mirasim-cu
 *    bridge-host`, which pumps the frames into mirasim's own socket. The product path.
 *  - **ws** — the one-shot relay a connect page handed over; only the end-to-end test seam
 *    (see background.js).
 *
 * A transport is `{kind, send(obj), close(reason), onmessage, onclose}` — assign the two
 * handlers, then send. Both call `onclose` exactly once.
 */

/** @typedef {{kind: 'native'|'ws', send: (msg: any) => void, close: (reason: string) => void, onmessage?: (msg: any) => void, onclose?: () => void}} Transport */

/** @param {chrome.runtime.Port} port @returns {Transport} */
export function nativeTransport(port) {
  let closed = false;
  /** @type {Transport} */
  const transport = {
    kind: "native",
    // Ports carry structured values — no stringify, and no 1 MB blind spot of our own: the
    // limit lives in Chrome and surfaces as a disconnect, which the reconnect loop handles.
    send: (msg) => {
      if (!closed) port.postMessage(msg);
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        port.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
  port.onMessage.addListener((msg) => transport.onmessage?.(msg));
  port.onDisconnect.addListener(() => {
    if (closed) return;
    closed = true;
    transport.onclose?.();
  });
  return transport;
}

/** @param {WebSocket} ws @returns {Transport} */
export function webSocketTransport(ws) {
  /** @type {Transport} */
  const transport = {
    kind: "ws",
    send: (msg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close: (reason) => {
      try {
        ws.close(1000, reason);
      } catch {
        /* already closing */
      }
    },
  };
  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return; // a malformed frame is the bridge's bug; dropping it keeps the line up
    }
    transport.onmessage?.(msg);
  };
  let closed = false;
  const shut = () => {
    if (closed) return;
    closed = true;
    transport.onclose?.();
  };
  ws.onclose = shut;
  ws.onerror = shut;
  return transport;
}
