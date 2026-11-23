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
    result.textContent = Number.isFinite(total) ? total.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) : '—';
    result.dataset.value = Number.isFinite(total) ? String(total) : '';
    if (Number.isFinite(total)) {
      try { localStorage.setItem(storageKey, JSON.stringify(values)); } catch {}
    }
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    for (const field of spec.fields) {
      if (Number.isFinite(saved?.[field.id])) byId(field.id).value = saved[field.id];
    }
  } catch {}
  form.addEventListener('submit', calculate);
  calculate();
}

function stopwatchRuntime() {
  let elapsed = 0;
  let started = null;
  let interval;
  const readout = document.getElementById('readout');
  const start = document.getElementById('start');
  const pause = document.getElementById('pause');
  const reset = document.getElementById('reset');
  const status = document.getElementById('timer-status');
  const pad = value => String(value).padStart(2, '0');

  function tick() {
    const ms = Math.max(0, Math.floor(elapsed + (started === null ? 0 : performance.now() - started)));
    readout.textContent = pad(Math.floor(ms / 60000)) + ':' + pad(Math.floor(ms / 1000) % 60)
      + '.' + pad(Math.floor(ms / 10) % 100);
  }
  function update() {
    const running = started !== null;
    start.disabled = running;
    start.textContent = elapsed > 0 ? '继续' : '开始';
    pause.disabled = !running;
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
    update();
  });
  update();
}

function tileRuntime(spec) {
  const { size, target } = spec;
  const boardElement = document.getElementById('board');
  const scoreElement = document.getElementById('score');
  const status = document.getElementById('game-status');
  const undoButton = document.getElementById('undo');
  const storageKey = 'studio:tiles:' + location.pathname + ':' + size + ':' + target;
  let board, score, undoUsed, previous;

  function spawn() {
    const open = board.flatMap((value, i) => value === 0 ? [i] : []);
    if (open.length) board[open[Math.floor(Math.random() * open.length)]] = Math.random() < 0.88 ? 2 : 4;
  }
  function restart() {
    board = Array(size * size).fill(0);
    score = 0;
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
  function render() {
    const fragment = document.createDocumentFragment();
    for (const value of board) {
      const cell = document.createElement('div');
      cell.className = 'tile';
      cell.dataset.tile = value;
      if (value) cell.textContent = value;
      fragment.append(cell);
    }
    boardElement.replaceChildren(fragment);
    scoreElement.textContent = score;
    status.textContent = board.some(value => value >= target) ? '挑战成功！' : canMove() ? '' : '无可移动位置。';
    undoButton.disabled = undoUsed || !previous;
    try { localStorage.setItem(storageKey, JSON.stringify({ board, score, undoUsed })); } catch {}
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
    const next = board.slice();
    let earned = 0;
    for (let line = 0; line < size; line++) {
      const indices = Array.from({ length: size }, (_, i) => cellIndex(direction, line, i));
      const active = indices.map(i => board[i]).filter(Boolean);
      const merged = [];
      for (let i = 0; i < active.length; i++) {
        if (active[i] === active[i + 1]) {
          earned += active[i] * 2;
          merged.push(active[i] * 2);
          i++;
        } else {
          merged.push(active[i]);
        }
      }
      indices.forEach((cell, i) => { next[cell] = merged[i] ?? 0; });
    }
    if (next.every((value, i) => value === board[i])) return;
    previous = { board, score };
    board = next;
    score += earned;
    spawn();
    render();
  }
  document.querySelectorAll('[data-move]').forEach(button => {
    button.addEventListener('click', () => move(button.dataset.move));
  });
  document.addEventListener('keydown', event => {
    const key = { ArrowUp: 'up', ArrowRight: 'right', ArrowDown: 'down', ArrowLeft: 'left' }[event.key];
    if (!key || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    move(key);
  });
  document.getElementById('new-game').addEventListener('click', restart);
  undoButton.addEventListener('click', () => {
    if (!previous || undoUsed) return;
    ({ board, score } = previous);
    undoUsed = true;
    previous = null;
    render();
  });
  let saved;
  try { saved = JSON.parse(localStorage.getItem(storageKey)); } catch {}
  if (Array.isArray(saved?.board) && saved.board.length === size * size
    && saved.board.every(v => Number.isInteger(v) && v >= 0 && v <= 2 ** 30)
    && Number.isSafeInteger(saved.score) && saved.score >= 0) {
    ({ board, score } = saved);
    undoUsed = Boolean(saved.undoUsed);
    render();
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
      <small>${escapeHtml(spec.unit)}</small></p></div>`;
  },
  stopwatch() {
    return `<section class="timer"><div class="timer-clock"><p id="timer-status">准备计时</p>
      <output id="readout" aria-label="累计时间">00:00.00</output></div>
      <div class="actions timer-actions"><button id="start" class="primary">开始</button>
      <button id="pause" disabled>暂停</button><button id="reset">归零</button></div></section>`;
  },
  game(spec) {
    return `<div class="game"><div class="game-head"><p>目标 <strong>${spec.target}</strong></p>
      <p>分数 <strong id="score">0</strong></p><button id="new-game">再来一局</button></div>
      <div id="board" class="board" style="--tile-count:${spec.size}" aria-label="数字棋盘"></div>
      <div class="actions controls"><button data-move="left" aria-label="向左">←</button>
      <button data-move="up" aria-label="向上">↑</button><button data-move="down" aria-label="向下">↓</button>
      <button data-move="right" aria-label="向右">→</button><button id="undo" disabled>撤回一步</button></div>
      <p id="game-status" role="status"></p>
      <details><summary>游戏规则</summary><p>使用键盘方向键或屏幕按钮移动所有数字。相同数字相遇会合并，每块每步最多合并一次。有效移动后出现一个新方块，合出 ${spec.target} 即获胜。每局可撤回一步。</p></details></div>`;
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
