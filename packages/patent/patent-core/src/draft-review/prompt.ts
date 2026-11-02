/**
 * src/draft-review/prompt — 审查提示词与结构化输出 schema。
 *
 * 提示词只携带说明书、权利要求、PFIE 特征与检索文献；策略表与融合结果是
 * 撰写方的决策过程，不进入审查上下文。
 */

import { dataBlock, withStageWritingSkills } from '../prompt-hygiene.ts'
import type { StageProvider } from '../types.ts'
import {
  DRAFT_REVIEW_CATEGORIES,
  DRAFT_REVIEW_PROVISIONS,
  DRAFT_REVIEW_RECOMMENDATIONS,
  type DraftReviewCategory,
  type DraftReviewInput,
} from './types.ts'

/** 五类口径的判定说明，逐条写进提示词。 */
const CATEGORY_GUIDANCE: Readonly<Record<DraftReviewCategory, string>> = {
  enablement: 'A26.3 充分公开：独立权利要求的必要技术特征在说明书中缺少实施例、参数或效果，导致本领域技术人员无法实现。',
  support: 'A26.4 权利要求支持：权利要求的上位概括超出说明书公开的范围，缺少对应的下位实施方式。',
  clarity: 'A26.4 清楚性：权利要求中的术语、参数或引用关系不清楚，保护范围无法确定。',
  unity: 'A31.1 单一性：两项以上独立权利要求之间缺少相同或相应的特定技术特征。',
  amendment: 'A33 修改依据：拟写入的权利要求或说明书内容超出原始交底书记载的范围。',
}

/** 模型输出 schema；只允许结构化字段，不接收自由推理。 */
export const DRAFT_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    disputes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: DRAFT_REVIEW_CATEGORIES,
            description: '审查口径',
          },
          recommendation: {
            type: 'string',
            enum: DRAFT_REVIEW_RECOMMENDATIONS,
            description: '可执行建议；无需修改时为 none',
          },
          claimNumber: { type: 'integer', minimum: 1, description: '涉及的权利要求序号（可选）' },
          featureId: { type: 'string', description: '涉及的 PFIE 特征编号（可选）' },
          anchor: { type: 'string', description: '说明书或权利要求中的逐字摘录（可选）' },
        },
        required: ['category', 'recommendation'],
      },
    },
    notes: { type: 'string', description: '审查说明（可选，不得包含推理过程）' },
  },
  required: ['disputes'],
} as const

/** 提示词可用的输入预算：说明书与权利要求各取一段，保证审查能看到完整主体。 */
export type DraftReviewPromptLimits = {
  /** 说明书截断上限。 */
  specificationLimit: number
  /** 权利要求截断上限。 */
  claimsLimit: number
  /** PFIE 参考截断上限。 */
  pfeLimit: number
  /** 检索文献截断上限。 */
  priorArtLimit: number
}

/**
 * 构造审查提示词。
 * @param input - 审查输入。
 * @param limits - 各块截断上限。
 * @param provider - 阶段能力提供者；用于追加宿主注入的写作模式。
 * @returns 完整提示词。
 */
export function buildDraftReviewPrompt(
  input: DraftReviewInput,
  limits: DraftReviewPromptLimits,
  provider?: StageProvider,
): string {
  const categoryLines = DRAFT_REVIEW_CATEGORIES.map(
    category => `- ${category}（${DRAFT_REVIEW_PROVISIONS[category]}）：${CATEGORY_GUIDANCE[category]}`,
  )
  const pfeBlock = input.pfe.trim().length === 0
    ? ''
    : `\n【PFIE 特征】\n${dataBlock(input.pfe.slice(0, limits.pfeLimit))}`
  const priorArtBlock = input.priorArt.trim().length === 0
    ? ''
    : `\n【检索文献】\n${dataBlock(input.priorArt.slice(0, limits.priorArtLimit))}`
  return withStageWritingSkills([
    '你是不利方的专利审查员，负责审查一份正在成稿的专利申请。',
    '你只看到说明书、权利要求、PFIE 特征与检索文献；撰写方的策略表、融合结果与改写说明不在你的审查材料中。',
    '只从说明书、权利要求、PFIE 特征与检索文献出发，逐条列出审查员会提出的争议点；不要复述撰写方的决策过程。',
    '审查口径（每条争议点必须归入其中一类）：',
    ...categoryLines,
    '要求：',
    '- 只输出结构化争议点，不输出推理过程、分析步骤或解释性段落；',
    '- 锚点必须逐字摘自说明书或权利要求，不得改写、拼接或转述；',
    '- 指向具体权项时给出 claimNumber，指向具体特征时给出 featureId；',
    '- 建议按问题性质选择：补实施例 add-embodiment、收紧权项 tighten-claim、澄清术语 clarify-term、拆分单一性 split-unity；无需修改记 none；',
    '- 同一类问题在同一权项/特征上只报一次；没有争议点时 disputes 为空数组；',
    '- 宁缺毋滥：无法定位到原文或只能给出泛泛评价的，不要列入。',
    '',
    '【权利要求草稿】',
    dataBlock(input.claims.slice(0, limits.claimsLimit)),
    pfeBlock,
    priorArtBlock,
    '',
    '【说明书】',
    dataBlock(input.specification.slice(0, limits.specificationLimit)),
    '',
    '请严格输出 JSON：disputes 为争议点数组（category、recommendation、可选 claimNumber/featureId/anchor），notes 为审查说明。',
  ].filter(line => line !== '').join('\n'), provider, 'draft_review')
}
