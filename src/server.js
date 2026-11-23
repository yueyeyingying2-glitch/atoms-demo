import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createStore } from './store.js';
import { challengeImage, createChallenge, credentials, passwordDigest, passwordMatches } from './auth.js';
import { assemble, generate, isRevision, revise } from './generate.js';
import { examples } from './spec.js';
import { generateWeb } from './agent.js';
import { templates } from '../public/templates.js';
import { downloadDocument, previewDocument, previewPolicy, viewerDocument, viewerPolicy } from './preview.js';

const files = Object.fromEntries([
  ['/index.html', 'text/html; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8'],
  ...['/studio.js', '/preview.js', '/viewer.js', '/templates.js'].map(path => [path, 'text/javascript; charset=utf-8']),
  ...templates.map(item => [item.cover, 'image/jpeg'])
].map(([path, type]) => [path, { type, bytes: readFileSync(new URL('../public' + path, import.meta.url)) }]));

const cookieName = 'studio_session';
const week = 604800;
const seedOwner = 'examples';
const htmlType = 'text/html; charset=utf-8';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req, maxBytes = 16_384) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 JSON 格式');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, '输入内容过长');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new HttpError(400, '输入格式无效'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new HttpError(400, '输入格式无效');
  return result;
}

function getSession(req, store) {
  const entries = (req.headers.cookie ?? '').split(';').map(cookie => cookie.trim().split('='));
  const token = entries.find(([key]) => key === cookieName)?.[1];
  return store.session(token);
}

function cookie(res, token, secure) {
  res.setHeader('Set-Cookie', cookieName + '=' + (token ?? '')
    + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (token ? week : 0) + (secure ? '; Secure' : ''));
}

function viewer(session) {
  return session.user_id ? { username: session.username } : null;
}

function workspaceOwner(session) {
  return session.user_id ? 'account:' + session.user_id : 'guest:' + session.id;
}

function projectResponse(row, details = false) {
  const testResults = JSON.parse(row.checks);
  const project = {
    id: row.id, kind: row.kind, title: row.title, description: row.description,
    source: row.source, createdAt: Number(row.created_at),
    url: row.source === 'draft' || testResults.managed ? null : '/apps/' + row.id
  };
  if (details) {
    project.prompt = row.prompt;
    project.checks = Array.isArray(testResults) ? testResults : testResults.items;
    project.html = row.html;
    for (const key of ['parentId', 'plan', 'model', 'logs', 'timeline']) {
      if (testResults[key] !== undefined) project[key] = testResults[key];
    }
  }
  return project;
}

function publicationInfo(publication, row) {
  if (publication) {
    return {
      status: publication.active ? 'published' : 'offline',
      url: publication.active ? '/s/' + publication.slug : null,
      versionId: publication.version_id,
      updatedAt: Number(publication.updated_at)
    };
  }
  const available = row.source !== 'draft' && !JSON.parse(row.checks).managed;
  return {
    status: available ? 'legacy' : 'unpublished',
    url: available ? '/apps/' + row.id : null,
    versionId: available ? row.id : null
  };
}

function canPublish(row) {
  const facts = JSON.parse(row.checks);
  const checks = Array.isArray(facts) ? facts : facts.items;
  return row.source !== 'draft' && checks.length > 0 && checks.every(check => check.passed === true);
}

function renderPreview(res, row, stateful = false) {
  res.writeHead(200, { 'Content-Type': htmlType, 'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': previewPolicy, 'Referrer-Policy': 'no-referrer' });
  res.end(stateful || row.kind === 'web' ? previewDocument(row.html) : row.html);
}

function exportProject(res, row) {
  res.writeHead(200, { 'Content-Type': htmlType, 'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Disposition': 'attachment; filename="' + row.id + '.html"' });
  res.end(downloadDocument(row.html));
}

function offline(res) {
  res.writeHead(410, { 'Content-Type': htmlType, 'Content-Security-Policy': "default-src 'none'; style-src 'self'; frame-ancestors 'none'" });
  res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>应用已下线</title><link rel="stylesheet" href="/styles.css"><main class="offline-page"><h1>应用已下线</h1><p>请联系发布者获取可用链接。</p></main></html>');
}

const safetyHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cache-Control': 'no-store'
};

export async function createStudioServer(options = {}) {
  const store = await createStore(options.databaseUrl, options.schema);
  const model = options.model ?? {};
  const agent = options.agent?.key ? options.agent : undefined;
  const rates = new Map();
  const pending = new Set();
  const authenticating = new Set();

  for (const example of examples) {
    const existing = await store.project(example.id);
    const revision = example.revision ?? 1;
    if (existing && (existing.owner !== seedOwner || existing.source !== 'example'
      || (JSON.parse(existing.checks).exampleRevision ?? 1) >= revision)) continue;
    const project = assemble(example.spec, example.prompt, 'example');
    if (!project.checks.every(test => test.passed)) throw new Error('示例未通过验收：' + example.id);
    await store.saveProject({ ...project, exampleRevision: revision }, seedOwner, example.prompt, example.id);
  }

  function limit(key, cap, period) {
    const now = Date.now();
    let entry = rates.get(key);
    if (!entry || entry.expiry <= now) {
      entry = { expiry: now + period, used: 0 };
      rates.set(key, entry);
    }
    if (++entry.used > cap) throw new HttpError(429, '操作过于频繁，请稍后再试');
    if (rates.size > 500) {
      for (const [name, item] of rates) {
        if (item.expiry <= now) rates.delete(name);
      }
    }
  }

  async function detailsFor(row, current) {
    const root = await store.projectRoot(row);
    const [publication, versions] = await Promise.all([
      store.publication(root), store.versions(root, row.owner)
    ]);
    const info = publicationInfo(publication, row);
    return {
      ...projectResponse(row, true), url: info.url, publication: info,
      canPublish: row.owner !== seedOwner && canPublish(row),
      stateUrl: current.user_id && row.owner !== seedOwner ? '/api/projects/' + row.id + '/state' : null,
      versions: versions.map((version, index) => ({
        id: version.id, title: version.title, source: version.source,
        number: index + 1, createdAt: Number(version.created_at)
      }))
    };
  }

  async function serveState(req, res, root, current) {
    if (req.method === 'GET') {
      const state = await store.toolState(root, current.user_id);
      return json(res, 200, { entries: state ? JSON.parse(state.data) : [], revision: state?.revision ?? 0, account: current.user_id });
    }
    limit('tool-state:' + current.user_id, 180, 60_000);
    const { entries, revision, account } = await body(req, 131_072);
    if (account !== current.user_id) throw new HttpError(409, '当前账号已切换，请刷新工具');
    if (!Number.isInteger(revision) || revision < 0 || revision >= 2_147_483_647
      || !Array.isArray(entries) || entries.length > 512 || JSON.stringify(entries).length > 32_000
      || !entries.every(item => Array.isArray(item) && item.length === 2 && item.every(value => typeof value === 'string'))
      || new Set(entries.map(item => item[0])).size !== entries.length) {
      throw new HttpError(400, '工具记录格式无效');
    }
    const saved = await store.writeToolState(root, current.user_id, entries, revision);
    if (!saved) throw new HttpError(409, '工具记录已在另一个页面更新，请刷新后再保存');
    return json(res, 200, saved);
  }

  async function route(req, res) {
    for (const [key, value] of Object.entries(safetyHeaders)) res.setHeader(key, value);
    const path = new URL(req.url, 'http://local').pathname;
    const { method } = req;
    const localRequest = req.socket.remoteAddress ?? 'unknown';
    if (method === 'POST' && req.headers.origin) {
      let originAllowed = false;
      try {
        const origin = new URL(req.headers.origin);
        originAllowed = options.publicOrigin ? origin.origin === options.publicOrigin : origin.host === req.headers.host;
      } catch {}
      if (!originAllowed) throw new HttpError(403, '请求来源无效');
    }
    const secure = Boolean(req.socket.encrypted || options.publicOrigin?.startsWith('https://'));
    let session;
    async function sessionForRequest() {
      if (session) return session;
      session = await getSession(req, store);
      if (!session) {
        limit('session:' + localRequest, 180, 60_000);
        const created = await store.newSession();
        cookie(res, created.token, secure);
        session = created.session;
      }
      return session;
    }
    if (method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });

    if (method === 'GET' && path === '/projects' && !(await getSession(req, store))?.user_id) {
      res.writeHead(302, { Location: '/' });
      return res.end();
    }
    if (method === 'GET' && (['/', '/studio', '/templates', '/projects'].includes(path) || files[path])) {
      const file = files[path] ?? files['/index.html'];
      res.writeHead(200, { 'Content-Type': file.type,
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      return res.end(file.bytes);
    }

    const shareMatch = path.match(/^\/s\/([A-Za-z0-9_-]{16})(?:\/(content|download))?$/);
    if (method === 'GET' && shareMatch) {
      const publication = await store.share(shareMatch[1]);
      if (!publication) throw new HttpError(404, '这个应用链接不存在');
      if (!publication.active) return offline(res);
      const row = await store.project(publication.version_id);
      if (shareMatch[2] === 'content') return renderPreview(res, row, true);
      if (shareMatch[2] === 'download') return exportProject(res, row);
      const share = '/s/' + publication.slug;
      const guest = new URL(req.url, 'http://local').searchParams.get('guest') === '1';
      res.writeHead(200, { 'Content-Type': htmlType, 'Content-Security-Policy': viewerPolicy });
      return res.end(viewerDocument(publication.slug, {
        content: share + '/content', state: guest ? '' : '/api/shared/' + publication.slug + '/state'
      }));
    }
    const publicMatch = path.match(/^\/(apps|preview)\/([a-zA-Z0-9_-]{4,36})(\/download)?$/);
    if (method === 'GET' && publicMatch) {
      const isPreview = publicMatch[1] === 'preview';
      const row = await store.project(publicMatch[2]);
      if (!row) throw new HttpError(404, '这个应用链接不存在');
      const facts = JSON.parse(row.checks);
      const publication = await store.publication(await store.projectRoot(row));
      if (isPreview) {
        if (publication || facts.managed || row.source === 'draft') {
          const current = await getSession(req, store);
          if (!current || row.owner !== workspaceOwner(current)) throw new HttpError(404, '这个应用链接不存在');
        }
        return renderPreview(res, row, Boolean(facts.managed || publication));
      }
      if (facts.managed || row.source === 'draft') throw new HttpError(404, '这个应用链接不存在');
      if (publication) {
        if (!publication.active) return offline(res);
        res.writeHead(302, { Location: '/s/' + publication.slug + (publicMatch[3] ?? '') });
        return res.end();
      }
      if (publicMatch[3]) return exportProject(res, row);
      if (row.kind === 'web') {
        res.writeHead(200, { 'Content-Type': htmlType, 'Content-Security-Policy': viewerPolicy });
        return res.end(viewerDocument(row.id));
      }
      res.writeHead(200, { 'Content-Type': htmlType,
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      return res.end(row.html);
    }
    const sharedStateMatch = path.match(/^\/api\/shared\/([A-Za-z0-9_-]{16})\/state$/);
    if (sharedStateMatch && ['GET', 'POST'].includes(method)) {
      const publication = await store.share(sharedStateMatch[1]);
      if (!publication?.active) throw new HttpError(404, '这个应用链接不存在');
      const current = await getSession(req, store);
      if (!current?.user_id) {
        if (method === 'GET') return json(res, 200, { guest: true });
        throw new HttpError(401, '请登录后保存到账号');
      }
      return serveState(req, res, publication.root_id, current);
    }
    if (method === 'GET' && path === '/api/projects') {
      const current = await getSession(req, store);
      if (!current?.user_id) throw new HttpError(401, '请登录后查看项目');
      return json(res, 200, { projects: await store.projectGroups(workspaceOwner(current)) });
    }
    if (method === 'GET' && path === '/api/bootstrap') {
      const current = await sessionForRequest();
      const featured = await Promise.all(examples.map(async example => ({
        ...projectResponse(await store.project(example.id)), prompt: example.prompt
      })));
      return json(res, 200, {
        user: viewer(current), engine: agent ? 'deepseek' : 'demo', featured, history: (await store.projects(workspaceOwner(current))).map(row => projectResponse(row))
      });
    }
    if (method === 'GET' && path === '/api/challenge') {
      limit('challenge:' + localRequest, 120, 60_000);
      return json(res, 200, await createChallenge(store, await sessionForRequest()));
    }
    const svgMatch = path.match(/^\/api\/challenge\/([a-zA-Z0-9_-]{16})\.svg$/);
    if (method === 'GET' && svgMatch) {
      const current = await getSession(req, store);
      const found = current && await store.getChallenge(svgMatch[1], current);
      if (!found) throw new HttpError(404, '验证码已失效');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; sandbox" });
      return res.end(challengeImage(found));
    }
    if (method === 'POST' && ['/api/register', '/api/login'].includes(path)) {
      limit('auth:' + localRequest, 50, 60_000);
      const registration = path === '/api/register';
      const input = await body(req);
      const account = credentials(input);
      if (!account) throw new HttpError(400, '用户名需要 2–30 个字母、汉字、数字、横线或下划线，密码需要 8–72 个字符');
      const current = await sessionForRequest();
      limit('auth-session:' + current.id, 12, 60_000);
      if (pending.has(workspaceOwner(current)) || authenticating.has(current.id)) {
        throw new HttpError(409, '请等待当前操作完成后重试');
      }
      authenticating.add(current.id);
      try {
        let userId;
        if (registration) {
          if (typeof input.challengeId !== 'string' || !Number.isInteger(input.choice)
            || !await store.consumeChallenge(input.challengeId, current, input.choice)) {
            throw new HttpError(400, '验证码错误或已过期，请重新选择');
          }
          if (await store.user(account.handle)) throw new HttpError(409, '该用户名已被使用');
          const { salt, digest } = await passwordDigest(account.password);
          try {
            userId = await store.addUser(account.handle, account.username, salt, digest);
          } catch (error) {
            if (error.code === '23505') throw new HttpError(409, '该用户名已被使用');
            throw error;
          }
        } else {
          const stored = await store.user(account.handle);
          if (!await passwordMatches(account.password, stored)) throw new HttpError(401, '用户名或密码不正确');
          userId = stored.id;
        }
        const created = await store.newSession(userId, current);
        cookie(res, created.token, secure);
        return json(res, registration ? 201 : 200, { user: viewer(created.session) });
      } finally {
        authenticating.delete(current.id);
      }
    }
    if (method === 'POST' && path === '/api/logout') {
      const current = await getSession(req, store);
      if (current && (pending.has(workspaceOwner(current)) || authenticating.has(current.id))) {
        throw new HttpError(409, '请等待当前操作完成后重试');
      }
      await store.logout(current);
      cookie(res, '', secure);
      return json(res, 200, { user: null });
    }
    const privateMatch = path.match(/^\/api\/projects\/([a-zA-Z0-9_-]{4,36})(?:\/(publication|state|download))?$/);
    if (privateMatch && ['GET', 'POST'].includes(method)) {
      const current = await getSession(req, store);
      const row = await store.project(privateMatch[1]);
      if (!row || (row.owner !== seedOwner && (!current || row.owner !== workspaceOwner(current)))) {
        throw new HttpError(404, '找不到这个生成记录');
      }
      const operation = privateMatch[2];
      if (!operation && method === 'GET') return json(res, 200, await detailsFor(row, current ?? {}));
      if (operation === 'download' && method === 'GET' && canPublish(row)) return exportProject(res, row);
      if (!current?.user_id || row.owner === seedOwner) throw new HttpError(403, '需要作品所属账号');
      const root = await store.projectRoot(row);
      if (operation === 'state') return serveState(req, res, root, current);
      if (operation === 'publication' && method === 'POST') {
        const { action } = await body(req);
        if (!['publish', 'unpublish'].includes(action)) throw new HttpError(400, '发布操作无效');
        if (action === 'publish' && !canPublish(row)) throw new HttpError(409, '只有通过验收的版本可以发布');
        const published = await store.setPublication(root, row.id, action === 'publish');
        return json(res, 200, publicationInfo(published, row));
      }
    }
    if (method === 'POST' && path === '/api/generate') {
      const current = await getSession(req, store);
      if (!current?.user_id) throw new HttpError(401, '请登录或注册后生成应用');
      const input = await body(req);
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt.length < 2 || prompt.length > 800) throw new HttpError(400, '请填写 2–800 字的应用描述');
      const owner = workspaceOwner(current);
      if (pending.has(owner) || authenticating.has(current.id)) {
        throw new HttpError(409, '正在处理上一条请求，请稍后再试');
      }
      if (agent && pending.size >= 3) throw new HttpError(429, '生成服务繁忙，请稍后重试');
      limit('generate:' + owner, agent ? 16 : 12, agent ? 3600_000 : 60_000);
      limit('generate-ip:' + localRequest, agent ? 60 : 100, agent ? 3600_000 : 60_000);
      pending.add(owner);
      const cancellation = new AbortController();
      res.on('close', () => cancellation.abort());
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const started = performance.now();
      const timeline = [];
      function track(stage, message) {
        const entry = { stage, message, elapsedMs: Math.round(performance.now() - started) };
        timeline.push(entry);
        return entry;
      }
      function emit(stage, message, data = {}) {
        const entry = track(stage, message);
        if (!res.destroyed) res.write(JSON.stringify({ ...entry, ...data }) + '\n');
      }
      try {
        let project;
        let parent;
        if (agent ? input.projectId : isRevision(prompt)) {
          const id = typeof input.projectId === 'string' && /^[\w-]{4,36}$/.test(input.projectId) ? input.projectId : '';
          parent = id && await store.project(id);
          if (!parent || (parent.owner !== owner && parent.owner !== seedOwner)) {
            emit('error', '请先打开你生成的应用，再输入修改要求。');
            return;
          }
          if (res.destroyed) return;
          project = agent ? await generateWeb(prompt, parent, agent, emit, cancellation.signal) : revise(prompt, parent, emit);
        } else if (agent) {
          project = await generateWeb(prompt, null, agent, emit, cancellation.signal);
        } else {
          project = await generate(prompt, model, emit, cancellation.signal);
        }
        if (project?.error) {
          emit('error', project.error);
        } else if (!project) {
          emit('error', '当前支持计算器、数字合成游戏和秒表。请试试首页示例，或者换一个更具体的描述。');
        } else {
          const passed = project.checks.length > 0 && project.checks.every(test => test.passed === true);
          emit('verify', passed ? '验收通过，可以发布此版本' : '验收未通过，请查看测试结果');
          if (!passed && project.kind !== 'web') {
            emit('error', '有测试项未通过，请修改需求后重试。', { checks: project.checks });
          } else if (!res.destroyed) {
            const draft = project.source === 'draft';
            const ending = track(draft ? 'draft' : 'done',
              draft ? '已保存未通过验收的草稿' : '已完成，可以在工作台发布');
            const rootId = parent?.owner === owner ? await store.projectRoot(parent) : undefined;
            if (res.destroyed) return;
            const saved = await store.saveProject({ ...project, rootId, timeline }, owner, prompt);
            const details = await detailsFor(saved, current);
            if (!res.destroyed) res.write(JSON.stringify({ ...ending, project: details }) + '\n');
          }
        }
      } catch {
        emit('error', '生成失败，请稍后重试。');
      } finally {
        pending.delete(owner);
        res.end();
      }
      return;
    }
    throw new HttpError(404, '页面不存在');
  }

  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) return res.end();
      if (!(error instanceof HttpError)) console.error('Request failed:', error.code ?? error.name);
      json(res, error.status ?? 500, { error: error.status ? error.message : '服务器暂不可用，请稍后重试' });
    });
  });
  server.once('close', () => { void store.close(); });
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = await createStudioServer({
    databaseUrl: process.env.DATABASE_URL,
    model: { baseUrl: process.env.LLM_BASE_URL, model: process.env.LLM_MODEL, key: process.env.LLM_API_KEY },
    agent: { key: process.env.DEEPSEEK_API_KEY, model: process.env.DEEPSEEK_MODEL, socketPath: process.env.QA_SOCKET_PATH },
    publicOrigin: process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : undefined
  });
  server.listen(port, host, () => console.log('Atoms Demo listening on port ' + server.address().port));
}
