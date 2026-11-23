import { readFileSync } from 'node:fs';

const styles = readFileSync(new URL('./artifact.css', import.meta.url), 'utf8');

const labels = {
  calculator: '预算工具',
  stopwatch: '计时工具',
  game: '数字游戏'
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function calculatorRuntime(spec) {
  const form = document.querySelector('form');
  const result = document.querySelector('#value');
  const error = document.querySelector('#error');
  const storageKey = 'studio:calculation:' + location.pathname;
  const historyKey = 'studio:calculation-history';
  const history = document.getElementById('calculation-history');
  const historyStatus = document.getElementById('calculation-history-status');
  const save = document.getElementById('save-calculation');
  const format = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
  let records = [];
  const byId = id => document.getElementById('field-' + id);
  function compute(node, values) {
    if (typeof node === 'number') return node;
    if (typeof node === 'string') return values[node];
    const parts = node.args.map(child => compute(child, values));
    switch (node.op) {
      case 'add': return parts.reduce((a, b) => a + b);
      case 'mul': return parts.reduce((a, b) => a * b);
      case 'sub': return parts[0] - parts[1];
      case 'div': return parts[0] / parts[1];
    }
  }
  function calculate(event) {
    event?.preventDefault();
    const values = Object.fromEntries(spec.fields.map(field => [field.id, byId(field.id).valueAsNumber]));
    const invalid = spec.fields.find(field => !Number.isFinite(values[field.id]) || values[field.id] < field.min);
    const total = invalid ? NaN : compute(spec.formula, values);
    error.textContent = invalid ? '请输入有效的' + invalid.label
      : Number.isFinite(total) ? '' : '当前输入无法算出有限结果，请检查分母。';
    const valid = Number.isFinite(total);
    result.textContent = valid ? format(total) : '—';
    result.dataset.value = valid ? String(total) : '';
    save.disabled = !valid;
    if (valid && event) {
      try { localStorage.setItem(storageKey, JSON.stringify(values)); } catch {}
    }
    return valid ? { values, total } : null;
  }

  function renderHistory() {
    history.replaceChildren();
    document.getElementById('calculation-history-empty').hidden = Boolean(records.length);
    records.forEach((record, index) => {
      const row = document.createElement('li');
      const label = document.createElement('strong');
      label.textContent = format(record.total) + ' ' + spec.unit;
      const time = document.createElement('time');
      const date = new Date(record.createdAt);
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString('zh-CN');
      const detail = document.createElement('p');
      detail.textContent = spec.fields.map(field => field.label + ' ' + record.values[field.id] + ' ' + field.unit).join(' · ');
      const controls = document.createElement('div');
      for (const [label, action] of [
        ['加载', () => {
          for (const field of spec.fields) byId(field.id).value = record.values[field.id];
          calculate();
          historyStatus.textContent = '已加载方案';
        }],
        ['删除', () => updateHistory(records.filter((_, at) => at !== index), '已删除方案')]
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', action);
        controls.append(button);
      }
      row.append(label, time, detail, controls);
      history.append(row);
    });
  }

  function updateHistory(entries, message) {
    try {
      localStorage.setItem(historyKey, JSON.stringify(entries));
      records = entries;
      renderHistory();
      historyStatus.textContent = message;
    } catch {
      historyStatus.textContent = '无法保存方案，请检查浏览器存储。';
    }
  }

  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const field of spec.fields) {
      if (Number.isFinite(saved?.[field.id])) byId(field.id).value = saved[field.id];
    }
    const savedRecords = JSON.parse(localStorage.getItem(historyKey));
    if (Array.isArray(savedRecords)) {
      records = savedRecords.slice(0, 30).filter(row => Number.isFinite(row?.total)
        && Number.isFinite(row.createdAt) && Math.abs(row.createdAt) <= 8.64e15
        && spec.fields.every(field => Number.isFinite(row.values?.[field.id])));
    }
  } catch {}
  save.addEventListener('click', () => {
    const record = calculate();
    if (record) updateHistory([{ ...record, createdAt: Date.now() }, ...records].slice(0, 30), '已保存方案');
  });
  form.addEventListener('submit', calculate);
  calculate();
  renderHistory();
}

function stopwatchRuntime(spec) {
  let elapsed = 0;
  let started = null;
  let interval;
  const readout = document.getElementById('readout');
  const start = document.getElementById('start');
  const pause = document.getElementById('pause');
  const reset = document.getElementById('reset');
  const status = document.getElementById('timer-status');
  const lapButton = document.getElementById('lap');
  const laps = document.getElementById('laps');
  let lapCount = 0;
  const pad = value => String(value).padStart(2, '0');

  function format(ms) {
    return pad(Math.floor(ms / 60000)) + ':' + pad(Math.floor(ms / 1000) % 60)
      + '.' + pad(Math.floor(ms / 10) % 100);
  }
  const currentTime = () => Math.max(0, Math.floor(elapsed + (started === null ? 0 : performance.now() - started)));
  function tick() {
    readout.textContent = format(currentTime());
  }
  function update() {
    const running = started !== null;
    start.disabled = running;
    start.textContent = elapsed > 0 ? '继续' : '开始';
    pause.disabled = !running;
    if (lapButton) lapButton.disabled = !running;
    status.textContent = running ? '计时中' : elapsed > 0 ? '已暂停' : '准备计时';
    tick();
  }
  start.addEventListener('click', () => {
    if (started !== null) return;
    started = performance.now();
    interval = setInterval(tick, 15);
    update();
  });
  pause.addEventListener('click', () => {
    if (started === null) return;
    elapsed += performance.now() - started;
    started = null;
    clearInterval(interval);
    update();
  });
  reset.addEventListener('click', () => {
    clearInterval(interval);
    elapsed = 0;
    started = null;
    lapCount = 0;
    laps?.replaceChildren();
    update();
  });
  if (spec.laps) {
    lapButton.addEventListener('click', () => {
      if (started === null) return;
      const row = document.createElement('li');
      const number = document.createElement('span');
      const time = document.createElement('time');
      number.textContent = '第 ' + ++lapCount + ' 次';
      time.textContent = format(currentTime());
      row.append(number, time);
      laps.prepend(row);
    });
  }
  update();
}

function tileRuntime(spec) {
  const { size, target } = spec;
  const boardElement = document.getElementById('board');
  const scoreElement = document.getElementById('score');
  const bestElement = document.getElementById('best-score');
  const status = document.getElementById('game-status');
  const undoButton = document.getElementById('undo');
  const outcome = document.getElementById('game-outcome');
  const continueButton = document.getElementById('continue-game');
  const storageKey = 'studio:tiles:' + size + ':' + target;
  let board, score, won, undoUsed, previous, gesture;
  let best = 0;

  function spawn() {
    const spaces = board.flatMap((value, index) => value === 0 ? [index] : []);
    if (!spaces.length) return -1;
    const index = spaces[Math.floor(Math.random() * spaces.length)];
    board[index] = Math.random() < 0.9 ? 2 : 4;
    return index;
  }

  function closeOutcome() {
    if (outcome.open) {
      if (outcome.close) outcome.close();
      else outcome.removeAttribute('open');
    }
  }

  function showOutcome(victory) {
    document.getElementById('outcome-title').textContent = victory ? '合成成功！' : '游戏结束';
    document.getElementById('outcome-description').textContent = victory
      ? '你已经合出 ' + target + '，可以继续挑战更高分。'
      : '棋盘已满，当前分数 ' + score.toLocaleString('zh-CN') + '。';
    continueButton.hidden = !victory;
    if (outcome.open) return;
    if (outcome.showModal) outcome.showModal();
    else outcome.setAttribute('open', '');
  }

  function restart() {
    closeOutcome();
    board = Array(size * size).fill(0);
    score = 0;
    won = false;
    previous = null;
    undoUsed = false;
    spawn();
    spawn();
    render();
  }

  function canMove() {
    return board.some((value, i) => value === 0
      || (i % size < size - 1 && value === board[i + 1])
      || (i + size < board.length && value === board[i + size]));
  }

  function render(motions = [], spawned = -1) {
    const cells = board.map(value => {
      const cell = document.createElement('div');
      cell.className = 'tile';
      cell.dataset.tile = value;
      if (value) cell.textContent = value;
      return cell;
    });
    boardElement.replaceChildren(...cells);
    scoreElement.textContent = score;
    bestElement.textContent = best;
    status.textContent = !canMove() ? '棋盘已满，无法继续移动。' : won ? '已达成 ' + target + '，继续挑战。' : '';
    undoButton.disabled = undoUsed || !previous;
    try { localStorage.setItem(storageKey, JSON.stringify({ board, score, best, won, undoUsed })); } catch {}
    if (!cells[0].animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const { from, to } of motions) {
      const destination = cells[to];
      const dx = cells[from[0]].offsetLeft - destination.offsetLeft;
      const dy = cells[from[0]].offsetTop - destination.offsetTop;
      if (from.length === 2) {
        for (const index of from) {
          const ghost = document.createElement('div');
          ghost.className = 'tile moving-tile';
          ghost.dataset.color = board[to] / 2;
          ghost.textContent = board[to] / 2;
          ghost.style.left = cells[index].offsetLeft + 'px';
          ghost.style.top = cells[index].offsetTop + 'px';
          ghost.style.width = destination.offsetWidth + 'px';
          boardElement.append(ghost);
          ghost.animate([{ transform: 'translate(0,0)' }, {
            transform: 'translate(' + (destination.offsetLeft - cells[index].offsetLeft) + 'px,' + (destination.offsetTop - cells[index].offsetTop) + 'px)'
          }], { duration: 130, easing: 'ease-out', fill: 'forwards' }).onfinish = () => ghost.remove();
        }
        destination.animate([{ transform: 'scale(.87)', opacity: 0 }, { transform: 'scale(1.09)', opacity: 1 },
          { transform: 'scale(1)', opacity: 1 }], { delay: 130, duration: 135, fill: 'backwards' });
      } else if (from[0] !== to) {
        destination.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'translate(0,0)' }],
          { duration: 130, easing: 'ease-out' });
      }
    }
    if (spawned >= 0) cells[spawned].animate([{ transform: 'scale(.4)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      { delay: 125, duration: 155, fill: 'backwards' });
  }

  function cellIndex(direction, line, step) {
    switch (direction) {
      case 'left': return line * size + step;
      case 'right': return line * size + size - 1 - step;
      case 'up': return step * size + line;
      case 'down': return (size - 1 - step) * size + line;
    }
  }

  function move(direction) {
    if (outcome.open) return;
    const next = board.map(() => 0);
    const motions = [];
    let earned = 0;
    for (let line = 0; line < size; line++) {
      const indices = Array.from({ length: size }, (_, i) => cellIndex(direction, line, i));
      const active = indices.filter(index => board[index]);
      let dest = 0;
      for (let i = 0; i < active.length; i++) {
        const from = [active[i]];
        let value = board[active[i]];
        if (value === board[active[i + 1]]) {
          value *= 2;
          earned += value;
          from.push(active[++i]);
        }
        const to = indices[dest++];
        next[to] = value;
        motions.push({ from, to });
      }
    }
    if (next.every((value, i) => value === board[i])) {
      if (!canMove()) showOutcome(false);
      return;
    }
    previous = { board, score };
    board = next;
    score += earned;
    best = Math.max(best, score);
    const spawned = spawn();
    const victory = !won && board.some(value => value >= target);
    if (victory) won = true;
    render(motions, spawned);
    if (victory || !canMove()) showOutcome(victory);
  }

  const directions = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left',
    w: 'up', d: 'right', s: 'down', a: 'left' };
  document.querySelectorAll('[data-move]').forEach(button => {
    button.addEventListener('click', () => move(button.dataset.move));
  });
  document.addEventListener('keydown', event => {
    const direction = directions[event.key] || directions[event.key.toLowerCase()];
    if (!direction || event.altKey || event.ctrlKey || event.metaKey || outcome.open) return;
    event.preventDefault();
    move(direction);
  });
  boardElement.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY };
    boardElement.setPointerCapture?.(event.pointerId);
  });
  boardElement.addEventListener('pointercancel', () => { gesture = null; });
  boardElement.addEventListener('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    gesture = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 20) return;
    move(Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down'));
  });
  document.querySelectorAll('[data-restart]').forEach(button => button.addEventListener('click', restart));
  continueButton.addEventListener('click', () => {
    closeOutcome();
    if (!canMove()) showOutcome(false);
    else boardElement.focus();
  });
  outcome.addEventListener('cancel', event => {
    event.preventDefault();
    if (!continueButton.hidden) continueButton.click();
  });
  undoButton.addEventListener('click', () => {
    if (!previous || undoUsed) return;
    ({ board, score } = previous);
    undoUsed = true;
    previous = null;
    render();
  });

  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  if (Number.isSafeInteger(saved?.best) && saved.best >= 0) best = saved.best;
  if (Array.isArray(saved?.board) && saved.board.length === size * size
    && saved.board.every(v => Number.isInteger(v) && v >= 0 && v <= 2 ** 30)
    && Number.isSafeInteger(saved.score) && saved.score >= 0) {
    ({ board, score } = saved);
    won = Boolean(saved.won) || board.some(value => value >= target);
    best = Math.max(best, score);
    undoUsed = Boolean(saved.undoUsed);
    render();
    if (!canMove()) showOutcome(false);
  } else {
    restart();
  }
}

const contents = {
  calculator(spec) {
    const inputs = spec.fields.map(field => `<label for="field-${field.id}"><span>${escapeHtml(field.label)}</span>
      <span class="input-row"><input id="field-${field.id}" type="number" inputmode="decimal"
        value="${field.value}" min="${field.min}" step="any" required><small>${escapeHtml(field.unit)}</small></span></label>`);
    return `<form novalidate><div class="fields">${inputs.join('')}</div>
      <p id="error" class="error" role="status"></p><button class="primary" type="submit">计算</button></form>
      <div class="result"><span>${escapeHtml(spec.resultLabel)}</span><p><strong id="value">—</strong>
      <small>${escapeHtml(spec.unit)}</small></p></div>
      <section class="calculation-history" aria-labelledby="calculation-history-title">
        <div class="history-heading"><h2 id="calculation-history-title">历史方案</h2>
        <button id="save-calculation" type="button">保存当前方案</button></div>
        <p id="calculation-history-status" role="status"></p>
        <p id="calculation-history-empty">暂无保存的方案</p><ol id="calculation-history"></ol>
      </section>`;
  },
  stopwatch(spec) {
    const lapControls = spec.laps ? '<button id="lap" disabled>计次</button>' : '';
    const lapList = spec.laps ? '<ol id="laps" class="laps" aria-label="计次记录"></ol>' : '';
    return `<section class="timer"><div class="timer-clock"><p id="timer-status">准备计时</p>
      <output id="readout" aria-label="累计时间">00:00.00</output></div>
      <div class="actions timer-actions"><button id="start" class="primary">开始</button>
      <button id="pause" disabled>暂停</button>${lapControls}<button id="reset">归零</button></div>${lapList}</section>`;
  },
  game(spec) {
    return `<div class="game"><div class="game-head"><div class="game-scores">
      <p>当前分数 <strong id="score">0</strong></p><p>最高分 <strong id="best-score">0</strong></p></div>
      <button id="new-game" class="game-restart" data-restart>重新开始</button></div>
      <div id="board" class="board" style="--tile-count:${spec.size}" tabindex="0" aria-label="${spec.size} × ${spec.size} 数字棋盘"></div>
      <div class="actions controls"><button data-move="left" aria-label="向左">←</button>
      <button data-move="up" aria-label="向上">↑</button><button data-move="down" aria-label="向下">↓</button>
      <button data-move="right" aria-label="向右">→</button><button id="undo" disabled>撤回一步</button></div>
      <p id="game-status" role="status"></p>
      <details><summary>玩法</summary><p>方向键、WASD 或在棋盘上滑动。相同数字相遇时合并，每个方块每步最多合并一次。每次有效移动新增一个方块，有 90% 的机会出现 2，10% 的机会出现 4。合出 ${spec.target} 后可继续挑战。</p></details>
      <dialog id="game-outcome" aria-labelledby="outcome-title" aria-describedby="outcome-description">
        <h2 id="outcome-title"></h2><p id="outcome-description"></p><div class="actions">
        <button class="game-restart" id="continue-game">继续玩</button><button data-restart>重新开始</button></div>
      </dialog></div>`;
  }
};

const runtimes = { calculator: calculatorRuntime, stopwatch: stopwatchRuntime, game: tileRuntime };

export function buildArtifact(spec) {
  const json = JSON.stringify(spec).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(spec.title)}</title><style>${styles}</style></head>
<body data-app="${spec.kind}"><main><header><span>${labels[spec.kind]}</span><h1>${escapeHtml(spec.title)}</h1>
<p>${escapeHtml(spec.description)}</p></header>${contents[spec.kind](spec)}</main>
<script>(${runtimes[spec.kind].toString()})(${json});</script></body></html>`;
}
