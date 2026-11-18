/**
 * 成文与验收两个工具结果共用的 JSON schema 片段。
 *
 * 两处的输出都带 `SectionTally`；schema 与 `types.ts` 的声明必须同步，放在这里就只有
 * 一处要改。成文结果现在内嵌验收结论，因此 `VERIFY_RESULT_SCHEMA` 同时归这两个工具使用。
 * @module @deepseek-ai/dsh-patent-filing/tool/schemas
 */

/** 一节承载的内容量（`SectionTally`）的 JSON schema。 */
export const SECTION_TALLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    key: { type: 'string', required: true },
    paragraphs: { type: 'number', required: true },
    figures: { type: 'number', required: true },
  },
} as const

/** 验收结论（`FilingVerifyResult`）的 JSON schema；独立验收与成文后自动验收共用。 */
export const VERIFY_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    passed: { type: 'boolean', required: true },
    errors: { type: 'array', required: true, items: { type: 'string' } },
    docxPath: { type: 'string', required: true },
    templateFingerprint: { type: 'string', required: true },
    info: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        sections: { type: 'number', required: true },
        headers: { type: 'array', required: true, items: { type: 'string' } },
        paragraphs: { type: 'number', required: true },
        claims: { type: 'number', required: true },
        numbering: { type: 'string', required: true },
        tables: { type: 'number', required: true },
        figures: { type: 'number', required: true },
        layout: { type: 'array', required: true, items: SECTION_TALLY_SCHEMA },
        template: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sections: { type: 'number', required: true },
            sizes_pt: { type: 'array', required: true, items: { type: 'number' } },
            line_spacings: { type: 'array', required: true, items: { type: 'number' } },
          },
        },
      },
    },
  },
} as const
