/**
 * 把部署为某一工作流阶段声明的写作模式追加进原子提示词。
 *
 * 插件本身不改写提示词。宿主把 `compiledForStage` 接到
 * {@link StageProvider.writingSkillsForStage}；未提供回调、阶段未声明，
 * 或返回空白时，提示词保持索引加 `query_writing_patterns` 的路径。
 */

import type { StageProvider } from '../types.ts'

/**
 * 在提示词末尾追加本阶段写作模式。
 * @param prompt - 原子已经拼好的提示词。
 * @param provider - 阶段能力提供者；缺省时不追加。
 * @param stageId - `stagePatterns` 使用的工作流阶段 id。
 * @returns 追加了写作模式的提示词；没有可用文本时返回原提示词。
 */
export function withStageWritingSkills(
  prompt: string,
  provider: StageProvider | undefined,
  stageId: string,
): string {
  const skills = provider?.writingSkillsForStage?.(stageId)
  if (typeof skills !== 'string' || skills.trim().length === 0) return prompt
  return `${prompt}\n\n【本阶段写作模式】\n${skills.trim()}`
}
