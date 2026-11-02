import type { StageProvider } from './types.ts'

/**
 * 专利域 — LLM 结构化抽取输入卫生（防提示注入）。
 *
 * 吸收 semantica-cnlaw llm_extraction.py 的 json.dumps 隔离思路：
 * 不可信外部文本（交底书 / 检索文献 / 法条 / 用户输入）统一经 dataBlock 序列化为
 * JSON 字符串字面量，与指令区物理隔离——即使文本内含 `</data>`、围栏闭合符
 * 或注入指令，也无法逃逸出数据段（JSON 字符串里它们只是普通字符，且 `</`
 * 经 `<\/` 转义后字面上不可能出现可闭合外层块的标签文本）。
 *
 * 约定：所有 LLM 结构化抽取通道的「外部文本拼接」必须走 dataBlock，禁止明文
 * 拼接进指令区。指令区只含开发 / 工作流作者可控的文本。
 * @module @deepseek-ai/dsh-patent-core/prompt-hygiene
 */

/**
 * 把不可信外部值序列化为隔离数据块。
 *
 * JSON.stringify 使内容成为单个字符串字面量：换行 / 引号 / 反斜杠被转义，无法闭合
 * 外层块。它不转义 `<`，故仅把 `</` 序列额外转义为 `<\/`——单个 `<`（如
 * "厚度<5mm"）保留原样，满足 claim-chart 等下游的逐字引用契约；`</data>`
 * 伪闭合符因 `</` 被转义，字面上不再出现闭合标签，无法逃逸数据段。`\/` 经
 * JSON.parse 还原为 `/`，内容无损。
 * @param value - 待隔离的外部值（字符串 / 数组 / 对象）。
 * @returns 形如 `<data>\n<JSON 字面量>\n</data>` 的数据块；`undefined` 兜底为空串
 *   内容（`JSON.stringify(undefined)` 返回 undefined），`null` 输出 `null` 字面量。
 */
export function dataBlock(value: unknown): string {
  // JSON.stringify 的 lib 声明返回 string，但 undefined / function / symbol 实际返回 undefined。
  const json: unknown = JSON.stringify(value)
  const literal = typeof json === 'string' ? json : ''
  return `<data>\n${literal.replace(/<\//g, '<\\/')}\n</data>`
}

/**
 * 在提示词末尾追加本阶段写作模式。
 *
 * 宿主把 `compiledForStage` 接到 {@link StageProvider.writingSkillsForStage}。
 * 未提供回调、阶段未声明，或返回空白时，提示词保持原样。
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
