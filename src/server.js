import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createStore } from './store.js';
import { challengeImage, createChallenge, credentials, passwordDigest, passwordMatches } from './auth.js';
import { assemble, generate } from './generate.js';
import { examples } from './spec.js';

const files = Object.fromEntries([
  ['/index.html', 'text/html; charset=utf-8'], ['/styles.css', 'text/css; charset=utf-8'],
  ['/studio.js', 'text/javascript; charset=utf-8']
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

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, '需要 JSON 格式');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, '输入内容过长');
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
  const project = {
    id: row.id, kind: row.kind, title: row.title, description: row.description,
    source: row.source, createdAt: Number(row.created_at), url: '/apps/' + row.id
  };
  if (details) {
    project.prompt = row.prompt;
    project.checks = JSON.parse(row.checks);
  }
  return project;
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
  const rates = new Map();
  const pending = new Set();
  const authenticating = new Set();

  for (const example of examples) {
    if (await store.project(example.id)) continue;
    const project = assemble(example.spec, example.prompt, 'example');
    if (!project.checks.every(test => test.passed)) throw new Error('示例未通过验收：' + example.id);
    await store.saveProject(project, seedOwner, example.prompt, example.id);
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

    if (method === 'GET' && (path === '/' || path === '/studio' || files[path])) {
      const file = files[path] ?? files['/index.html'];
      res.writeHead(200, { 'Content-Type': file.type,
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      return res.end(file.bytes);
    }

    const publicMatch = path.match(/^\/(apps|preview)\/([a-zA-Z0-9_-]{4,36})(\/download)?$/);
    if (method === 'GET' && publicMatch) {
      const isPreview = publicMatch[1] === 'preview';
      const row = await store.project(publicMatch[2]);
      if (!row) throw new HttpError(404, '这个应用链接不存在');
      res.writeHead(200, {
        'Content-Type': htmlType,
        'X-Frame-Options': isPreview ? 'SAMEORIGIN' : 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors " + (isPreview ? "'self'" : "'none'"),
        ...(publicMatch[3] && !isPreview ? { 'Content-Disposition': 'attachment; filename="' + row.id + '.html"' } : {})
      });
      return res.end(row.html);
    }
    if (method === 'GET' && path === '/api/bootstrap') {
      const current = await sessionForRequest();
      const featured = await Promise.all(examples.map(async example => ({
        ...projectResponse(await store.project(example.id)), prompt: example.prompt
      })));
      return json(res, 200, {
        user: viewer(current), featured, history: (await store.projects(workspaceOwner(current))).map(row => projectResponse(row))
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
    const privateMatch = path.match(/^\/api\/projects\/([a-zA-Z0-9_-]{4,36})$/);
    if (method === 'GET' && privateMatch) {
      const current = await sessionForRequest();
      const row = await store.project(privateMatch[1]);
      if (!row || (row.owner !== seedOwner && row.owner !== workspaceOwner(current))) {
        throw new HttpError(404, '找不到这个生成记录');
      }
      return json(res, 200, projectResponse(row, true));
    }
    if (method === 'POST' && path === '/api/generate') {
      const current = await sessionForRequest();
      const input = await body(req);
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
      if (prompt.length < 2 || prompt.length > 800) throw new HttpError(400, '请填写 2–800 字的应用描述');
      const owner = workspaceOwner(current);
      if (pending.has(owner) || authenticating.has(current.id)) {
        throw new HttpError(409, '正在处理上一条请求，请稍后再试');
      }
      limit('generate:' + owner, 12, 60_000);
      limit('generate-ip:' + localRequest, 100, 60_000);
      pending.add(owner);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      function emit(stage, message, data = {}) {
        if (!res.destroyed) res.write(JSON.stringify({ stage, message, ...data }) + '\n');
      }
      try {
        const project = await generate(prompt, model, emit);
        if (!project) {
          emit('error', '当前支持计算器、数字合成游戏和秒表。请试试首页示例，或者换一个更具体的描述。');
        } else if (!project.checks.every(test => test.passed)) {
          emit('error', '有测试项未通过，请修改需求后重试。', { checks: project.checks });
        } else if (!res.destroyed) {
          const saved = await store.saveProject(project, owner, prompt);
          emit('done', '测试通过，分享链接已生成', { project: projectResponse(saved, true) });
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
    publicOrigin: process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : undefined
  });
  server.listen(port, host, () => console.log('Atoms Demo listening on port ' + server.address().port));
}
