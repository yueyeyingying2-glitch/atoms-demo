import { buildArtifact } from './artifacts.js';
import { checkArtifact } from './checks.js';
import { askModel, fallbackSpec, validateSpec } from './spec.js';

export function assemble(spec, prompt, source) {
  const validated = validateSpec(spec);
  const html = buildArtifact(validated);
  const checks = checkArtifact(html, validated, prompt);
  return { kind: validated.kind, title: validated.title, description: validated.description, spec: validated, html, checks, source };
}

export async function generate(prompt, modelConfig, emit) {
  let modelFailure;
  const fallback = fallbackSpec(prompt);
  emit('plan', '识别应用类型和所需功能');
  try {
    const spec = await askModel(prompt, modelConfig);
    if (spec?.kind && (!fallback || spec.kind === fallback.kind)
      && !(spec.kind === 'game' && /2048/.test(prompt) && spec.target !== 2048 && fallback?.target === 2048)) {
      emit('build', '将模型方案编译为独立 HTML');
      emit('check', '正在操作产物并核对交互结果');
      const result = assemble(spec, prompt, 'model');
      if (result.checks.every(check => check.passed)) return result;
      modelFailure = result;
    }
  } catch {
    emit('fallback', '模型暂不可用，检查可用的演示模板');
  }
  if (!fallback) return modelFailure ?? null;
  emit('build', '使用演示模板生成独立 HTML');
  emit('check', '正在操作产物并核对交互结果');
  return assemble(fallback, prompt, 'fallback');
}
