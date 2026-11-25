/**
 * 披露工作流成功终态的内部装配入口。
 *
 * 映射在 patent-core 的 `assembleDisclosureSpecDraft`。本文件不是插件包入口，
 * `src/index.ts` 的 `export *` 不到这里。同包测试从本文件的相对路径导入。
 * 本函数不把草案写进会话或 knowledge.db。`runWorkflow` 的结果仍不含申请文件正文。
 */

import {
  assembleDisclosureSpecDraft,
  type PipelineState,
  type SpecDraft,
} from '@deepseek-ai/dsh-patent-core'

/**
 * 把披露链成功终态装配成通过 `validateSpecDraft` 的 SpecDraft。
 *
 * 缺 `claims_draft`、`specification` 或著录项键时失败并点名缺口，不改用模型补写。
 * @param state - `patent_disclosure_v1` 跑完后的终态。
 * @returns 已校验的申请文件草案。
 * @throws {DisclosureAssemblyError} 终态缺键或章节对不上。错误类由 patent-core 导出。
 * @throws {DraftValidationError} 装配结果通不过草案校验。
 */
export function assembleDisclosureTerminalState(state: PipelineState): SpecDraft {
  return assembleDisclosureSpecDraft(state)
}
