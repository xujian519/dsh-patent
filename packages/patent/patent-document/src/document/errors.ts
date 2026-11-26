/**
 * 渲染管线的输入契约错误：非法文件名/案卷号/模板 id 等用户输入问题。
 *
 * 与运行时错误（Chrome 缺失、IO 失败）区分，便于工具层映射为
 * `invalid_tool_input` 而非 `tool_execution_failed`。继承 `HarnessError`，
 * 使该错误码进入 `tool/result`。
 * @module @deepseek-ai/dsh-patent-document/document/errors
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * 专利文书渲染的输入契约错误（自 Sati SatiDocumentInputError 重命名）。
 */
export class DocumentRenderError extends HarnessError {
  /**
   * 构造输入契约错误。
   * @param message - 描述非法输入的人类可读信息。
   */
  constructor(message: string) {
    super(message, 'invalid_tool_input')
  }
}
