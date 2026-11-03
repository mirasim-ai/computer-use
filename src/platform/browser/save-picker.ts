/**
 * Page-side JS the BROWSER driver installs on the session's own tabs so a page's
 * `showSaveFilePicker()` becomes an ordinary download instead of a native save panel.
 *
 * The panel is the OS's: no CDP command, extension API or page read reaches it, so an agent
 * clicking "Export" sees nothing while the panel waits for a person. Removing the API is not
 * enough: a page that feature-detects at LOAD time, or has no fallback, throws `ReferenceError`.
 *
 * So the API stays and answers with a handle whose writable collects what the page writes; on
 * `close()` that content is downloaded under the name the page suggested. The download verb then
 * returns its receipt like any other, marked `source: "save-picker"` from the registry below —
 * the page believes it saved a file, and the receipt says where the file really went.
 *
 * Installed only where the browser has the native API (feature detection stays truthful) and
 * only on pages this session owns (`claim` in driver-tabs.ts): a tab the user opened keeps its
 * real save panel.
 */

/** `Symbol.for` key of the page-side Set of blob URLs the shim downloaded. */
export const SAVE_PICKER_REGISTRY = "mirasim.savePicker";

export const SAVE_PICKER_JS = `(() => {
  const KEY = Symbol.for(${JSON.stringify(SAVE_PICKER_REGISTRY)});
  if (window[KEY] || typeof window.showSaveFilePicker !== 'function') return;
  const urls = new Set();
  Object.defineProperty(window, KEY, { value: urls });
  const isData = (c) => typeof c === 'string' || c instanceof Blob || c instanceof ArrayBuffer || ArrayBuffer.isView(c);
  const withExtension = (name, types) => {
    if (/\\.[^.]+$/.test(name)) return name;
    const accept = types && types[0] && types[0].accept;
    const ext = accept && [].concat(Object.values(accept)[0] || [])[0];
    return typeof ext === 'string' && ext.startsWith('.') ? name + ext : name;
  };
  const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    urls.add(url);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    // Chrome reads the blob when the download starts; a minute is far past that.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const handleFor = (name) => {
    let file = new File([], name);
    const handle = {
      kind: 'file', name,
      getFile: async () => file,
      isSameEntry: async (other) => other === handle,
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      createWritable: async (options = {}) => {
        // The FileSystemWritableFileStream model: a cursor over a content that only becomes
        // the file on close; abort discards it.
        let content = options.keepExistingData ? file : new Blob([]);
        let cursor = 0;
        const put = (data, at) => {
          const piece = new Blob([data]);
          const gap = Math.max(0, at - content.size);
          content = new Blob([content.slice(0, at), new Uint8Array(gap), piece, content.slice(at + piece.size)]);
          cursor = at + piece.size;
        };
        const apply = (chunk) => {
          if (isData(chunk)) return put(chunk, cursor);
          if (!chunk || typeof chunk !== 'object') throw new TypeError('Invalid write data');
          if (chunk.type === 'write') return put(chunk.data, chunk.position ?? cursor);
          if (chunk.type === 'seek') { cursor = chunk.position; return; }
          if (chunk.type === 'truncate') {
            content = chunk.size <= content.size ? content.slice(0, chunk.size)
              : new Blob([content, new Uint8Array(chunk.size - content.size)]);
            cursor = Math.min(cursor, chunk.size);
            return;
          }
          throw new TypeError('Invalid write data');
        };
        const stream = new WritableStream({
          write: apply,
          close: () => { file = new File([content], name); download(content, name); },
        });
        const send = async (chunk) => {
          const writer = stream.getWriter();
          try { await writer.write(chunk); } finally { writer.releaseLock(); }
        };
        stream.write = send;
        stream.seek = (position) => send({ type: 'seek', position });
        stream.truncate = (size) => send({ type: 'truncate', size });
        return stream;
      },
    };
    return handle;
  };
  window.showSaveFilePicker = async function showSaveFilePicker(options = {}) {
    // The real picker demands a user gesture; keep that contract so a page's error path is
    // the one it would really take.
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      throw new DOMException('Must be handling a user gesture to show a file picker.', 'SecurityError');
    }
    return handleFor(withExtension(String(options.suggestedName || 'download'), options.types));
  };
})()`;
