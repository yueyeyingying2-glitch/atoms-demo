export const viewerPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const artifactPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";

export const previewPolicy = artifactPolicy + "; sandbox allow-scripts allow-forms; frame-ancestors 'self'";

const storeBootstrap = `(() => {
  let envelope;
  try { envelope = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch {}
  const { nonce, entries = [] } = envelope || {};
  const values = new Map(entries);
  const commit = () => {
    const payload = JSON.stringify([...values]);
    if (payload.length > 32000) throw new DOMException('Storage limit exceeded', 'QuotaExceededError');
    if (nonce) parent.postMessage({ type: 'atoms-storage', nonce, payload }, '*');
  };
  const storage = Object.freeze({
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(String(key)) ?? null,
    setItem(key, value) {
      key = String(key);
      const previous = values.get(key);
      values.set(key, String(value));
      try { commit(); } catch (error) {
        if (previous === undefined) values.delete(key);
        else values.set(key, previous);
        throw error;
      }
    },
    removeItem(key) { values.delete(String(key)); commit(); },
    clear() { values.clear(); commit(); }
  });
  Object.defineProperty(window, 'localStorage', { value: storage });
})();`;

function prependToHead(html, content) {
  return html.replace(/^(<!doctype html\s*>\s*(?:<html(?:\s[^>]*|)>\s*)?(?:<head(?:\s[^>]*|)>\s*)?)/i, '$1' + content);
}

export function previewDocument(html) {
  return prependToHead(html, '<script>' + storeBootstrap + '</script>');
}

export function downloadDocument(html) {
  return prependToHead(html, '<meta http-equiv="Content-Security-Policy" content="' + artifactPolicy + '">');
}

export function viewerDocument(id, { content = '', state = '' } = {}) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>应用 · Atoms Demo</title><link rel="stylesheet" href="/styles.css"><script type="module" src="/viewer.js"></script>
<body class="shared-app"><p class="shared-notice" id="shared-notice" role="status" hidden></p><iframe id="shared-app" title="分享的应用" sandbox="allow-scripts allow-forms" data-project="${id}" data-content="${content}" data-state="${state}"></iframe></body></html>`;
}
