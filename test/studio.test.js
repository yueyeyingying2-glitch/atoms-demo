import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createStudioServer } from '../src/server.js';
import { createStore } from '../src/store.js';
import { assemble } from '../src/generate.js';
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
  return async (path, payload, options = {}) => {
    const headers = cookie ? { Cookie: cookie } : {};
    let init = { headers };
    if (payload !== undefined) {
      init = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    }
    const response = await fetch(base + path, { ...init, ...options });
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

async function register(request, suffix = '') {
  const account = { username: 'reviewer_' + randomBytes(4).toString('hex') + suffix, password: 'test-account-81!' };
  const response = await request('/api/register', { ...account, ...await solveChallenge(request) });
  assert.equal(response.status, 201);
  return account;
}

const publicationPath = id => '/api/projects/' + id + '/publication';

async function publish(request, id) {
  const response = await request(publicationPath(id), { action: 'publish' });
  assert.equal(response.status, 200);
  const published = await response.json();
  assert.equal(published.status, 'published');
  assert.equal(published.versionId, id);
  return published.url;
}

test('游客不能生成，三项成品由账号发布后可供访客操作', async t => {
  const base = await listen(t, studio());
  const visitor = client(base);
  const stranger = client(base);
  const initial = await (await visitor('/api/bootstrap')).json();
  assert.equal(initial.user, null);
  assert.equal(initial.featured.length, 3);
  assert.deepEqual(initial.history, []);
  assert.equal((await visitor('/api/generate', { prompt: examples[0].prompt })).status, 401);
  assert.equal((await stranger(initial.featured[0].url)).status, 200);
  await register(visitor);

  for (const { prompt, spec } of examples) {
    const steps = await events(await visitor('/api/generate', { prompt }));
    assert.deepEqual(steps.map(item => item.stage), ['plan', 'build', 'check', 'verify', 'done']);
    const { project } = steps.at(-1);
    assert.equal(project.kind, spec.kind);
    assert.equal(project.source, 'fallback');
    assert.ok(project.checks.length >= 6 && project.checks.every(item => item.passed));
    assert.equal(project.publication.status, 'unpublished');
    assert.equal(project.url, null);
    assert.equal((await stranger('/preview/' + project.id)).status, 404);
    assert.equal((await stranger('/apps/' + project.id)).status, 404);
    assert.equal((await visitor('/preview/' + project.id)).status, 200);
    const link = await publish(visitor, project.id);
    const shared = await stranger(link);
    assert.equal(shared.status, 200);
    assert.match(await shared.text(), /sandbox="allow-scripts allow-forms"/);
    assert.match(await (await stranger(link + '/content')).text(), new RegExp('data-app="' + spec.kind + '"'));
    assert.match((await stranger(link + '/download')).headers.get('content-disposition'), /attachment/);
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
  const account = { username: 'reviewer_one', password: 'local-check-51!' };

  const answer = await solveChallenge(visitor);
  const wrong = await visitor('/api/register', { ...account, ...answer, choice: (answer.choice + 1) % 6 });
  assert.equal(wrong.status, 400);
  assert.equal((await visitor('/api/register', { ...account, ...answer })).status, 400);
  const registered = await visitor('/api/register', { ...account, ...await solveChallenge(visitor) });
  assert.equal(registered.status, 201);
  assert.match(registered.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const saved = (await events(await visitor('/api/generate', { prompt: '做一个秒表' }))).at(-1).project;

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
  await register(visitor);
  const result = (await events(await visitor('/api/generate', { prompt: '做一个出差补贴计算器' }))).at(-1);
  assert.equal(calls, 2);
  assert.equal(result.stage, 'done');
  assert.equal(result.project.source, 'model');
  assert.equal(result.project.title, '出差补贴计算器');
  assert.equal((await visitor(await publish(visitor, result.project.id))).status, 200);
});

test('无效模型密钥时，验收链仍生成可操作秒表', async t => {
  const modelHost = await listen(t, createServer((request, response) => { response.writeHead(401).end(); }));
  const base = await listen(t, studio({
    model: { baseUrl: modelHost, model: 'fake-model', key: 'invalid-test-key' }
  }));
  const visitor = client(base);
  await register(visitor);
  const result = await events(await visitor('/api/generate', { prompt: '做一个秒表' }));
  assert.ok(result.some(entry => entry.stage === 'fallback'));
  assert.equal(result.at(-1).project.source, 'fallback');
  assert.equal((await visitor(await publish(visitor, result.at(-1).project.id))).status, 200);
});

test('秒表增量修改、版本历史、更新发布和下线权限', async t => {
  const base = await listen(t, studio());
  const owner = client(base);
  const stranger = client(base);
  const anonymous = client(base);
  await register(owner);
  await register(stranger);
  const original = (await events(await owner('/api/generate', { prompt: '做一个秒表' }))).at(-1).project;
  const link = await publish(owner, original.id);
  const previousHtml = await (await anonymous(link + '/content')).text();
  assert.doesNotMatch(previousHtml, /id="lap"/);
  const request = { prompt: '给刚才这个秒表增加计次功能，保留现有操作。', projectId: original.id };
  assert.equal((await events(await stranger('/api/generate', request))).at(-1).stage, 'error');
  const modified = (await events(await owner('/api/generate', request))).at(-1);
  assert.equal(modified.stage, 'done');
  assert.equal(modified.project.parentId, original.id);
  assert.equal(modified.project.url, link);
  assert.equal(modified.project.publication.versionId, original.id);
  assert.deepEqual(modified.project.versions.map(item => [item.id, item.number]), [[original.id, 1], [modified.project.id, 2]]);
  assert.ok(modified.project.checks.some(item => item.label === '计次记录当前累积时间' && item.passed));
  assert.doesNotMatch(await (await anonymous(link + '/content')).text(), /id="lap"/);
  assert.equal((await stranger(publicationPath(modified.project.id), { action: 'publish' })).status, 404);
  assert.equal(await publish(owner, modified.project.id), link);
  assert.match(await (await anonymous(link + '/content')).text(), /id="lap"/);
  assert.equal((await events(await owner('/api/generate', {
    prompt: '修改当前应用为倒计时', projectId: modified.project.id
  }))).at(-1).stage, 'error');
  const recovered = await (await owner('/api/projects/' + modified.project.id)).json();
  assert.equal(recovered.parentId, original.id);
  assert.equal(await (await owner('/preview/' + original.id)).text(), previousHtml);
  assert.equal((await (await owner('/api/bootstrap')).json()).history.length, 2);
  assert.equal((await stranger(publicationPath(original.id), { action: 'unpublish' })).status, 404);
  assert.equal((await owner(publicationPath(original.id), { action: 'unpublish' })).status, 200);
  for (const url of [link, link + '/content', link + '/download']) {
    const unavailable = await anonymous(url);
    assert.equal(unavailable.status, 410);
    assert.match(await unavailable.text(), /应用已下线/);
  }
  assert.equal((await anonymous('/preview/' + modified.project.id)).status, 404);
  assert.equal((await owner('/preview/' + modified.project.id)).status, 200);
  assert.equal(await publish(owner, original.id), link);
  assert.doesNotMatch(await (await anonymous(link + '/content')).text(), /id="lap"/);
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
  const visitor = client(base);
  await register(visitor);
  const cancellation = new AbortController();
  const response = await visitor('/api/generate', { prompt: '做一个窗帘预算计算器' }, { signal: cancellation.signal });
  assert.equal(response.status, 200);
  await requestStarted;
  cancellation.abort();
  await requestClosed;
  const details = await (await visitor('/api/bootstrap')).json();
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
    check('首屏显示阅读选项', [['contains', 'reading', '']]),
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
  const account = await register(visitor);
  const stranger = client(base);
  const mortgage = await events(await visitor('/api/generate', { prompt: '做个提前还款计算器，并在刷新后保留方案' }));
  assert.deepEqual(mortgage.map(item => item.stage), ['plan', 'build', 'check', 'verify', 'done'], JSON.stringify(mortgage.at(-1).project?.checks));
  const original = mortgage.at(-1).project;
  assert.equal(original.source, 'model');
  assert.equal(original.model, 'deepseek-flash');
  assert.equal(original.plan.cases.length, 2);
  assert.equal(original.checks.length, 3);
  assert.ok(original.checks.every(item => item.passed));
  const publishedLink = await publish(visitor, original.id);
  const shared = await stranger(publishedLink);
  assert.equal(shared.status, 200);
  assert.match(await shared.text(), /sandbox="allow-scripts allow-forms"/);
  const preview = await stranger(publishedLink + '/content');
  assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
  assert.match(await preview.text(), /atoms-storage/);
  assert.match((await stranger(publishedLink + '/download')).headers.get('content-disposition'), /attachment/);

  const revised = (await events(await visitor('/api/generate', { prompt: '改成蓝色', projectId: original.id }))).at(-1).project;
  assert.equal(revised.parentId, original.id);
  assert.equal(revised.url, publishedLink);
  assert.match(revised.html, /color:navy/);
  assert.equal(received[2].previous.html, original.html);
  assert.doesNotMatch(await (await stranger(publishedLink + '/content')).text(), /color:navy/);
  assert.equal(await publish(visitor, revised.id), publishedLink);

  const failed = (await events(await visitor('/api/generate', { prompt: '模拟计算发生故障', projectId: revised.id }))).at(-1);
  assert.equal(failed.stage, 'draft');
  assert.equal(failed.project.source, 'draft');
  assert.equal(failed.project.publication.versionId, revised.id);
  assert.equal(failed.project.canPublish, false);
  assert.equal((await visitor(publicationPath(failed.project.id), { action: 'publish' })).status, 409);
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
  assert.deepEqual(repair.map(item => item.stage), ['plan', 'build', 'check', 'repair', 'check', 'verify', 'done']);
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
      await page.locator('#auth-dialog').waitFor({ state: 'visible' });
      await page.locator('#username').fill(account.username);
      await page.locator('#password').fill(account.password);
      await page.locator('#auth-submit').click();
      try {
        await page.locator('#publication-open').waitFor({ state: 'visible', timeout: 60_000 });
      } catch (error) {
        t.diagnostic(await page.locator('#progress').innerText());
        throw error;
      }
      assert.equal(await page.locator('#plan-title').textContent(), '习惯打卡');
      assert.match(await page.locator('#source-tag').textContent(), /DeepSeek/);
      await page.locator('#mobile-preview').click();
      assert.equal(Math.round((await page.locator('#preview').boundingBox()).width), 390);
      const artifact = page.frameLocator('#preview');
      await artifact.getByTestId('reading').click();
      assert.equal(await artifact.getByTestId('total').textContent(), '1');
      await page.locator('#tests-tab').click();
      assert.equal(await page.locator('#test-list .test-pass').count(), 4);
      await page.locator('#code-tab').click();
      assert.match(await page.locator('#project-code').textContent(), /reading.onclick/);
      await page.locator('#publication-open').click();
      await page.locator('#publish-current').click();
      await page.locator('#open-app').waitFor({state:'visible'});
      const visitorPage = await (await browser.newContext()).newPage();
      await visitorPage.goto(await page.locator('#open-app').getAttribute('href'));
      await page.locator('#publication-close').click();
      const sharedFrame = visitorPage.frameLocator('#shared-app');
      await sharedFrame.getByTestId('reading').click();
      assert.equal(await sharedFrame.getByTestId('total').textContent(), '1');
      await page.reload();
      await page.locator('#publication-open').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#plan-title').textContent(), '习惯打卡');
      assert.deepEqual(errors, []);
      if (process.env.TEST_STUDIO_SCREENSHOT) await page.screenshot({ path: process.env.TEST_STUDIO_SCREENSHOT });
    } finally {
      await browser.close();
    }
  }
});

test('旧版公开链接可继续访问，作者纳管后也随同下线', async t => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const schema = 'legacy_' + randomBytes(8).toString('hex');
  const base = await listen(t, createStudioServer({ databaseUrl, schema }));
  const owner = client(base);
  const account = await register(owner);
  const store = await createStore(databaseUrl, schema);
  const { id: userId } = await store.user(account.username);
  const example = examples.find(item => item.spec.kind === 'stopwatch');
  const compiled = assemble(example.spec, example.prompt, 'fallback');
  const legacy = await store.saveProject(compiled, 'account:' + userId, example.prompt);
  await store.close();

  const guest = client(base);
  const oldUrl = '/apps/' + legacy.id;
  assert.match(await (await guest(oldUrl)).text(), /id="readout"/);
  assert.equal((await guest('/preview/' + legacy.id)).status, 200);
  const version = (await events(await owner('/api/generate', {
    prompt: '给刚才这个秒表增加计次功能', projectId: legacy.id
  }))).at(-1).project;
  assert.deepEqual(version.versions.map(item => item.id), [legacy.id, version.id]);
  const link = await publish(owner, version.id);
  const forwarded = await guest(oldUrl);
  assert.equal(new URL(forwarded.url).pathname, link);
  assert.equal((await guest('/preview/' + legacy.id)).status, 404);
  assert.equal((await owner(publicationPath(version.id), { action: 'unpublish' })).status, 200);
  assert.equal((await guest(oldUrl)).status, 410);
  assert.equal((await guest(oldUrl + '/download')).status, 410);
  assert.equal((await guest('/apps/stopwatch')).status, 200);
});

test('账号工具记录按账号隔离，共享工具允许游客在本地操作', async t => {
  const base = await listen(t, studio());
  const owner = client(base);
  const account = await register(owner);
  const other = client(base);
  await register(other);
  const project = (await events(await owner('/api/generate', { prompt: examples[0].prompt }))).at(-1).project;
  const save = project.stateUrl;
  const initial = await (await owner(save)).json();
  assert.deepEqual(initial.entries, []);
  assert.equal(initial.revision, 0);
  const entries = [['history', '[{"total":600}]']];
  assert.equal((await owner(save, { ...initial, entries })).status, 200);
  assert.equal((await owner(save, { ...initial, entries: [] })).status, 409);
  assert.equal((await other(save)).status, 404);

  const secondDevice = client(base);
  assert.equal((await secondDevice('/api/login', account)).status, 200);
  const synced = await (await secondDevice(save)).json();
  assert.deepEqual(synced, { account: initial.account, entries, revision: 1 });

  const link = await publish(owner, project.id);
  const sharedState = '/api/shared/' + link.split('/').at(-1) + '/state';
  const guest = client(base);
  assert.deepEqual(await (await guest(sharedState)).json(), { guest: true });
  assert.equal((await guest(sharedState, synced)).status, 401);
  const otherState = await (await other(sharedState)).json();
  assert.deepEqual(otherState.entries, []);
  assert.equal((await other(sharedState, synced)).status, 409);
  assert.equal((await other(sharedState, { ...otherState, entries: [['other', 'isolated']] })).status, 200);
  assert.deepEqual(await (await owner(sharedState)).json(), synced);
  assert.equal((await owner(publicationPath(project.id), { action: 'unpublish' })).status, 200);
  assert.equal((await other(sharedState)).status, 404);
  assert.deepEqual(await (await owner(save)).json(), synced);
});

test('真实浏览器操作登录弹窗、发布、跨设备历史和下线', {
  skip: !process.env.TEST_CHROME && '需要设置 TEST_CHROME'
}, async t => {
  const base = await listen(t, studio());
  const account = await register(client(base));
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROME, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const owner = await context.newPage();
  const second = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  const errors = [];
  for (const page of [owner, second, guest]) page.on('pageerror', error => errors.push(error.message));
  let generationCalls = 0;
  owner.on('request', request => { if (new URL(request.url()).pathname === '/api/generate') generationCalls++; });
  async function signIn(page) {
    await page.locator('#username').fill(account.username);
    await page.locator('#password').fill(account.password);
    await page.locator('#auth-submit').click();
    await page.locator('#account-name').waitFor();
  }
  async function localSave(frame, width) {
    await frame.locator('#field-width').fill(width);
    await frame.locator('#save-calculation').click();
    await frame.locator('#calculation-history li').first().waitFor();
  }
  try {
    await owner.goto(base);
    await owner.locator('#home-prompt').fill(examples[0].prompt);
    await owner.locator('#home-prompt').press('Enter');
    await owner.locator('#auth-dialog').waitFor();
    await owner.locator('#auth-switch').click();
    await owner.locator('#challenge-image').waitFor();
    await owner.locator('#auth-close').click();
    assert.equal(await owner.locator('#home-prompt').inputValue(), examples[0].prompt);
    assert.equal(generationCalls, 0);
    await owner.locator('#home-form button[type=submit]').click();
    await signIn(owner);
    await owner.locator('#publication-open').waitFor();
    assert.equal(generationCalls, 1);
    assert.deepEqual(await owner.locator('#development-stages li').evaluateAll(items => items.map(
      item => [item.getAttribute('aria-label').split('，')[0], item.dataset.state]
    )), [['需求规划', 'complete'], ['代码生成', 'complete'], ['测试', 'complete'], ['验收', 'complete'], ['完成', 'complete']]);
    await owner.locator('#versions-open').click();
    assert.match(await owner.locator('#versions-list').textContent(), /v1.*窗帘预算计算器/);
    await owner.locator('#versions-close').click();

    const editor = owner.frameLocator('#preview');
    await localSave(editor, '3');
    await owner.getByText('工具记录已同步到账号', { exact: true }).waitFor();
    assert.match(await editor.locator('#calculation-history li').first().innerText(), /600/);

    await second.goto(base);
    await second.locator('#login-open').click();
    await signIn(second);
    await second.goto(owner.url());
    const secondEditor = second.frameLocator('#preview');
    assert.match(await secondEditor.locator('#calculation-history li').first().innerText(), /600/);
    await secondEditor.locator('#field-width').fill('4');
    await secondEditor.getByRole('button', { name: '加载' }).click();
    assert.equal(await secondEditor.locator('#field-width').inputValue(), '3');

    await owner.locator('#publication-open').click();
    await owner.locator('#publish-current').click();
    await owner.locator('#open-app').waitFor();
    const url = await owner.locator('#share-url').inputValue();
    const visitorView = await context.newPage();
    await visitorView.goto(await owner.locator('#open-guest').getAttribute('href'));
    const isolated = visitorView.frameLocator('#shared-app');
    await isolated.locator('#calculation-history-empty').waitFor();
    assert.equal(await isolated.locator('#calculation-history li').count(), 0);
    assert.equal((await guest.goto(url)).status(), 200);
    const publicTool = guest.frameLocator('#shared-app');
    await localSave(publicTool, '6');
    assert.match(await publicTool.locator('#calculation-history li').first().innerText(), /1,200/);
    await guest.reload();
    assert.match(await publicTool.locator('#calculation-history li').first().innerText(), /1,200/);

    await secondEditor.getByRole('button', { name: '删除' }).click();
    await second.getByText('工具记录已同步到账号', { exact: true }).waitFor();
    await second.reload();
    await secondEditor.locator('#calculation-history-empty').waitFor();
    assert.equal(await secondEditor.locator('#calculation-history li').count(), 0);

    await owner.locator('#unpublish').click();
    await owner.getByRole('heading', { name: '应用已下线' }).waitFor();
    assert.equal((await guest.reload()).status(), 410);
    await guest.getByRole('heading', { name: '应用已下线' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
