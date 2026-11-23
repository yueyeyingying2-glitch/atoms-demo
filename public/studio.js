import { closePreview, connectPreview, openPreview, waitForPreviewSave } from './preview.js';

const $ = id => document.getElementById(id);
const home = $('home');
const workspace = $('workspace');
const promptInput = $('home-prompt');
const workInput = $('work-prompt');
const auth = $('auth-dialog');
const preview = $('preview');
const publicationDialog = $('publication-dialog');
const versionsDialog = $('versions-dialog');
const stages = [['plan', '需求规划'], ['build', '代码生成'], ['check', '测试'], ['verify', '验收'], ['done', '完成']];
const stageNames = { repair: 'check', fallback: 'build' };
const captions = { example: '预置示例', model: '模型生成', fallback: '演示模式', revision: '修改版本', draft: '私有草稿' };
const tabs = ['preview', 'tests', 'code'];
connectPreview(preview);
let engine = 'demo';
let currentUser;
let generationIntent;
let stageEntries = [];
let currentProject;
let generating = false;
let generationRequest;
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
  currentUser = user;
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
  engine = data.engine;
  updateComposer();
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

function selectTab(selected) {
  for (const name of tabs) {
    $(name + '-tab').setAttribute('aria-selected', String(selected === name));
    $(name + '-tab').tabIndex = selected === name ? 0 : -1;
    $(name + '-view').hidden = selected !== name;
  }
  $('preview-controls').hidden = selected !== 'preview' || !currentProject;
}

function showPlan(plan) {
  $('generation-plan').hidden = !plan;
  if (!plan) return;
  $('plan-title').textContent = plan.title;
  $('plan-description').textContent = plan.description;
  $('plan-requirements').replaceChildren(...plan.requirements.map(item => node('li', item)));
  $('plan-tests').replaceChildren(...plan.cases.map(item => node('li', item)));
}

function updateComposer() {
  const revision = Boolean(currentProject);
  $('composer-mode').textContent = revision ? '修改当前版本' : engine === 'deepseek' ? 'DeepSeek' : '演示模式';
  workInput.placeholder = revision ? '描述你要修改的地方…' : '描述要生成的应用…';
  $('work-submit').textContent = revision ? '生成修改版 ↗' : '生成 ↗';
}

function showChecks(checks = [], logs = []) {
  const list = $('test-list');
  list.replaceChildren();
  const passes = checks.filter(item => item.passed).length;
  $('test-count').textContent = checks.length ? passes + '/' + checks.length : '';
  $('tests-summary').textContent = checks.length ? passes + ' / ' + checks.length + ' 项通过' : '生成后会自动执行交互测试。';
  $('test-console').hidden = logs.length === 0;
  $('test-log').textContent = logs.join('\n');
  for (const check of checks) {
    const row = node('li');
    const text = node('div');
    text.append(node('span', check.label));
    if (check.detail) text.append(node('small', check.detail));
    row.append(text, node('strong', check.passed === null ? '未完成' : check.passed ? '通过' : '失败',
      check.passed === null ? 'muted' : check.passed ? 'test-pass' : 'test-fail'));
    list.append(row);
  }
}

function showPreview(refresh = false) {
  if (!currentProject) return;
  const { id, kind, stateUrl } = currentProject;
  $('storage-status').hidden = true;
  void openPreview(preview, id, {
    refresh, state: stateUrl, withStorage: Boolean(stateUrl || kind === 'web'),
    status(message) {
      $('storage-status').textContent = message;
      $('storage-status').hidden = !message;
    }
  });
}

function showProject(project) {
  currentProject = project;
  $('result-meta').hidden = $('publish-actions').hidden = false;
  $('download-app').hidden = !project.canPublish;
  $('download-app').href = '/api/projects/' + project.id + '/download';
  $('result-title').textContent = project.title;
  $('source-tag').textContent = project.model ? 'DeepSeek · ' + project.model + (project.source === 'draft' ? ' · 私有草稿' : '') : captions[project.source];
  const version = project.versions.find(item => item.id === project.id);
  $('version-tag').textContent = version ? 'v' + version.number : '';
  paintPublication();
  $('empty-preview').hidden = true;
  preview.hidden = false;
  showPreview();
  $('project-code').textContent = project.html ?? '';
  showPlan(project.plan);
  showChecks(project.checks, project.logs);
  updateComposer();
  selectTab(project.source === 'draft' ? 'tests' : 'preview');
}

function clearProject() {
  currentProject = undefined;
  $('result-meta').hidden = true;
  $('publish-actions').hidden = true;
  $('empty-preview').hidden = false;
  preview.hidden = true;
  closePreview(preview);
  $('storage-status').hidden = true;
  $('request-bubble').hidden = true;
  resetStages();
  $('empty-activity').hidden = false;
  $('run-status').hidden = true;
  $('project-code').textContent = '';
  showPlan();
  showChecks();
  updateComposer();
  selectTab('preview');
}

function showPrompt(prompt) {
  $('request-bubble').textContent = prompt;
  $('request-bubble').hidden = false;
  $('empty-activity').hidden = true;
}

function renderStages() {
  const list = $('development-stages');
  list.hidden = !stageEntries.length;
  const phase = event => stages.findIndex(([name]) => name === (stageNames[event.stage] ?? event.stage));
  const markers = stageEntries.filter(event => phase(event) >= 0);
  const last = stageEntries.at(-1)?.stage;
  const index = markers.length ? phase(markers.at(-1)) : 0;
  list.replaceChildren(...stages.map(([key, label], at) => {
    let state = at < index || last === 'done' ? 'complete' : at === index ? 'active' : 'pending';
    if (at === index && ['error', 'draft', 'cancelled'].includes(last)) state = last === 'cancelled' ? 'stopped' : 'failed';
    const caption = { complete: '已完成', active: '进行中', pending: '待开始', failed: '未通过', stopped: '已取消' }[state];
    const row = node('li');
    row.dataset.state = state;
    row.setAttribute('aria-label', label + '，' + caption);
    if (state === 'active') row.setAttribute('aria-current', 'step');
    const mark = node('span', state === 'complete' ? '✓' : state === 'failed' ? '!' : state === 'active' ? '●' : '', 'stage-mark');
    mark.setAttribute('aria-hidden', 'true');
    const text = node('span', label, 'stage-text');
    const start = markers.find(event => phase(event) === at)?.elapsedMs;
    const end = markers.find(event => phase(event) > at)?.elapsedMs;
    if (key !== 'done' && Number.isFinite(start) && Number.isFinite(end)) {
      const seconds = Math.max(0, (end - start) / 1000);
      const time = node('time', seconds < 0.1 ? '<0.1 秒' : seconds.toFixed(1) + ' 秒');
      time.dateTime = 'PT' + seconds + 'S';
      text.append(time);
    }
    row.append(mark, text);
    return row;
  }));
}

function resetStages() {
  stageEntries = [];
  $('progress').replaceChildren();
  renderStages();
}

function addStage(stage, message, elapsedMs) {
  stageEntries.push({ stage, message, elapsedMs });
  const item = node('li', message);
  item.dataset.stage = stage;
  $('progress').lastElementChild?.removeAttribute('aria-current');
  item.setAttribute('aria-current', 'step');
  $('progress').append(item);
  renderStages();
}

async function loadProject(id, updateLocation = false) {
  try {
    const project = await api('/api/projects/' + encodeURIComponent(id));
    if (updateLocation) navigate('/studio?project=' + project.id);
    else if (new URLSearchParams(location.search).get('project') !== id) return;
    resetStages();
    $('run-status').hidden = true;
    if (project.timeline?.length) {
      for (const item of project.timeline) addStage(item.stage, item.message, item.elapsedMs);
    } else {
      if (project.source === 'draft') addStage('verify', '验收未通过');
      addStage(project.source === 'draft' ? 'draft' : 'done', '已恢复保存的版本');
    }
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

function requireLogin(request, followUp) {
  generationIntent = { request, followUp };
  openAuth('login');
}

async function generate(prompt, followUp) {
  const request = prompt.trim();
  if (generating) return;
  if (request.length < 2) return notify('请多写几个字，描述你要生成的应用');
  await ready;
  if (generating) return;
  if (!currentUser) return requireLogin(request, followUp);
  if (!followUp) clearProject();
  const projectId = currentProject?.id;
  generating = true;
  generationRequest = new AbortController();
  for (const button of document.querySelectorAll('.prompt-form button[type="submit"]')) button.disabled = true;
  $('cancel-generation').hidden = false;
  navigate('/studio' + (currentProject ? '?project=' + currentProject.id : ''));
  showPrompt(request);
  resetStages();
  $('run-status').hidden = false;
  if (!currentProject) showPlan();
  const started = performance.now();
  const updateElapsed = () => {
    const seconds = Math.floor((performance.now() - started) / 1000);
    $('elapsed').textContent = String(seconds) + ' 秒';
    $('elapsed').dateTime = 'PT' + seconds + 'S';
  };
  updateElapsed();
  const timer = setInterval(updateElapsed, 1000);
  addStage('request', '已提交生成请求');
  try {
    const response = await fetch('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: request, projectId }),
      signal: generationRequest.signal
    });
    if (response.status === 401) {
      paintAccount(null);
      requireLogin(request, followUp);
      return;
    }
    if (!response.ok) throw new Error((await response.json()).error);
    let buffer = '';
    let completed = false;
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk;
      const events = buffer.split('\n');
      buffer = events.pop();
      for (const line of events) {
        if (!line) continue;
        const { stage, message, checks, project, plan, elapsedMs } = JSON.parse(line);
        addStage(stage, message, elapsedMs);
        if (plan) showPlan(plan);
        if (stage === 'error') {
          completed = true;
          if (checks) { showChecks(checks); selectTab('tests'); }
        }
        if (stage === 'done' || stage === 'draft') {
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
    if (generationRequest.signal.aborted) addStage('cancelled', '已取消生成，已保存的版本仍可使用');
    else addStage('error', error.message);
  } finally {
    clearInterval(timer);
    updateElapsed();
    generating = false;
    generationRequest = undefined;
    $('cancel-generation').hidden = true;
    for (const button of document.querySelectorAll('.prompt-form button[type="submit"]')) button.disabled = false;
  }
}

for (const [form, input] of [[$('home-form'), promptInput], [$('work-form'), workInput]]) {
  form.addEventListener('submit', event => { event.preventDefault(); generate(input.value, input === workInput && currentProject); });
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
for (const [index, name] of tabs.entries()) {
  const tab = $(name + '-tab');
  tab.addEventListener('click', () => selectTab(name));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    selectTab(next);
    $(next + '-tab').focus();
  });
}
for (const mobile of [false, true]) {
  $(mobile ? 'mobile-preview' : 'desktop-preview').addEventListener('click', () => {
    $('preview-view').classList.toggle('mobile-preview', mobile);
    $('mobile-preview').setAttribute('aria-pressed', String(mobile));
    $('desktop-preview').setAttribute('aria-pressed', String(!mobile));
  });
}
$('refresh-preview').addEventListener('click', () => showPreview(true));

function paintPublication() {
  const info = currentProject?.publication;
  const button = $('publication-open');
  button.hidden = !info || (!currentProject.canPublish && !info.url);
  if (!info) return;
  button.dataset.status = info.status;
  button.textContent = info.url ? '已发布' : info.status === 'offline' ? '已下线' : '发布';
  $('publication-title').textContent = info.url ? '已发布' : info.status === 'offline' ? '应用已下线' : '发布应用';
  const currentLive = info.versionId === currentProject.id && info.status === 'published';
  $('publication-description').textContent = info.status === 'legacy'
    ? '此版本已有公开链接。发布当前版本后可使用固定访问地址。'
    : info.url ? (currentLive ? '访客正在访问此版本。' : '现有链接仍指向上次发布的版本。')
      : info.status === 'offline' ? '重新发布后，访客可继续使用原发布链接。' : '发布后会生成手机和电脑都能访问的链接。';
  $('publish-current').hidden = !currentProject.canPublish || currentLive;
  $('publish-current').textContent = info.status === 'published' ? '更新为当前版本' : '发布当前版本';
  $('publication-share').hidden = !info.url;
  if (info.url) {
    const url = new URL(info.url, location.origin);
    $('share-url').value = url.href;
    $('open-app').href = url.href;
    url.searchParams.set('guest', '1');
    $('open-guest').href = url.href;
  }
}

async function changePublication(action) {
  const project = currentProject;
  const error = $('publication-error');
  error.hidden = true;
  $('publish-current').disabled = $('unpublish').disabled = true;
  try {
    const info = await api('/api/projects/' + project.id + '/publication', { action });
    if (currentProject?.id === project.id) {
      currentProject.publication = info;
      currentProject.url = info.url;
      paintPublication();
    }
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    $('publish-current').disabled = $('unpublish').disabled = false;
  }
}

$('publication-open').addEventListener('click', () => {
  $('publication-error').hidden = true;
  paintPublication();
  publicationDialog.showModal();
});
$('publication-close').addEventListener('click', () => publicationDialog.close());
$('publish-current').addEventListener('click', () => changePublication('publish'));
$('unpublish').addEventListener('click', () => changePublication('unpublish'));
$('copy-link').addEventListener('click', async () => {
  const input = $('share-url');
  try {
    await navigator.clipboard.writeText(input.value);
    notify('链接已复制');
  } catch {
    input.focus();
    input.select();
    notify(document.execCommand('copy') ? '链接已复制' : '链接已选中，请复制');
  }
});

$('versions-open').addEventListener('click', () => {
  const list = $('versions-list');
  list.replaceChildren();
  for (const version of [...currentProject.versions].reverse()) {
    const row = node('li');
    const button = node('button');
    button.type = 'button';
    if (version.id === currentProject.id) button.setAttribute('aria-current', 'true');
    const label = node('span', version.title, 'version-info');
    label.append(node('small', new Date(version.createdAt).toLocaleString('zh-CN')));
    button.append(node('strong', 'v' + version.number), label);
    if (currentProject.publication.url && currentProject.publication.versionId === version.id) {
      button.append(node('span', '已发布', 'version-badge'));
    } else if (version.source === 'draft') button.append(node('span', '未通过', 'version-badge'));
    button.addEventListener('click', () => {
      versionsDialog.close();
      void loadProject(version.id, true);
    });
    row.append(button);
    list.append(row);
  }
  versionsDialog.showModal();
});
$('versions-close').addEventListener('click', () => versionsDialog.close());

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
  $('auth-reason').hidden = !generationIntent;
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
$('auth-close').addEventListener('click', () => {
  generationIntent = undefined;
  auth.close();
});
auth.addEventListener('cancel', () => { generationIntent = undefined; });
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
    const intent = auth.open ? generationIntent : undefined;
    generationIntent = undefined;
    auth.close();
    notify(registering ? '注册成功' : '登录成功');
    try { await bootstrap(); } catch {}
    if (intent) void generate(intent.request, intent.followUp);
    else readRoute();
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
    await waitForPreviewSave(preview);
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
