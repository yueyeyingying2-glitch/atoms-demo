import { buildArtifact } from './artifacts.js';
import { checkArtifact } from './checks.js';
import { askModel, fallbackSpec, validateSpec } from './spec.js';

export function assemble(spec, prompt, source) {
  const validated = validateSpec(spec);
  const html = buildArtifact(validated);
  const checks = checkArtifact(html, validated, prompt);
  return { kind: validated.kind, title: validated.title, description: validated.description, spec: validated, html, checks, source };
}

export function isRevision(prompt) {
  return /^(?:请|帮我)?(?:给|将|把|在|为|对)?(?:刚才|当前|这个|上一版|现有|原来的|上一个)/.test(prompt)
    || /^(?:请|帮我)?(?:增加|添加|修改|改成|删除|移除|去掉|改一下)/.test(prompt);
}

export function revise(prompt, parent, emit) {
  emit('plan', '核对当前版本和修改要求');
  const addsLap = /(?:加|支持|实现|新增).{0,12}(?:计次|记圈|圈速|分段记录)/.test(prompt);
  if (parent.kind !== 'stopwatch' || !addsLap || /(?:去掉|删除|移除|取消).{0,10}(?:计次|记圈)/.test(prompt)) {
    return { error: '当前支持给秒表添加计次。此修改未应用，上一版可继续使用。' };
  }
  if (parent.html.includes('id="lap"')) {
    return { error: '这个秒表已经支持计次，可以继续使用当前版本。' };
  }
  emit('build', '保留当前秒表并添加计次记录');
  emit('check', '正在验证秒表原有功能和新增计次');
  const project = assemble({
    kind: 'stopwatch', title: parent.title, description: parent.description, laps: true
  }, prompt, 'revision');
  return { ...project, parentId: parent.id };
}

export async function generate(prompt, modelConfig, emit, signal) {
  let modelFailure;
  const fallback = fallbackSpec(prompt);
  emit('plan', '识别应用类型和所需功能');
  try {
    const spec = await askModel(prompt, modelConfig, signal);
    signal?.throwIfAborted();
    if (spec?.kind && (!fallback || spec.kind === fallback.kind)
      && !(spec.kind === 'stopwatch' && fallback?.laps && !spec.laps)
      && !(spec.kind === 'game' && /2048/.test(prompt) && spec.target !== 2048 && fallback?.target === 2048)) {
      emit('build', '将模型方案编译为独立 HTML');
      emit('check', '正在操作产物并核对交互结果');
      const result = assemble(spec, prompt, 'model');
      if (result.checks.every(check => check.passed)) return result;
      modelFailure = result;
    }
  } catch {
    signal?.throwIfAborted();
    emit('fallback', '模型暂不可用，检查可用的演示模板');
  }
  if (!fallback) return modelFailure ?? null;
  emit('build', '使用演示模板生成独立 HTML');
  emit('check', '正在操作产物并核对交互结果');
  return assemble(fallback, prompt, 'fallback');
}
