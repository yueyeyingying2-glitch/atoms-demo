const actions = new Set(['visible', 'click', 'fill', 'select', 'press', 'text', 'contains', 'value', 'count', 'changed', 'remember', 'reload']);
const assertions = new Set(['visible', 'text', 'contains', 'value', 'count', 'changed']);
const interactions = new Set(['click', 'fill', 'select', 'press']);
export const maxHtmlBytes = 128 * 1024;
export const maxJobBytes = 192 * 1024;

export function validateCases(cases) {
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 8) throw new Error('验收项应为 2–8 条');
  let interactive = false;
  const validated = cases.map(({ label, steps }) => {
    if (typeof label !== 'string' || !label.trim() || label.length > 100 || !Array.isArray(steps) || !steps.length || steps.length > 12) {
      throw new Error('验收项格式不正确');
    }
    let observed = false;
    let interacted = false;
    let remembered = false;
    const clean = steps.map(({ action, target, value }) => {
      if (action === 'count' && typeof value === 'string' && /^\d{1,3}$/.test(value)) value = Number(value);
      if (['fill', 'text', 'contains', 'value'].includes(action) && Number.isFinite(value)) value = String(value);
      if (action === 'contains' && typeof value === 'string' && !value.trim()) {
        action = 'visible';
        value = undefined;
      }
      if (!actions.has(action) || (action !== 'reload' && (typeof target !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,59}$/.test(target)))) {
        throw new Error('验收步骤格式不正确');
      }
      if (assertions.has(action)) {
        observed = true;
        if (interacted) interactive = true;
      }
      if (interactions.has(action)) interacted = true;
      if (action === 'remember') remembered = true;
      if (action === 'changed' && !remembered) throw new Error('对比变化前需记录原值');
      if (['fill', 'select', 'text', 'contains', 'value'].includes(action) && (typeof value !== 'string' || value.length > 400)) {
        throw new Error('验收值格式不正确');
      }
      if (action === 'count' && (!Number.isInteger(value) || value < 0 || value > 100)) throw new Error('验收数量不正确');
      if (action === 'press' && !/^(Enter|Escape|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|[WASDwasd])$/.test(value)) {
        throw new Error('验收按键不支持');
      }
      return { action, target, value };
    });
    if (!observed) throw new Error('每条用例至少应检查一个页面结果');
    return { label: label.trim(), steps: clean };
  });
  if (!interactive) throw new Error('至少一条用例应操作控件后检查结果');
  return validated;
}
