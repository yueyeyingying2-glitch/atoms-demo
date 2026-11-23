const active = new WeakMap();

export function connectPreview(frame) {
  window.addEventListener('message', event => {
    const current = active.get(frame);
    if (!current?.key || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const { type, nonce, payload } = event.data ?? {};
    if (type !== 'atoms-storage' || nonce !== current.nonce || typeof payload !== 'string' || payload.length > 32_000) return;
    try {
      const entries = JSON.parse(payload);
      if (Array.isArray(entries) && entries.every(entry => Array.isArray(entry) && entry.length === 2
        && entry.every(value => typeof value === 'string'))) localStorage.setItem(current.key, payload);
    } catch {}
  });
}

export function openPreview(frame, id, isWeb = false, refresh = false) {
  let url = '/preview/' + encodeURIComponent(id);
  if (refresh) url += '?refresh=' + Date.now();
  if (isWeb) {
    const key = 'atoms-app:' + id;
    const nonce = crypto.getRandomValues(new Uint32Array(2)).join('-');
    let entries = [];
    try { entries = JSON.parse(localStorage.getItem(key) ?? '[]'); } catch {}
    active.set(frame, { key, nonce });
    url += '#' + encodeURIComponent(JSON.stringify({ nonce, entries }));
  } else {
    active.delete(frame);
  }
  frame.src = url;
}
