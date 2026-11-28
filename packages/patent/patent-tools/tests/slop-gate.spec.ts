import { describe, expect, it } from 'vitest'
import { SlopGateHandler } from '../src/atoms/slop-gate.ts'
import { analyzeSlop, type SlopAnalysis } from '@deepseek-ai/dsh-patent-core'
import { buildSlopRevisionHint } from '../src/internal/retry-hints.ts'

const handler = new SlopGateHandler()

const CLEAN_DRAFT = [
  '本申请解决测量误差的控制问题，核心争点是反馈补偿环节。',
  '',
  '区别特征记载于 D1¶0123，与现有技术相比，本申请在补偿环节引入闭环反馈结构。',
  '',
  '对比文件 D1 公开了基础结构，本申请在反馈路径中增设误差积分器。',
].join('\n')

const SLOP_HEAVY_DRAFT = [
  '首先分析本申请的技术方案，再分析现有技术方案。',
  '',
  '进一步地，此外，值得一提的是，本申请具有显著进步。',
  '',
  '区别特征在于采用了新型结构。',
  '',
  '综上所述，保护范围合理。',
].join('\n')

// 10 个短语命中（删除型排前，替换型被截断到第 8 条之外）+ 1 个结构性问题，
// 超出 hint 的证据条数上限——验证「截断到 8 changes + 3 issues」与 residual 统计。
const SLOP_OVERFLOW_DRAFT = [
  '进一步地，此外，值得一提的是，不难发现，毋庸置疑，综上所述，诚如前述，显而易见地，深入分析，全面论述。',
  '',
  '区别特征在于采用了新型结构。',
  '',
  '综上所述，保护范围合理。',
].join('\n')

// 替换型命中（「深入分析→分析」「全面论述→论述」）在截断窗口内——覆盖替换型渲染分支。
const SLOP_REPLACEMENT_DRAFT = [
  '深入分析，全面论述。',
  '',
  '区别特征在于采用了新型结构。',
].join('\n')

// 无套话、无证据、无争点的三段式文本：total=34 < 通过线 35，但无可引证据。
const SLOP_FAIL_WITHOUT_EVIDENCE = [
  '本申请采用闭环结构。',
  '',
  '第二段描述方案 B。',
  '',
  '第三段描述方案 C。',
].join('\n')

/** 合规的意见陈述书正文（八节骨架、每条论证都带证据锚点）。 */
const COMPLIANT_RESPONSE = [
  '# 意见陈述书',
  '',
  '**申请号：** CN2026XXXXXXXX.X',
  '**发明名称：** 一种智能保温杯',
  '',
  '> 说明：本稿引用的对比文件为审查意见明确引用的 D1。',
  '',
  '## 一、总体立场',
  '审查意见对权利要求 1 的创造性异议不能成立。',
  '',
  '修改后的权利要求 1 补入了水温联动特征，请求在此基础上继续审查。',
  '',
  '## 二、本次修改',
  '修改对照见表 1。',
  '',
  '修改依据为原说明书第 [0031] 段。',
  '',
  '## 三、本案事实',
  'F1：权利要求 1 记载「加热单元根据水温自动启停」（见 3.1 节）。',
  '',
  'P1：审查意见仅认定 D1 公开了加热单元本身，未认定联动控制被公开。',
  '',
  '## 四、适用规则',
  'R1：专利法第22条第3款。',
  '',
  'R2：创造性判断的三步法。',
  '',
  '## 五、意见陈述',
  '### 5.1 新颖性',
  'D1 ¶0123 未公开 F2 所载的联动控制，权利要求 1 具备新颖性。',
  '',
  '### 5.2 创造性',
  '区别特征 F2 的实际作用是按需补热，D1 与 D2 均未给出结合启示（见 3.1 节）。',
  '',
  'D2 ¶0045 仅公开定时加热，未涉及按水温启停。',
  '',
  '## 六、证据与引用',
  '| 编号 | 文献 | 用途 |',
  '',
  '## 七、结论与请求',
  '请求在修改文本的基础上继续审查。',
].join('\n')

/** 套话版意见陈述书：命中 oa_formula 与无锚点的区别特征陈述。 */
const SLOP_RESPONSE = [
  '# 意见陈述书',
  '',
  '## 一、总体立场',
  '申请人恳请审查员重新考虑审查意见，本次答复理由是充分的。',
  '',
  '## 五、意见陈述',
  '进一步地，此外，值得一提的是，审查员认定有误，本申请具有显著进步。',
  '',
  '区别特征在于采用了新型结构。',
].join('\n')

describe('SlopGateHandler', () => {
  it('passes a clean draft and emits no revision hint', async () => {
    const analysis = analyzeSlop(CLEAN_DRAFT)
    expect(analysis.score.passed).toBe(true)
    const out = await handler.execute({ state: { claims_draft: CLEAN_DRAFT } })
    expect(out.slop_report).toMatch(/通过/)
    expect(out.slop_score).toBe(analysis.score.total)
    expect(out.slop_revision_hint).toBeUndefined()
  })

  it('flags a slop-heavy draft with 需修订 and writes an evidence-only hint', async () => {
    const analysis = analyzeSlop(SLOP_HEAVY_DRAFT)
    expect(analysis.score.passed).toBe(false)
    const out = await handler.execute({ state: { claims_draft: SLOP_HEAVY_DRAFT } })
    expect(out.slop_report).toMatch(/需修订/)
    expect(out.slop_score).toBe(analysis.score.total)
    expect(typeof out.slop_revision_hint).toBe('string')
  })

  it('flags a failed draft that carries no actionable evidence without a hint', async () => {
    const analysis = analyzeSlop(SLOP_FAIL_WITHOUT_EVIDENCE)
    expect(analysis.score.passed).toBe(false)
    expect(buildSlopRevisionHint(analysis)).toBeUndefined()
    const out = await handler.execute({ state: { claims_draft: SLOP_FAIL_WITHOUT_EVIDENCE } })
    expect(out.slop_report).toMatch(/需修订/)
    expect(out.slop_revision_hint).toBeUndefined()
  })

  it('degrades when claims_draft is missing or blank', async () => {
    const missing = await handler.execute({ state: {} })
    expect(String(missing._error)).toMatch(/输入为空/)
    const blank = await handler.execute({ state: { claims_draft: '   ' } })
    expect(String(blank._error)).toMatch(/输入为空/)
  })

  it('reads the text named by text_keys so the same gate serves the response body', async () => {
    const out = await handler.execute({
      state: { text_keys: ['draft'], draft: COMPLIANT_RESPONSE, char_budget: 4000 },
    })
    expect(out.slop_report).toMatch(/通过/)
    expect(out.slop_score).toBe(analyzeSlop(COMPLIANT_RESPONSE, { charBudget: 4000 }).score.total)
    expect(out.slop_revision_hint).toBeUndefined()
  })

  it('flags a formulaic response and passes the evidence hint to the rewind', async () => {
    const out = await handler.execute({
      state: { text_keys: ['draft'], draft: SLOP_RESPONSE, char_budget: 4000 },
    })
    expect(out.slop_report).toMatch(/需修订/)
    expect(typeof out.slop_revision_hint).toBe('string')
    expect(String(out.slop_revision_hint)).toMatch(/审查员认定有误|重新考虑/)
  })

  it('falls through to the declared keys in order and joins the non-empty ones', async () => {
    const both = await handler.execute({
      state: { text_keys: ['draft', 'claims_draft'], draft: '', claims_draft: CLEAN_DRAFT },
    })
    expect(both.slop_report).toMatch(/通过/)
    // 空串键被跳过：只有 claims_draft 参与判定，等价于撰写链路的默认路径。
    expect(both.slop_score).toBe(analyzeSlop(CLEAN_DRAFT).score.total)
  })

  it('uses each declared key verbatim instead of trimming it into another key', async () => {
    const verbatim = await handler.execute({
      state: { text_keys: [' draft '], ' draft ': CLEAN_DRAFT },
    })
    expect(verbatim.slop_report).toMatch(/通过/)
    // 带空格的键不会被裁剪成 `draft`：与 patent-core 的键列表语义保持一致。
    const padded = await handler.execute({
      state: { text_keys: [' draft '], draft: CLEAN_DRAFT },
    })
    expect(String(padded._error)).toMatch(/输入为空/)
  })

  it('degrades on invalid text_keys or char_budget instead of guessing', async () => {
    for (const state of [
      { claims_draft: CLEAN_DRAFT, text_keys: [] },
      { claims_draft: CLEAN_DRAFT, text_keys: ['  '] },
      { claims_draft: CLEAN_DRAFT, text_keys: 'claims_draft' },
    ]) {
      const out = await handler.execute({ state })
      expect(String(out._error)).toMatch(/text_keys 必须是非空字符串数组/)
    }
    for (const charBudget of [0, -1, 1.5, '4000']) {
      const out = await handler.execute({ state: { claims_draft: CLEAN_DRAFT, char_budget: charBudget } })
      expect(String(out._error)).toMatch(/char_budget 必须是正整数/)
    }
  })

  it('budgets each feature-cited embodiment block and still scores absolute slogans on the whole text', async () => {
    const slogan = '具有显著进步。质的飞跃。革命性。'
    const specification = `${CLEAN_DRAFT}\n\n${slogan}`
    const blocks = [{ index: 1, text: slogan, feature_ids: ['F1'] }]
    const within = await handler.execute({
      state: {
        text_keys: ['specification'],
        specification,
        embodiment_char_budget: 1500,
        embodiment_blocks: blocks,
      },
    })
    expect(within.slop_score).toBe(analyzeSlop(specification).score.total)
    expect(within.slop_score).toBeLessThan(analyzeSlop(CLEAN_DRAFT).score.total)
    expect(String(within.slop_report)).toContain('实施例1')
    expect(String(within.slop_report)).toContain('未超出预算')

    const oversized = '甲'.repeat(1501)
    const over = await handler.execute({
      state: {
        text_keys: ['specification'],
        specification: CLEAN_DRAFT,
        embodiment_char_budget: 1500,
        embodiment_blocks: [{ index: 2, text: oversized, feature_ids: ['F1'] }],
      },
    })
    expect(over.slop_score).toBe(analyzeSlop(CLEAN_DRAFT).score.total)
    expect(String(over.slop_report)).toMatch(/需修订/)
    expect(String(over.slop_report)).toContain('超出预算')
    // 总分过线但实施例超预算同样回退重写：提示必须指出哪一块超了多少。
    expect(String(over.slop_revision_hint)).toContain('实施例2 1501/1500')
  })

  it('ignores blocks without feature ids and rejects a malformed embodiment budget', async () => {
    const skipped = await handler.execute({
      state: {
        text_keys: ['specification'],
        specification: CLEAN_DRAFT,
        embodiment_char_budget: 1500,
        embodiment_blocks: [{ index: 1, text: '甲'.repeat(2000), feature_ids: [] }],
      },
    })
    expect(String(skipped.slop_report)).toContain('无带特征编号的实施例块')
    expect(String(skipped.slop_report)).toMatch(/通过/)

    const absent = await handler.execute({
      state: { text_keys: ['specification'], specification: CLEAN_DRAFT, embodiment_char_budget: 1500 },
    })
    expect(String(absent.slop_report)).toContain('无带特征编号的实施例块')

    for (const embodimentBlocks of [
      'nope',
      [null],
      ['甲'],
      [[]],
      [{ index: 1, text: 1, feature_ids: ['F1'] }],
      [{ index: 1, text: '甲', feature_ids: [1] }],
      [{ index: 1, text: '甲', feature_ids: 'F1' }],
      [{ index: 0, text: '甲', feature_ids: ['F1'] }],
      [{ index: '1', text: '甲', feature_ids: ['F1'] }],
      [{ index: 1.5, text: '甲', feature_ids: ['F1'] }],
    ]) {
      const out = await handler.execute({
        state: {
          text_keys: ['specification'],
          specification: CLEAN_DRAFT,
          embodiment_char_budget: 1500,
          embodiment_blocks: embodimentBlocks,
        },
      })
      expect(String(out._error)).toMatch(/embodiment_blocks/)
    }
    for (const embodimentCharBudget of [0, -1, 1.5, '1500']) {
      const badBudget = await handler.execute({
        state: { claims_draft: CLEAN_DRAFT, embodiment_char_budget: embodimentCharBudget },
      })
      expect(String(badBudget._error)).toMatch(/embodiment_char_budget 必须是正整数/)
    }
  })
})

describe('buildSlopRevisionHint secrecy contract', () => {
  it('never leaks score numbers or the pass line', () => {
    const hint = buildSlopRevisionHint(analyzeSlop(SLOP_HEAVY_DRAFT))
    expect(hint).toBeDefined()
    expect(hint).not.toMatch(/总分|通过线|directness|evidence|rhythm|practicality|concision/)
    expect(hint).toMatch(/修订方向/)
    expect(hint).toMatch(/命中套话表述|结构性问题/)
  })

  it('returns undefined when nothing actionable is hit', () => {
    const hint = buildSlopRevisionHint(analyzeSlop(CLEAN_DRAFT))
    expect(hint).toBeUndefined()
  })

  it('truncates evidence to the caps and reports the residual count', () => {
    const hint = buildSlopRevisionHint(analyzeSlop(SLOP_OVERFLOW_DRAFT))
    expect(hint).toBeDefined()
    expect(hint).toMatch(/另有 \d+ 处同类问题/)
    expect(hint!.match(/·/g)).toHaveLength(9) // 8 条 changes 上限 + 1 条 issue
  })

  it('renders replacement-type hits with an arrow to the suggested text', () => {
    const hint = buildSlopRevisionHint(analyzeSlop(SLOP_REPLACEMENT_DRAFT))
    expect(hint).toBeDefined()
    expect(hint).toMatch(/「深入分析」" → "分析"/)
    expect(hint).toMatch(/「全面论述」" → "论述"/)
    expect(hint).not.toMatch(/建议删除或改写/)
    expect(hint).not.toMatch(/另有 \d+ 处/)
  })

  it('renders an issue without a suggestion as a bare line reference', () => {
    const blankSuggestion: SlopAnalysis = {
      cleaned: '',
      changes: [],
      issues: [{ type: 'empty_three_step', line: 3, text: '区别特征模糊', suggestion: '' }],
      score: { directness: 0, evidence: 0, rhythm: 0, practicality: 0, concision: 0, total: 0, passed: false },
      checklist: [],
    }
    const hint = buildSlopRevisionHint(blankSuggestion)
    expect(hint).toMatch(/L3 行：`区别特征模糊`/)
    expect(hint).not.toMatch(/（\s*）/)
  })
})
