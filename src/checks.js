import { JSDOM, VirtualConsole } from 'jsdom';

function evaluate(node, inputs) {
  if (typeof node === 'number') return node;
  if (typeof node === 'string') return inputs.get(node);
  const values = node.args.map(child => evaluate(child, inputs));
  const [first, second] = values;
  switch (node.op) {
    case 'add': return values.reduce((sum, n) => sum + n, 0);
    case 'sub': return first - second;
    case 'mul': return values.reduce((product, n) => product * n, 1);
    case 'div': return second === 0 ? NaN : first / second;
  }
}

function testCalculator(doc, win, spec, prompt, check) {
  const fields = spec.fields.map(field => [field, doc.getElementById('field-' + field.id)]);
  const result = doc.getElementById('value');
  const submit = () => doc.querySelector('form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  const matches = expected => result.dataset.value !== '' && Number.isFinite(expected)
    && Math.abs(Number(result.dataset.value) - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  const defaults = new Map(spec.fields.map(field => [field.id, field.value]));
  check('默认数值可以计算', () => matches(evaluate(spec.formula, defaults)));
  check('修改输入后重新计算', () => {
    const [field, input] = fields[0];
    const next = Math.abs(field.value) < 1e9 ? field.value + 1 : field.value - 1;
    input.value = next;
    const updated = new Map(defaults).set(field.id, next);
    submit();
    return matches(evaluate(spec.formula, updated));
  });
  if (/窗帘|褶皱/.test(prompt)) {
    check('窗帘预算用例结果正确', () => {
      const width = fields.find(([field]) => /窗宽|宽度/.test(field.label))?.[1];
      const fold = fields.find(([field]) => /褶皱|褶量|倍数/.test(field.label))?.[1];
      const price = fields.find(([field]) => /单价|每米|米价/.test(field.label))?.[1];
      const install = fields.find(([field]) => /安装费/.test(field.label))?.[1];
      if (!width || !fold || !price || (/安装费/.test(prompt) && !install)) return false;
      width.value = 3;
      fold.value = 2;
      price.value = 100;
      if (install) install.value = 80;
      submit();
      return matches(install ? 680 : 600);
    });
  }
  check('空输入给出校验提示', () => {
    fields[0][1].value = '';
    submit();
    return Boolean(doc.getElementById('error').textContent) && result.dataset.value === '';
  });
}

function testStopwatch(doc, advance, check, spec) {
  const read = () => doc.getElementById('readout').textContent;
  const click = id => doc.getElementById(id).click();
  check('开始后计时递增', () => {
    click('start');
    advance(1230);
    return read() === '00:01.23';
  });
  check('暂停后读数保持', () => {
    click('pause');
    advance(3000);
    return read() === '00:01.23';
  });
  check('继续从已有时间累计', () => {
    click('start');
    advance(500);
    return read() === '00:01.73';
  });
  if (spec.laps) {
    check('计次记录当前累积时间', () => {
      click('lap');
      advance(270);
      click('lap');
      return [...doc.querySelectorAll('#laps time')].map(row => row.textContent).join(',') === '00:02.00,00:01.73';
    });
    check('暂停时禁止额外计次', () => {
      click('pause');
      click('lap');
      return doc.getElementById('lap').disabled && doc.querySelectorAll('#laps li').length === 2;
    });
  }
  check('归零后停止计时', () => {
    click('reset');
    advance(1000);
    return read() === '00:00.00' && !doc.getElementById('start').disabled && !doc.querySelector('#laps li');
  });
}

function testGame(doc, win, spec, check, restartDoc) {
  const tiles = () => [...doc.querySelectorAll('[data-tile]')].map(tile => Number(tile.dataset.tile));
  const score = () => Number(doc.getElementById('score').textContent);
  const button = direction => doc.querySelector('[data-move="' + direction + '"]');
  check('无效移动不新增方块', () => {
    const before = tiles().join(',');
    button('up').click();
    return tiles().join(',') === before && score() === 0;
  });
  check('一次移动只合并一遍', () => {
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    return tiles()[0] === 4 && tiles()[1] === 4 && score() === 8
      && doc.getElementById('best-score').textContent === '8';
  });
  check('撤回一步并可重新开局', () => {
    doc.getElementById('undo').click();
    if (score() !== 0 || tiles().slice(0, 4).join(',') !== '2,2,2,2') return false;
    doc.getElementById('new-game').click();
    return score() === 0 && tiles().filter(Boolean).length === 2
      && doc.getElementById('best-score').textContent === '8';
  });
  check('WASD 操作和 90%/10% 出块边界', () => {
    const base = Array(spec.size ** 2).fill(0);
    base[0] = base[1] = 2;
    for (const [chance, expected] of [[0.899, 2], [0.9, 4]]) {
      const dom = restartDoc(base, { chance });
      try {
        const document = dom.window.document;
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
        const live = [...document.querySelectorAll('[data-tile]')].map(tile => Number(tile.dataset.tile)).filter(Boolean);
        if (live.join(',') !== '4,' + expected) return false;
      } finally {
        dom.window.close();
      }
    }
    return true;
  });
  check('可恢复保存的最高分', () => {
    const saved = JSON.parse(win.localStorage.getItem('studio:tiles:' + spec.size + ':' + spec.target));
    const dom = restartDoc(saved.board, { saved });
    try { return dom.window.document.getElementById('best-score').textContent === '8'; }
    finally { dom.window.close(); }
  });
  check('达到目标展示获胜结果', () => {
    const board = Array(spec.size ** 2).fill(0);
    board[0] = board[1] = spec.target / 2;
    const dom = restartDoc(board);
    try {
      const document = dom.window.document;
      document.querySelector('[data-move="left"]').click();
      const popup = document.getElementById('game-outcome');
      if (!popup.open || document.getElementById('outcome-title').textContent !== '合成成功！') return false;
      document.getElementById('continue-game').click();
      return !popup.open && Number(document.querySelector('[data-tile]').dataset.tile) === spec.target;
    } finally {
      dom.window.close();
    }
  });
  check('棋盘走满后提示结束并可重新开始', () => {
    const board = Array.from({ length: spec.size ** 2 }, (_, i) => (Math.floor(i / spec.size) + i % spec.size) % 2 ? 4 : 2);
    const dom = restartDoc(board);
    try {
      const document = dom.window.document;
      const popup = document.getElementById('game-outcome');
      if (!popup.open || document.getElementById('outcome-title').textContent !== '游戏结束') return false;
      popup.querySelector('[data-restart]').click();
      return !popup.open && [...document.querySelectorAll('[data-tile]')].filter(tile => Number(tile.dataset.tile)).length === 2;
    } finally { dom.window.close(); }
  });
}

export function checkArtifact(html, spec, prompt) {
  const tests = [];
  const errors = [];
  const console = new VirtualConsole();
  console.on('jsdomError', () => errors.push('产物脚本发生运行错误'));
  let time = 0;
  const timers = new Map();
  let timerId = 0;

  function open(board, { chance = 0, saved } = {}) {
    return new JSDOM(html, {
      url: 'https://artifact.test/apps/check',
      runScripts: 'dangerously',
      virtualConsole: console,
      beforeParse(window) {
        // Only the trusted, compiled application is executed; its model data is escaped.
        Object.defineProperty(window.performance, 'now', { value: () => time });
        window.setInterval = callback => { timers.set(++timerId, callback); return timerId; };
        window.clearInterval = id => timers.delete(id);
        window.Math.random = () => chance;
        if (board) {
          const key = 'studio:tiles:' + spec.size + ':' + spec.target;
          window.localStorage.setItem(key, JSON.stringify(saved ?? { board, score: 0, undoUsed: false }));
        }
      }
    });
  }
  function check(label, test) {
    let passed = false;
    try { passed = Boolean(test()); } catch {}
    tests.push({ label, passed });
  }
  function advance(ms) {
    time += ms;
    for (const tick of timers.values()) tick();
  }
  const initialBoard = spec.kind === 'game' ? Array(spec.size ** 2).fill(0) : null;
  initialBoard?.fill(2, 0, 4);
  const dom = open(initialBoard);
  try {
    const win = dom.window;
    const doc = win.document;
    check('可渲染独立工作页面', () => doc.title === spec.title && Boolean(doc.querySelector('main')));
    if (spec.kind === 'calculator') testCalculator(doc, win, spec, prompt, check);
    if (spec.kind === 'stopwatch') testStopwatch(doc, advance, check, spec);
    if (spec.kind === 'game') testGame(doc, win, spec, check, open);
    check('运行过程无脚本错误', () => errors.length === 0);
    return tests;
  } finally {
    dom.window.close();
  }
}
