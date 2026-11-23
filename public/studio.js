const $ = id => document.getElementById(id);
const home = $('home');
const workspace = $('workspace');
const promptInput = $('home-prompt');
const workInput = $('work-prompt');
const auth = $('auth-dialog');
const preview = $('preview');
const captions = { example: '预置示例', model: '模型生成', fallback: '演示模式' };
let currentProject;
let generating = false;
let authMode;
let challenge;
let picked = null;
let toastTimer;
let challengeRequest = 0;

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '请求失败');
  return value;
}

function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

function paintAccount(user) {
  $('login-open').hidden = $('register-open').hidden = Boolean(user);
  $('account-name').hidden = $('logout').hidden = !user;
  $('account-name').textContent = user?.username ?? '';
}

function paintExamples(examples) {
  const suggestions = $('suggestions');
  const grid = $('example-grid');
  suggestions.replaceChildren();
  grid.replaceChildren();
  for (const item of examples) {
    const suggestion = node('button', item.title);
    suggestion.type = 'button';
    suggestion.addEventListener('click', () => {
      promptInput.value = item.prompt;
      promptInput.focus();
    });
    suggestions.append(suggestion);

    const card = node('a', undefined, 'example-card');
    card.href = item.url;
    card.target = '_blank';
    card.rel = 'noopener';
    const art = node('div', undefined, 'card-visual card-' + item.kind);
    art.setAttribute('aria-hidden', 'true');
    if (item.kind === 'game') {
      const tiles = node('div', undefined, 'tiles');
      for (const value of [2, 2, 4, 8]) tiles.append(node('span', value));
      art.append(tiles);
    } else {
      art.append(node('span', item.kind === 'calculator' ? '¥ 600' : '00:08.24'));
    }
    const details = node('div', undefined, 'example-card-body');
    details.append(node('h3', item.title), node('span', '↗'));
    card.append(art, details);
    grid.append(card);
  }
}

function paintHistory(history) {
  const list = $('history-list');
  list.replaceChildren();
  $('history-section').hidden = history.length === 0;
  for (const item of history) {
    const button = node('button', item.title);
    button.type = 'button';
    button.addEventListener('click', () => loadProject(item.id, true));
    const li = node('li');
    li.append(button);
    list.append(li);
  }
}

async function bootstrap() {
  const data = await api('/api/bootstrap');
  paintAccount(data.user);
  paintExamples(data.featured);
  paintHistory(data.history);
}

function showPage() {
  const studio = location.pathname === '/studio';
  home.hidden = studio;
  workspace.hidden = !studio;
  if (studio) $('studio-link').setAttribute('aria-current', 'page');
  else $('studio-link').removeAttribute('aria-current');
}

function navigate(path, replace = false) {
  const current = location.pathname + location.search;
  if (current !== path) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }
  showPage();
}

function selectTab(tests) {
  $('preview-tab').setAttribute('aria-selected', String(!tests));
  $('tests-tab').setAttribute('aria-selected', String(tests));
  $('preview-view').hidden = tests;
  $('tests-view').hidden = !tests;
}

function showChecks(checks = []) {
  const list = $('test-list');
  list.replaceChildren();
  const passes = checks.filter(item => item.passed).length;
  $('test-count').textContent = checks.length ? passes + '/' + checks.length : '';
  $('tests-summary').textContent = checks.length ? passes + ' / ' + checks.length + ' 项通过' : '生成后会自动执行交互测试。';
  for (const check of checks) {
    const row = node('li');
    row.append(node('span', check.label),
      node('strong', check.passed ? '通过' : '失败', check.passed ? 'test-pass' : 'test-fail'));
    list.append(row);
  }
}

function showProject(project) {
  currentProject = project;
  $('result-meta').hidden = false;
  $('publish-actions').hidden = false;
  $('result-title').textContent = project.title;
  $('source-tag').textContent = captions[project.source];
  $('open-app').href = project.url;
  $('download-app').href = project.url + '/download';
  $('empty-preview').hidden = true;
  preview.src = '/preview/' + project.id;
  preview.hidden = false;
  showChecks(project.checks);
  selectTab(false);
}

function clearProject() {
  currentProject = undefined;
  $('result-meta').hidden = true;
  $('publish-actions').hidden = true;
  $('empty-preview').hidden = false;
  preview.hidden = true;
  preview.removeAttribute('src');
  $('request-bubble').hidden = true;
  $('progress').replaceChildren();
  $('empty-activity').hidden = false;
  showChecks();
  selectTab(false);
}

function showPrompt(prompt) {
  $('request-bubble').textContent = prompt;
  $('request-bubble').hidden = false;
  $('empty-activity').hidden = true;
}

function addStage(stage, message) {
  const item = node('li', message);
  item.dataset.stage = stage;
  $('progress').append(item);
}

async function loadProject(id, updateLocation = false) {
  try {
    const project = await api('/api/projects/' + encodeURIComponent(id));
    if (updateLocation) navigate('/studio?project=' + project.id);
    else if (new URLSearchParams(location.search).get('project') !== id) return;
    $('progress').replaceChildren();
    addStage('done', '已恢复保存的版本');
    showPrompt(project.prompt);
    showProject(project);
  } catch (error) {
    notify(error.message);
  }
}

function readRoute() {
  showPage();
  const id = new URLSearchParams(location.search).get('project');
  if (location.pathname !== '/studio' || generating) return;
  if (id && id !== currentProject?.id) loadProject(id);
  if (!id) clearProject();
}

async function generate(prompt) {
  const request = prompt.trim();
  if (generating) return;
  if (request.length < 2) return notify('请多写几个字，描述你要生成的应用');
  generating = true;
  for (const button of document.querySelectorAll('.prompt-form button[type="submit"]')) button.disabled = true;
  navigate('/studio' + (currentProject ? '?project=' + currentProject.id : ''));
  showPrompt(request);
  $('progress').replaceChildren();
  addStage('request', '已提交生成请求');
  try {
    await ready;
    const response = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: request })
    });
    if (!response.ok) throw new Error((await response.json()).error);
    let buffer = '';
    let completed = false;
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      const events = buffer.split('\n');
      buffer = events.pop();
      for (const line of events) {
        if (!line) continue;
        const { stage, message, checks, project } = JSON.parse(line);
        addStage(stage, message);
        if (stage === 'error') {
          completed = true;
          if (checks) { showChecks(checks); selectTab(true); }
        }
        if (stage === 'done') {
          completed = true;
          if (location.pathname === '/studio') navigate('/studio?project=' + project.id, true);
          showProject(project);
          workInput.value = '';
          await bootstrap();
        }
      }
    }
    if (!completed) throw new Error('连接中断，请重试生成。');
  } catch (error) {
    addStage('error', error.message);
  } finally {
    generating = false;
    for (const button of document.querySelectorAll('.prompt-form button[type="submit"]')) button.disabled = false;
  }
}

for (const [form, input] of [[$('home-form'), promptInput], [$('work-form'), workInput]]) {
  form.addEventListener('submit', event => { event.preventDefault(); generate(input.value); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}
for (const [id, path] of [['home-link', '/'], ['new-link', '/'], ['studio-link', '/studio']]) {
  $(id).addEventListener('click', event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(id === 'studio-link' && currentProject ? path + '?project=' + currentProject.id : path);
  });
}
window.addEventListener('popstate', readRoute);
$('preview-tab').addEventListener('click', () => selectTab(false));
$('tests-tab').addEventListener('click', () => selectTab(true));
for (const id of ['preview-tab', 'tests-tab']) {
  $(id).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    selectTab(id === 'preview-tab');
    $(id === 'preview-tab' ? 'tests-tab' : 'preview-tab').focus();
  });
}
$('copy-link').addEventListener('click', async () => {
  if (!currentProject) return;
  const url = new URL(currentProject.url, location.origin).href;
  try {
    await navigator.clipboard.writeText(url);
    notify('链接已复制');
  } catch {
    window.prompt('复制应用链接', url);
  }
});

async function loadChallenge() {
  const request = ++challengeRequest;
  picked = null;
  challenge = undefined;
  $('challenge-label').textContent = '正在加载验证码…';
  $('challenge-visual').hidden = true;
  try {
    await ready;
    const result = await api('/api/challenge');
    if (request !== challengeRequest || authMode !== 'register' || !auth.open) return;
    challenge = result;
    $('challenge-label').textContent = result.instruction;
    $('challenge-image').src = result.image;
    $('challenge-visual').hidden = false;
    const controls = $('challenge-cells');
    controls.replaceChildren();
    for (let i = 0; i < 6; i++) {
      const button = node('button');
      button.type = 'button';
      button.setAttribute('aria-label', '第 ' + (i + 1) + ' 个图案');
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        picked = i;
        for (const cell of controls.children) cell.setAttribute('aria-pressed', String(cell === button));
        $('auth-error').textContent = '';
      });
      controls.append(button);
    }
  } catch (error) {
    if (request === challengeRequest && authMode === 'register') $('challenge-label').textContent = error.message;
  }
}

function openAuth(mode) {
  authMode = mode;
  const registering = mode === 'register';
  $('auth-title').textContent = registering ? '注册账号' : '登录';
  $('auth-submit').textContent = registering ? '注册' : '登录';
  $('password').autocomplete = registering ? 'new-password' : 'current-password';
  $('challenge').hidden = !registering;
  $('auth-switch').textContent = registering ? '已有账号？去登录' : '还没有账号？去注册';
  $('auth-error').textContent = '';
  if (!auth.open) {
    $('auth-form').reset();
    auth.showModal();
  }
  if (registering) loadChallenge();
}

$('register-open').addEventListener('click', () => openAuth('register'));
$('login-open').addEventListener('click', () => openAuth('login'));
$('auth-switch').addEventListener('click', () => openAuth(authMode === 'register' ? 'login' : 'register'));
$('auth-close').addEventListener('click', () => auth.close());
$('challenge-refresh').addEventListener('click', loadChallenge);
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const registering = authMode === 'register';
  if (registering && (!challenge || picked === null)) {
    $('auth-error').textContent = '请先点击验证码图片中的目标图案';
    return;
  }
  $('auth-submit').disabled = true;
  $('auth-switch').disabled = true;
  $('auth-error').textContent = '';
  try {
    await ready;
    const credentials = { username: $('username').value, password: $('password').value };
    if (registering) Object.assign(credentials, { challengeId: challenge.id, choice: picked });
    const data = await api(registering ? '/api/register' : '/api/login', credentials);
    paintAccount(data.user);
    auth.close();
    notify(registering ? '注册成功' : '登录成功');
    await bootstrap();
  } catch (error) {
    $('auth-error').textContent = error.message;
    if (registering && auth.open) loadChallenge();
  } finally {
    $('auth-submit').disabled = false;
    $('auth-switch').disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', {});
    paintAccount(null);
    clearProject();
    navigate('/');
    await bootstrap();
    notify('已退出');
  } catch (error) {
    notify(error.message);
  }
});

showPage();
const ready = bootstrap().catch(() => { notify('暂时无法加载首页示例，请刷新重试。'); });
ready.then(readRoute);
