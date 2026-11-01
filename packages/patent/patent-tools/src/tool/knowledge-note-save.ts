/**
 * `knowledge_note_save` tool: persist a project knowledge note (OA reply
 * points, invalidation-analysis conclusions, search notes) for later recall.
 * Ported from Sati's knowledgeNoteSave.ts.
 *
 * Sati writes to knowledge.db (documents/chunks/docs_fts via openKnowledgeDb);
 * dsh-patent-knowledge has NO write API. This port therefore delegates the
 * write to an injected \`writeNote\` dep (the integrator wires ctx.storage to
 * a case-dir file). The idempotency key (sha1(project|title|content) → 16 hex)
 * is preserved so duplicate saves are skipped. The knowledge.db write API is
 * deferred — see the Known Limitations note in the report.
 * @module @deepseek-ai/dsh-patent-tools/tool/knowledge-note-save
 */

import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'

/** Input for the knowledge_note_save tool. */
export type KnowledgeNoteSaveInput = {
  /** 笔记标题（≤200 字符；作为检索索引词）。 */
  title: string
  /** 笔记正文（≤20,000 字符）。 */
  content: string
  /** 来源项目标签（可选，参与幂等与检索过滤）。 */
  project?: string
}

/** Output of the knowledge_note_save tool. */
export type KnowledgeNoteSaveOutput = {
  /** 是否已写入（duplicate/skipped 时为 false）。 */
  saved: boolean
  /** 幂等 id（duplicate 时也返回，便于定位既有条目）。 */
  documentId?: string
  /** 落库方式：inserted=新增，duplicate=重复跳过，skipped=内容为空跳过。 */
  reason?: 'inserted' | 'duplicate' | 'skipped'
  /** 正文字符数（inserted 时返回）。 */
  charCount?: number
  /** 笔记文件路径（inserted 时返回；knowledge.db 写 API 未接入，落文件）。 */
  path?: string
}

/** 传给 writeNote 的规范化笔记载荷。 */
export type KnowledgeNote = {
  documentId: string
  title: string
  content: string
  project?: string
}

/** writeNote 的写入结果：写入成功返回路径，重复返回 duplicate。 */
export type WriteNoteResult =
  | { saved: true; path: string }
  | { saved: false; reason: 'duplicate' }

/** Injected note writer (tests override; production wires ctx.storage to a case dir). */
export type KnowledgeNoteSaveDeps = {
  /** Persist one note; return the file path or a duplicate marker. */
  writeNote: (note: KnowledgeNote) => Promise<WriteNoteResult>
}

/** 内容/标题上限（防单条笔记撑爆检索与上下文）。 */
const MAX_TITLE_CHARS = 200
/** 笔记正文字符上限。 */
const MAX_CONTENT_CHARS = 20_000

/**
 * 笔记 id：sha1(project|title|content) 前 16 位（幂等键）。
 * @param project - 来源项目标签（可选）。
 * @param title - 笔记标题。
 * @param content - 笔记正文。
 * @returns 16 位十六进制幂等 id。
 */
export function noteDocumentId(project: string | undefined, title: string, content: string): string {
  return createHash('sha1')
    .update(`${project ?? ''}|${title}|${content}`)
    .digest('hex')
    .slice(0, 16)
}

/** Render the canonical save value into model-facing prose. */
function renderKnowledgeNoteSave(value: KnowledgeNoteSaveOutput): string {
  if (value.reason === 'inserted') {
    return `已沉淀笔记（id=${value.documentId}，${value.charCount} 字符，路径 ${value.path}），可用文件检索/grep 在笔记目录中召回。`
  }
  if (value.reason === 'duplicate') {
    return `笔记已存在（id=${value.documentId}），跳过重复保存。`
  }
  return '笔记跳过（title 与 content 均不能为空）。'
}

const DESCRIPTION = [
  '把项目专利产出（OA 答复要点、无效分析结论、检索心得）沉淀为知识笔记，后续检索可召回。用于定稿后建议沉淀：如 knowledge_note_save({title, content, project})。同一内容重复保存会自动跳过（幂等）。',
  '',
  '注意：dsh 的知识库写 API（knowledge.db personal_note 层）尚未接入，当前落为案卷目录下的笔记文件。',
].join('\n')
/**
 * Build the `knowledge_note_save` tool over an injected note writer.
 * @param deps - the note writer.
 * @returns a registry-ready tool definition.
 */
export function createKnowledgeNoteSaveTool(deps: KnowledgeNoteSaveDeps): ToolDefinition {
  return defineTool({
    name: 'knowledge_note_save',
    description: DESCRIPTION,
    parameters: {
      title: { type: 'string', required: true, description: '笔记标题（≤200 字符，作为检索索引词）' },
      content: { type: 'string', required: true, description: '笔记正文（≤20,000 字符）' },
      project: { type: 'string', description: '来源项目标签（可选，参与幂等与检索过滤）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          saved: { type: 'boolean', required: true },
          documentId: { type: 'string' },
          reason: { type: 'string', enum: ['inserted', 'duplicate', 'skipped'] },
          charCount: { type: 'integer' },
          path: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderKnowledgeNoteSave(value) }],
    },
    async execute(args) {
      const title = args.title.trim()
      const content = args.content.trim()
      if (!title || !content) {
        return { saved: false, reason: 'skipped' } as const
      }
      if (Array.from(title).length > MAX_TITLE_CHARS) {
        throw new PatentToolError('invalid_tool_input', `title 超过 ${MAX_TITLE_CHARS} 字符上限。`, { tool: 'knowledge_note_save' })
      }
      if (Array.from(content).length > MAX_CONTENT_CHARS) {
        throw new PatentToolError('invalid_tool_input', `content 超过 ${MAX_CONTENT_CHARS} 字符上限。`, { tool: 'knowledge_note_save' })
      }
      const documentId = noteDocumentId(args.project, title, content)
      let written: WriteNoteResult
      try {
        written = await deps.writeNote({
          documentId,
          title,
          content,
          ...(args.project === undefined ? {} : { project: args.project }),
        })
      } catch (error) {
        // 配置类失败（未接线的 fail-loud 桩）保留 setup_required 码，供按码路由的调用方判别。
        if (error instanceof PatentToolError && error.code === 'setup_required') throw error
        throw new PatentToolError(
          'tool_execution_failed',
          `笔记保存失败：${error instanceof Error ? error.message : String(error)}`,
          { tool: 'knowledge_note_save' },
        )
      }
      if (written.saved) {
        return { saved: true, documentId, reason: 'inserted', charCount: content.length, path: written.path } as const
      }
      return { saved: false, documentId, reason: written.reason } as const
    },
  })
}
