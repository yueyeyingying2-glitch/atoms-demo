const active = new WeakMap();

async function stateRequest(url, body) {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '工具记录请求失败');
  return result;
}

function saveAccountState(current, entries) {
  if (current.failed) return;
  current.queued = entries;
  if (current.saving) return;
  current.status('正在保存工具记录…');
  current.saving = (async () => {
    while (current.queued) {
      const snapshot = current.queued;
      current.queued = null;
      const { revision } = await stateRequest(current.url, {
        entries: snapshot, revision: current.revision, account: current.account
      });
      current.revision = revision;
    }
    current.status('工具记录已同步到账号');
  })().catch(error => {
    current.failed = true;
    current.status(error.message);
  }).finally(() => { current.saving = null; });
}

export function connectPreview(frame) {
  window.addEventListener('message', event => {
    const current = active.get(frame);
    if (!current?.nonce || event.source !== frame.contentWindow || event.origin !== 'null') return;
    const { type, nonce, payload } = event.data ?? {};
    if (type !== 'atoms-storage' || nonce !== current.nonce || typeof payload !== 'string' || payload.length > 32_000) return;
    try {
      const entries = JSON.parse(payload);
      if (!Array.isArray(entries) || !entries.every(entry => Array.isArray(entry)
        && entry.length === 2 && entry.every(value => typeof value === 'string'))) return;
      if (current.account) saveAccountState(current, entries);
      else if (current.key) localStorage.setItem(current.key, payload);
    } catch {
      current.status('无法保存浏览器记录');
    }
  });
}

export async function waitForPreviewSave(frame) {
  await active.get(frame)?.saving;
}

export function closePreview(frame) {
  active.delete(frame);
  frame.removeAttribute('src');
}

export async function openPreview(frame, id, options = {}) {
  const { state, content, refresh, withStorage = true, status = () => {} } = options;
  const previous = active.get(frame);
  const current = { status: message => { if (active.get(frame) === current) status(message); } };
  active.set(frame, current);
  await previous?.saving;
  if (active.get(frame) !== current) return;
  let url = content || '/preview/' + encodeURIComponent(id);
  if (refresh) url += '?refresh=' + Date.now();
  if (!withStorage) {
    frame.src = url;
    return;
  }
  let entries = [];
  if (state) {
    current.status('正在读取工具记录…');
    try {
      const snapshot = await stateRequest(state);
      if (!snapshot.guest) {
        entries = snapshot.entries;
        Object.assign(current, { url: state, account: snapshot.account, revision: snapshot.revision });
      }
      current.status(snapshot.guest ? '' : '工具记录已连接账号');
    } catch (error) {
      current.failed = true;
      current.status(error.message);
    }
  }
  if (active.get(frame) !== current) return;
  if (!current.account && !current.failed) {
    current.key = (content ? 'atoms-visitor:' : 'atoms-app:') + id;
    try { entries = JSON.parse(localStorage.getItem(current.key) ?? '[]'); } catch {}
  }
  current.nonce = crypto.getRandomValues(new Uint32Array(2)).join('-');
  frame.src = url + '#' + encodeURIComponent(JSON.stringify({ nonce: current.nonce, entries }));
}
