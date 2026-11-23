import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createStudioServer } from '../src/server.js';
import { examples } from '../src/spec.js';

async function listen(context, server) {
  server = await server;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

function studio(options = {}) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('请设置 TEST_DATABASE_URL 指向独立的 PostgreSQL 测试数据库');
  const schema = 'check_' + randomBytes(8).toString('hex');
  return createStudioServer({ databaseUrl, schema, ...options });
}

function client(base) {
  let cookie = '';
  return async (path, payload) => {
    const headers = cookie ? { Cookie: cookie } : {};
    let init = { headers };
    if (payload !== undefined) {
      init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    }
    const response = await fetch(base + path, init);
    const saved = response.headers.get('set-cookie');
    if (saved) cookie = saved.split(';')[0];
    return response;
  };
}

async function events(response) {
  assert.equal(response.status, 200);
  return (await response.text()).trim().split('\n').map(line => JSON.parse(line));
}

async function solveChallenge(request) {
  const names = new Map([
    ['圆形', '<circle'], ['三角形', 'M55 19 81'],
    ['正方形', 'width="42"'], ['菱形', 'M55 18 82'],
    ['星形', 'm55 16 8'], ['十字形', 'M47 21h16']
  ]);
  const answer = await (await request('/api/challenge')).json();
  const svg = await (await request(answer.image)).text();
  const symbol = names.get(answer.instruction.replace('请点击图中的', ''));
  const tiles = svg.split('<g transform="translate(').slice(1);
  const choice = tiles.findIndex(tile => tile.includes(symbol));
  assert.ok(choice >= 0 && tiles.length === 6);
  return { challengeId: answer.id, choice };
}

test('三项真实交互检查通过后才发出访客可打开的成品链接', async t => {
  const base = await listen(t, studio());
  const visitor = client(base);
  const stranger = client(base);
  const initial = await (await visitor('/api/bootstrap')).json();
  assert.equal(initial.user, null);
  assert.equal(initial.featured.length, 3);
  assert.deepEqual(initial.history, []);

  for (const { prompt, spec } of examples) {
    const steps = await events(await visitor('/api/generate', { prompt }));
    assert.deepEqual(steps.map(item => item.stage), ['plan', 'build', 'check', 'done']);
    const { project } = steps.at(-1);
    assert.equal(project.kind, spec.kind);
    assert.equal(project.source, 'fallback');
    assert.ok(project.checks.length >= 6 && project.checks.every(item => item.passed));
    const shared = await stranger(project.url);
    assert.equal(shared.status, 200);
    assert.match(await shared.text(), new RegExp('data-app="' + spec.kind + '"'));
    assert.match((await stranger(project.url + '/download')).headers.get('content-disposition'), /attachment/);
    assert.equal((await stranger('/api/projects/' + project.id)).status, 404);
  }

  const unsupported = (await events(await visitor('/api/generate', { prompt: '做一个邮轮购票系统' }))).at(-1);
  assert.equal(unsupported.stage, 'error');
  assert.equal(unsupported.project, undefined);
  assert.equal((await (await visitor('/api/bootstrap')).json()).history.length, 3);
});

test('点击图像验证码注册，退出后用用户名密码登录并恢复记录', async t => {
  const base = await listen(t, studio());
  const visitor = client(base);
  await visitor('/api/bootstrap');
  const saved = (await events(await visitor('/api/generate', { prompt: '做一个秒表' }))).at(-1).project;
  const account = { username: 'reviewer_one', password: 'local-check-51!' };

  const answer = await solveChallenge(visitor);
  const wrong = await visitor('/api/register', { ...account, ...answer, choice: (answer.choice + 1) % 6 });
  assert.equal(wrong.status, 400);
  assert.equal((await visitor('/api/register', { ...account, ...answer })).status, 400);
  const registered = await visitor('/api/register', { ...account, ...await solveChallenge(visitor) });
  assert.equal(registered.status, 201);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);

  assert.equal((await visitor('/api/logout', {})).status, 200);
  assert.equal((await visitor('/api/projects/' + saved.id)).status, 404);
  assert.equal((await visitor('/api/login', { ...account, password: 'incorrect-51!' })).status, 401);
  const login = await visitor('/api/login', account);
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.username, account.username);
  const restored = await (await visitor('/api/bootstrap')).json();
  assert.equal(restored.history[0].id, saved.id);
});

test('兼容模型返回新公式，限流重试成功并签发新应用', async t => {
  let calls = 0;
  const modelHost = await listen(t, createServer(async (request, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer test-only-key');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    assert.equal(payload.model, 'synthetic-calculation');
    assert.equal(payload.response_format.type, 'json_object');
    assert.equal(payload.messages[1].content, '做一个出差补贴计算器');
    calls++;
    if (calls === 1) {
      response.writeHead(429).end();
      return;
    }
    const spec = {
      kind: 'calculator', title: '出差补贴计算器', description: '按天数乘日补贴金额。',
      fields: [{ id: 'days', label: '天数', value: 3 }, { id: 'daily', label: '日补贴', value: 50 }],
      formula: { op: 'mul', args: ['days', 'daily'] }, resultLabel: '总补贴', unit: '元'
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(spec) } }] }));
  }));
  const base = await listen(t, studio({
    model: { baseUrl: modelHost + '/v1', model: 'synthetic-calculation', key: 'test-only-key' }
  }));
  const visitor = client(base);
  const result = (await events(await visitor('/api/generate', { prompt: '做一个出差补贴计算器' }))).at(-1);
  assert.equal(calls, 2);
  assert.equal(result.stage, 'done');
  assert.equal(result.project.source, 'model');
  assert.equal(result.project.title, '出差补贴计算器');
  assert.equal((await visitor(result.project.url)).status, 200);
});

test('无效模型密钥时，验收链仍生成可操作秒表', async t => {
  const modelHost = await listen(t, createServer((request, response) => { response.writeHead(401).end(); }));
  const base = await listen(t, studio({
    model: { baseUrl: modelHost, model: 'fake-model', key: 'invalid-test-key' }
  }));
  const visitor = client(base);
  const result = await events(await visitor('/api/generate', { prompt: '做一个秒表' }));
  assert.ok(result.some(entry => entry.stage === 'fallback'));
  assert.equal(result.at(-1).project.source, 'fallback');
  assert.equal((await visitor(result.at(-1).project.url)).status, 200);
});

test('秒表增量修改新增计次，通过检查才出新链接，失败与越权均保留旧版', async t => {
  const base = await listen(t, studio());
  const owner = client(base);
  const stranger = client(base);
  const original = (await events(await owner('/api/generate', { prompt: '做一个秒表' }))).at(-1).project;
  const previousHtml = await (await owner(original.url)).text();
  assert.doesNotMatch(previousHtml, /id="lap"/);
  const request = { prompt: '给刚才这个秒表增加计次功能，保留现有操作。', projectId: original.id };
  assert.equal((await events(await stranger('/api/generate', request))).at(-1).stage, 'error');
  const modified = (await events(await owner('/api/generate', request))).at(-1);
  assert.equal(modified.stage, 'done');
  assert.equal(modified.project.parentId, original.id);
  assert.notEqual(modified.project.url, original.url);
  assert.ok(modified.project.checks.some(item => item.label === '计次记录当前累积时间' && item.passed));
  assert.match(await (await stranger(modified.project.url)).text(), /id="lap"/);
  assert.equal((await events(await owner('/api/generate', {
    prompt: '修改当前应用为倒计时', projectId: modified.project.id
  }))).at(-1).stage, 'error');
  const recovered = await (await owner('/api/projects/' + modified.project.id)).json();
  assert.equal(recovered.parentId, original.id);
  assert.equal(await (await owner(original.url)).text(), previousHtml);
  assert.equal((await (await owner('/api/bootstrap')).json()).history.length, 2);
});

test('取消模型生成会关闭上游请求，前一个产物不会被覆盖', { timeout: 6000 }, async t => {
  let started;
  let disconnected;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const requestClosed = new Promise(resolve => { disconnected = resolve; });
  const modelHost = await listen(t, createServer((_request, response) => {
    started();
    response.once('close', disconnected);
  }));
  const base = await listen(t, studio({
    model: { baseUrl: modelHost, model: 'cancel-check', key: randomBytes(16).toString('hex') }
  }));
  const bootstrap = await fetch(base + '/api/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const cancellation = new AbortController();
  const response = await fetch(base + '/api/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ prompt: '做一个窗帘预算计算器' }), signal: cancellation.signal
  });
  assert.equal(response.status, 200);
  await requestStarted;
  cancellation.abort();
  await requestClosed;
  const details = await (await fetch(base + '/api/bootstrap', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(details.history, []);
  assert.equal((await fetch(base + '/apps/curtain-budget')).status, 200);
});
