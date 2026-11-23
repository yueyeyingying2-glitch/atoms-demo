import { createServer } from 'node:http';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { maxHtmlBytes, maxJobBytes, validateCases } from './acceptance.js';
import { previewDocument, previewPolicy, viewerDocument, viewerPolicy } from './preview.js';

const socketPath = process.env.QA_SOCKET_PATH;
if (!socketPath) throw new Error('Set QA_SOCKET_PATH');
const origin = 'https://atoms-preview.invalid';
const id = 'browser-test';
const moduleHeaders = { 'Content-Type': 'text/javascript; charset=utf-8' };
const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' };
const assets = Object.fromEntries(['viewer.js', 'preview.js', 'styles.css'].map(file => [
  '/' + file, readFileSync(new URL('../public/' + file, import.meta.url), 'utf8')
]));
const browser = await chromium.launch({
  executablePath: process.env.QA_CHROMIUM_PATH || undefined,
  chromiumSandbox: true,
  timeout: 12_000
});
browser.on('disconnected', () => process.exit(1));

async function runStep(page, step, memory, signal) {
  const frame = page.frameLocator('#shared-app');
  const target = step.target && frame.getByTestId(step.target);
  const options = { timeout: 1800 };
  if (step.action === 'reload') return page.reload({ waitUntil: 'load', ...options });
  if (step.action === 'click') return target.click(options);
  if (step.action === 'fill') return target.fill(step.value, options);
  if (step.action === 'select') return target.selectOption(step.value, options);
  if (step.action === 'press') return target.press(step.value, options);
  if (step.action === 'visible') return target.waitFor({ state: 'visible', ...options });
  if (step.action === 'remember') {
    memory.value = (await target.innerText(options)).trim();
    return;
  }
  const deadline = Date.now() + options.timeout;
  do {
    signal.throwIfAborted();
    if (step.action === 'count' && await target.count() === step.value) return;
    if (step.action === 'value' && await target.inputValue(options) === step.value) return;
    if (['changed', 'text', 'contains'].includes(step.action)) {
      const text = (await target.innerText(options)).trim().replace(/\s+/g, ' ');
      if (step.action === 'text' && text === step.value.trim().replace(/\s+/g, ' ')) return;
      if (step.action === 'contains' && text.includes(step.value)) return;
      if (step.action === 'changed' && text !== memory.value.replace(/\s+/g, ' ')) return;
    }
    await pause(80, undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error('页面结果与预期不符');
}

async function runCases(html, cases, signal) {
  const checks = [];
  const logs = [];
  let runtimeFailed = false;
  function log(message) {
    const line = message.slice(0, 220);
    if (!logs.includes(line) && logs.length < 12) logs.push(line);
  }
  const previewHtml = previewDocument(html);
  for (const { label, steps } of cases) {
    if (signal.aborted) {
      checks.push({ label, passed: null, detail: '超过浏览器验收时限' });
      continue;
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block', acceptDownloads: false });
    const stop = () => { void context.close().catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    let stepIndex = 0;
    try {
      signal.throwIfAborted();
      await context.route('**/*', async route => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin === origin && req.method() === 'GET') {
          if (url.pathname === '/apps/' + id) return route.fulfill({
            headers: { ...htmlHeaders, 'Content-Security-Policy': viewerPolicy }, body: viewerDocument(id)
          });
          if (url.pathname === '/preview/' + id) return route.fulfill({
            headers: { ...htmlHeaders, 'Content-Security-Policy': previewPolicy }, body: previewHtml
          });
          if (assets[url.pathname]) return route.fulfill({
            headers: url.pathname.endsWith('.css') ? { 'Content-Type': 'text/css; charset=utf-8' } : moduleHeaders,
            body: assets[url.pathname]
          });
        }
        runtimeFailed = true;
        log('已阻止页面的外部请求或导航');
        return route.abort();
      });
      const page = await context.newPage();
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      page.on('pageerror', error => { runtimeFailed = true; log(error.message); });
      page.on('console', message => {
        if (message.type() === 'error') runtimeFailed = true;
        if (['warning', 'error'].includes(message.type())) log(message.text());
      });
      await page.goto(origin + '/apps/' + id, { waitUntil: 'load', timeout: 3500 });
      const memory = {};
      for (const step of steps) {
        stepIndex++;
        signal.throwIfAborted();
        await runStep(page, step, memory, signal);
      }
      checks.push({ label, passed: true });
    } catch {
      checks.push({ label, passed: signal.aborted ? null : false, detail: signal.aborted
        ? '超过浏览器验收时限' : stepIndex ? '第 ' + stepIndex + ' 步未得到预期结果（' + steps[stepIndex - 1].action + '）' : '页面加载失败' });
    } finally {
      signal.removeEventListener('abort', stop);
      await context.close().catch(() => {});
    }
  }
  checks.unshift({
    label: '浏览器运行检查', passed: runtimeFailed ? false : signal.aborted ? null : true,
    detail: runtimeFailed ? '发现脚本错误、控制台错误或非预期网络请求' : undefined
  });
  return { checks, logs };
}

let busy = false;
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return res.writeHead(200).end();
  if (req.method !== 'POST' || req.url !== '/check') return res.writeHead(404).end();
  // Give model calls that finish together a bounded wait for the one available browser slot.
  const client = new AbortController();
  res.once('close', () => client.abort());
  const waiting = AbortSignal.any([client.signal, AbortSignal.timeout(10_000)]);
  let acquired = false;
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxJobBytes) return res.writeHead(413).end();
      chunks.push(chunk);
    }
    const { html, cases } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof html !== 'string' || Buffer.byteLength(html) > maxHtmlBytes) return res.writeHead(400).end();
    const validated = validateCases(cases);
    while (busy) await pause(120, undefined, { signal: waiting });
    waiting.throwIfAborted();
    busy = acquired = true;
    const signal = AbortSignal.any([client.signal, AbortSignal.timeout(40_000)]);
    const result = await runCases(html, validated, signal);
    if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch {
    if (!res.destroyed) res.writeHead(503).end();
  } finally {
    if (acquired) busy = false;
  }
});
const existing = await lstat(socketPath).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
if (existing?.isSocket()) await unlink(socketPath);
server.listen(socketPath, async () => {
  await chmod(socketPath, 0o600);
  console.log('Browser acceptance worker ready');
});
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  server.close();
  void browser.close().finally(() => process.exit(0));
});
