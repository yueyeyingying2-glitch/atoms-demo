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

const check = (label, steps) => ({ label, steps: steps.map(([action, target, value]) => ({ action, target, value })) });

test('DeepSeek 协议、自由生成、真实浏览器验收、草稿权限和版本', {
  skip: !process.env.TEST_QA_SOCKET && '需要设置 TEST_QA_SOCKET'
}, async t => {
  const mortgageCases = [
    check('计算提前还款后的剩余本金', [
      ['fill', 'balance', '9000'], ['fill', 'advance', '2000'], ['click', 'calculate'], ['text', 'result', '7000']
    ]),
    check('保存方案后刷新仍有记录', [
      ['fill', 'balance', '9000'], ['fill', 'advance', '2000'], ['click', 'calculate'], ['click', 'save'],
      ['reload'], ['text', 'saved', '7000']
    ])
  ];
  const habitCases = [
    check('记录今日阅读', [['click', 'reading'], ['text', 'total', '1']]),
    check('重复点击可撤销', [['click', 'reading'], ['click', 'reading'], ['count', 'total', '1'], ['text', 'total', 0]])
  ];
  const received = [];
  const modelHost = await listen(t, createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer mock-deepseek-key');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw);
      assert.equal(payload.model, 'deepseek-flash');
      assert.equal(payload.response_format.type, 'json_object');
      assert.equal(payload.thinking.type, 'disabled');
      const data = JSON.parse(payload.messages[1].content);
      received.push(data);
      const habits = data.prompt.includes('习惯');
      const failing = data.prompt.includes('故障') || (data.prompt.includes('自修复') && !data.repair);
      const revision = data.prompt.includes('蓝色');
      const title = habits ? '习惯打卡' : '提前还款计算器';
      const content = !data.plan ? {
        title, description: '本地验收用应用', requirements: habits ? ['切换阅读打卡状态'] : ['计算剩余本金', '保存方案'],
        cases: habits ? habitCases : mortgageCases
      } : { html: habits ? `<!doctype html><html lang="zh"><head><title>习惯打卡</title></head>
<body><h1>习惯打卡</h1><button data-testid="reading" id="reading">阅读</button><output data-testid="total" id="total">0</output>
<script>let done=false;reading.onclick=()=>{done=!done;total.textContent=Number(done)}</script></body></html>`
        : `<!doctype html><html lang="zh"><head><title>提前还款计算器</title>${revision ? '<style>body{color:navy}</style>' : ''}</head>
<body><h1>提前还款计算器</h1><label>待还本金<input id="balance" data-testid="balance" type="number" value="0"></label>
<label>提前还款<input id="advance" data-testid="advance" type="number" value="0"></label>
<button id="calculate" data-testid="calculate">计算</button><output id="result" data-testid="result"></output>
<button id="save" data-testid="save">保存</button><p id="saved" data-testid="saved"></p>
<script>calculate.onclick=()=>{result.value=${failing ? '0' : 'Number(balance.value)-Number(advance.value)'}};
save.onclick=()=>{localStorage.setItem('saved',result.value);saved.textContent=result.value};
saved.textContent=localStorage.getItem('saved')??'';</script></body></html>` };
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] }));
    } catch (error) {
      response.writeHead(500).end();
      t.diagnostic(error.message);
    }
  }));
  const base = await listen(t, studio({
    agent: { baseUrl: modelHost, key: 'mock-deepseek-key', socketPath: process.env.TEST_QA_SOCKET }
  }));
  const visitor = client(base);
  assert.equal((await (await visitor('/api/bootstrap')).json()).engine, 'deepseek');
  const stranger = client(base);
  const mortgage = await events(await visitor('/api/generate', { prompt: '做个提前还款计算器，并在刷新后保留方案' }));
  assert.deepEqual(mortgage.map(item => item.stage), ['plan', 'build', 'check', 'done'], JSON.stringify(mortgage.at(-1).project?.checks));
  const original = mortgage.at(-1).project;
  assert.equal(original.source, 'model');
  assert.equal(original.model, 'deepseek-flash');
  assert.equal(original.plan.cases.length, 2);
  assert.equal(original.checks.length, 3);
  assert.ok(original.checks.every(item => item.passed));
  const shared = await stranger(original.url);
  assert.equal(shared.status, 200);
  assert.match(await shared.text(), /sandbox="allow-scripts allow-forms"/);
  const preview = await stranger('/preview/' + original.id);
  assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
  assert.match(await preview.text(), /atoms-storage/);
  assert.match((await stranger(original.url + '/download')).headers.get('content-disposition'), /attachment/);

  const revised = (await events(await visitor('/api/generate', { prompt: '改成蓝色', projectId: original.id }))).at(-1).project;
  assert.equal(revised.parentId, original.id);
  assert.notEqual(revised.url, original.url);
  assert.match(revised.html, /color:navy/);
  assert.equal(received[2].previous.html, original.html);
  assert.doesNotMatch(await (await stranger('/preview/' + original.id)).text(), /color:navy/);

  const failed = (await events(await visitor('/api/generate', { prompt: '模拟计算发生故障', projectId: revised.id }))).at(-1);
  assert.equal(failed.stage, 'draft');
  assert.equal(failed.project.source, 'draft');
  assert.equal(failed.project.url, null);
  assert.equal(failed.project.parentId, revised.id);
  assert.ok(failed.project.checks.some(item => item.passed === false && item.detail.includes('预期')));
  assert.equal((await stranger('/apps/' + failed.project.id)).status, 404);
  assert.equal((await stranger('/preview/' + failed.project.id)).status, 404);
  assert.equal((await visitor('/preview/' + failed.project.id)).status, 200);
  assert.equal((await stranger(revised.url)).status, 200);
  const restored = await (await visitor('/api/projects/' + failed.project.id)).json();
  assert.equal(restored.plan.description, '本地验收用应用');
  assert.deepEqual(restored.checks, failed.project.checks);

  const repair = await events(await visitor('/api/generate', { prompt: '用自修复流程做一个提前还款计算器' }));
  assert.deepEqual(repair.map(item => item.stage), ['plan', 'build', 'check', 'repair', 'check', 'done']);
  assert.ok(repair.at(-1).project.checks.every(item => item.passed));
  assert.ok(received.some(item => item.repair?.checks.some(result => result.passed === false)));

  const habits = (await events(await visitor('/api/generate', { prompt: '做一个习惯打卡网页，支持取消打卡' }))).at(-1);
  assert.equal(habits.stage, 'done', JSON.stringify(habits.project?.checks));
  assert.equal(habits.project.title, '习惯打卡');
  assert.ok(habits.project.checks.every(item => item.passed));

  if (process.env.TEST_CHROME) {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ executablePath: process.env.TEST_CHROME, chromiumSandbox: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.locator('#home-prompt').fill('做一个习惯打卡网页，支持取消打卡');
      await page.locator('#home-form button[type="submit"]').click();
      await page.locator('#open-app').waitFor({ state: 'visible', timeout: 15_000 });
      assert.equal(await page.locator('#plan-title').textContent(), '习惯打卡');
      assert.match(await page.locator('#source-tag').textContent(), /DeepSeek/);
      await page.locator('#mobile-preview').click();
      assert.equal(Math.round((await page.locator('#preview').boundingBox()).width), 390);
      const artifact = page.frameLocator('#preview');
      await artifact.getByTestId('reading').click();
      assert.equal(await artifact.getByTestId('total').textContent(), '1');
      await page.locator('#tests-tab').click();
      assert.equal(await page.locator('#test-list .test-pass').count(), 3);
      await page.locator('#code-tab').click();
      assert.match(await page.locator('#project-code').textContent(), /reading.onclick/);
      const visitorPage = await (await browser.newContext()).newPage();
      await visitorPage.goto(new URL(await page.locator('#open-app').getAttribute('href'), base).href);
      const sharedFrame = visitorPage.frameLocator('#shared-app');
      await sharedFrame.getByTestId('reading').click();
      assert.equal(await sharedFrame.getByTestId('total').textContent(), '1');
      await page.reload();
      await page.locator('#open-app').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#plan-title').textContent(), '习惯打卡');
      assert.deepEqual(errors, []);
      if (process.env.TEST_STUDIO_SCREENSHOT) await page.screenshot({ path: process.env.TEST_STUDIO_SCREENSHOT });
    } finally {
      await browser.close();
    }
  }
});
