const numberField = (id, label, value, unit) => ({ id, label, value, unit, min: 0 });

const curtain = {
  kind: 'calculator',
  title: '窗帘预算计算器',
  description: '用窗宽、褶皱倍数和布料单价估算窗帘预算。',
  fields: [
    numberField('width', '窗宽', 3, '米'),
    numberField('fold', '褶皱倍数', 2, '倍'),
    numberField('price', '每米价格', 100, '元/米')
  ],
  formula: { op: 'mul', args: ['width', 'fold', 'price'] },
  resultLabel: '预计总价',
  unit: '元'
};

export const examples = [
  {
    id: 'curtain-budget',
    prompt: '做一个窗帘预算计算器，输入窗宽、褶皱倍数和每米价格，输出预算。',
    spec: curtain
  },
  {
    id: 'merge-grid',
    prompt: '用原生 HTML、CSS、JavaScript 做一个独立单文件的 4×4 数字合成游戏。支持方向键、WASD 和触摸滑动。每次有效移动后以 90% 概率出 2、10% 概率出 4，同一方块每步最多合并一次。显示分数并保存最高分。合出 2048 后提示胜利并可继续，无法移动时显示结束和重新开始。使用原创配色和平滑动画，兼容手机和电脑。',
    spec: {
      kind: 'game', title: '方阵合成', size: 4, target: 2048,
      description: '滑动方阵，让相同数字相遇。试试合到 2048。'
    }
  },
  {
    id: 'stopwatch',
    prompt: '做一个秒表，支持开始、暂停、继续和归零。',
    spec: {
      kind: 'stopwatch', title: '秒表',
      description: '随时暂停，继续时从已累计的时间开始。'
    }
  }
];

const fallbackCalculators = [
  [/通过率|及格率|合格率/, {
    ...curtain, title: '通过率计算器', description: '根据通过数量和总数量计算通过率。',
    fields: [numberField('passed', '已通过', 24, '项'), numberField('total', '总数量', 30, '项')],
    formula: { op: 'mul', args: [{ op: 'div', args: ['passed', 'total'] }, 100] },
    resultLabel: '通过率', unit: '%'
  }],
  [/装修|地板|铺砖/, {
    ...curtain, title: '装修预算计算器', description: '估算材料和施工的合计费用。',
    fields: [
      numberField('area', '施工面积', 60, '㎡'),
      numberField('price', '每平方米材料价格', 120, '元/㎡'),
      numberField('labor', '人工费', 2000, '元')
    ],
    formula: { op: 'add', args: [{ op: 'mul', args: ['area', 'price'] }, 'labor'] }
  }],
  [/折扣|打折/, {
    ...curtain, title: '折扣计算器', description: '按原价和折扣比例计算成交价。',
    fields: [numberField('price', '原价', 100, '元'), numberField('rate', '折扣比例', 80, '%')],
    formula: { op: 'div', args: [{ op: 'mul', args: ['price', 'rate'] }, 100] },
    resultLabel: '折后金额'
  }]
];

export function fallbackSpec(prompt) {
  if (/2048|合成.*(?:游戏|挑战)|数字.*合成|merge.*tile/i.test(prompt)) {
    const game = examples[1].spec;
    const target = Number(prompt.match(/(?:目标|合出|达到)\s*(256|512|1024|2048|4096)\b/)?.[1]);
    const size = Number(prompt.match(/([456])\s*[x×*]\s*\1/i)?.[1]);
    return { ...game, size: size || game.size, target: target || game.target };
  }
  if (/秒表|计时器|stopwatch/i.test(prompt)) {
    return { ...examples[2].spec, laps: /计次|记圈|圈速|分段记录/.test(prompt) };
  }
  if (/窗帘|褶皱/.test(prompt)) {
    if (!/安装费/.test(prompt)) return curtain;
    return {
      ...curtain, fields: [...curtain.fields, numberField('install', '安装费', 80, '元')],
      formula: { op: 'add', args: [curtain.formula, 'install'] }
    };
  }
  const calculator = fallbackCalculators.find(([pattern]) => pattern.test(prompt));
  return calculator?.[1] ?? null;
}

const systemPrompt = `你为一个中文应用生成器生成 JSON 对象，程序据此编译为可执行的 HTML。仅输出 JSON。
支持三类应用：
1. calculator。例：{"kind":"calculator","title":"折扣计算器","description":"输入价格和折扣比例。","fields":[{"id":"price","label":"原价","unit":"元","value":100,"min":0},{"id":"rate","label":"折扣比例","unit":"%","value":80,"min":0}],"formula":{"op":"div","args":[{"op":"mul","args":["price","rate"]},100]},"resultLabel":"折后金额","unit":"元"}。
formula 的元素只能是数字、字段 id 或 {op,args}，op 支持 add、sub、mul、div。sub、div 恰好两个参数。
字段 id 是短英文标识符。字段数量 1 到 6。默认值要能算出有限结果。准确实现用户指定的字段和运算。
2. game。格式 {"kind":"game","title":"数字合成挑战","description":"移动并合并相同数字。","size":4,"target":2048}。仅支持原创数字合成变体，尺寸 4、5 或 6，目标 256、512、1024、2048、4096。
3. stopwatch。格式 {"kind":"stopwatch","title":"秒表","description":"用于精确计时。","laps":false}。功能包括开始、暂停、继续、归零，用户要求计次、记圈或分段记录时将 laps 设为 true。
超出三类时输出 {"kind":"unsupported"}。字段内容是普通文本。请勿输出 JavaScript、HTML 或 Markdown。`;

function text(value, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function formula(value, ids, depth = 0) {
  if (Number.isFinite(value) && Math.abs(value) <= 1e9) return value;
  if (typeof value === 'string' && ids.has(value)) return value;
  if (depth > 4 || !['add', 'sub', 'mul', 'div'].includes(value?.op) || !Array.isArray(value.args)) {
    throw new Error('公式格式不正确');
  }
  const { op, args } = value;
  if (args.length < 2 || args.length > 6 || (['sub', 'div'].includes(op) && args.length !== 2)) {
    throw new Error('公式参数数量不正确');
  }
  return { op, args: args.map(arg => formula(arg, ids, depth + 1)) };
}

export function validateSpec(input) {
  const title = text(input?.title, 44);
  const description = text(input?.description);
  const { kind } = input ?? {};
  if (!title || !['calculator', 'game', 'stopwatch'].includes(kind)) throw new Error('应用类型或标题不正确');
  const common = { kind, title, description };
  if (kind === 'stopwatch') return { ...common, laps: input.laps === true };
  if (kind === 'game') {
    if (![4, 5, 6].includes(input.size) || ![256, 512, 1024, 2048, 4096].includes(input.target)) {
      throw new Error('游戏棋盘或目标不正确');
    }
    return { ...common, size: input.size, target: input.target };
  }
  if (!Array.isArray(input.fields) || !input.fields.length || input.fields.length > 6) {
    throw new Error('计算字段数量不正确');
  }
  const ids = new Set();
  const fields = input.fields.map(field => {
    const id = text(field?.id, 25);
    const label = text(field?.label, 28);
    const value = field?.value;
    const min = field?.min ?? 0;
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(id) || ids.has(id) || !label
      || !Number.isFinite(value) || !Number.isFinite(min) || value < min || Math.abs(value) > 1e9) {
      throw new Error('计算字段无效');
    }
    ids.add(id);
    return { id, label, value, min, unit: text(field.unit, 12) };
  });
  return {
    ...common, fields, formula: formula(input.formula, ids),
    resultLabel: text(input.resultLabel, 24) || '计算结果', unit: text(input.unit, 12)
  };
}

export async function askModel(prompt, config, signal) {
  const { baseUrl, model, key, timeoutMs = 12000 } = config;
  if (!baseUrl || !model || !key) return null;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  for (let attempt = 0; attempt < 2; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        response_format: { type: 'json_object' }, max_tokens: 1200
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    if ([429, 502, 503, 504].includes(response.status) && attempt === 0) {
      await response.body?.cancel();
      await new Promise(resolve => setTimeout(resolve, 700));
      signal?.throwIfAborted();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('模型请求失败');
    }
    const payload = await response.json();
    const value = JSON.parse(payload.choices?.[0]?.message?.content);
    if (value.kind === 'unsupported') return { unsupported: true };
    return validateSpec(value);
  }
  return null;
}
