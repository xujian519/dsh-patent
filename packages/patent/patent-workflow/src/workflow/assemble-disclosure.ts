/**
 * 披露工作流成功终态的装配入口。
 *
 * 映射在 patent-core。本模块只调用它，不把草案写进会话或 knowledge.db。
 * `runWorkflow` 的阶段结果仍不含申请文件正文。
 */

import {
  assembleDisclosureSpecDraft,
  type PipelineState,
  type SpecDraft,
} from '@deepseek-ai/dsh-patent-core'

export { DisclosureAssemblyError } from '@deepseek-ai/dsh-patent-core'

/**
 * 把披露链成功终态装配成通过 `validateSpecDraft` 的 SpecDraft。
 *
 * 缺 `claims_draft`、`specification` 或著录项键时失败并点名缺口，不改用模型补写。
 * @param state - `patent_disclosure_v1` 跑完后的终态。
 * @returns 已校验的申请文件草案。
 * @throws {DisclosureAssemblyError} 终态缺键或章节对不上。
 * @throws {DraftValidationError} 装配结果通不过草案校验。
 */
export function assembleDisclosureTerminalState(state: PipelineState): SpecDraft {
  return assembleDisclosureSpecDraft(state)
}
