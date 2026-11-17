import { describe, expect, it } from 'vitest'
import { contentHash } from '@deepseek-ai/dsh-patent-core'
import { EvidenceCheckHandler, evidenceCheckAtom } from '../src/atoms/handlers/builtin/evidence-check.ts'
import type { EvidenceCheckPending, EvidenceCheckViolation } from '../src/atoms/handlers/builtin/evidence-check.ts'

const handler = new EvidenceCheckHandler()

const priorArt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: 'CN101234567A 阀体伴热夹套结构',
  type: '现有技术',
  sourceUri: 'patent:CN101234567A',
  publicationDate: '2023-01-01',
  submittedAt: '2024-06-01',
  grounds: ['创造性'],
  ...overrides,
})

const stateWith = (list: unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  evidence: list,
  evidence_deadline: '2024-07-01',
  filing_date: '2024-06-01',
  ...overrides,
})

const violations = (out: Record<string, unknown>): EvidenceCheckViolation[] =>
  out.evidence_check_violations as EvidenceCheckViolation[]

const pending = (out: Record<string, unknown>): EvidenceCheckPending[] =>
  out.evidence_check_pending as EvidenceCheckPending[]

const codes = (out: Record<string, unknown>): string[] => violations(out).map(item => item.code)

/** 旧版内建哈希，仅用于构造 legacy 证据。 */
function legacyFnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

describe('evidence-check atom', () => {
  it('声明的输出以报告为主输出，分类为 gate', () => {
    expect(evidenceCheckAtom.name).toBe('evidence-check')
    expect(evidenceCheckAtom.category).toBe('gate')
    expect(evidenceCheckAtom.outputSchema).toEqual([
      'evidence_check_report',
      'evidence_check_passed',
      'evidence_check_violations',
      'evidence_check_pending',
    ])
    expect(evidenceCheckAtom.inputSchema).toContain('evidence')
    expect(evidenceCheckAtom.inputSchema).toContain('evidence_deadline')
  })

  it('未提供证据清单 → 报告未执行并放行', async () => {
    const out = await handler.execute({ state: {} })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toEqual([])
    expect(out.evidence_check_report).toContain('未执行')
    expect(out.evidence_check_report).toContain('未提供证据清单')
  })

  it('证据清单为空 → 通过并说明没有可审查条目', async () => {
    const out = await handler.execute({ state: stateWith([]) })
    expect(out.evidence_check_passed).toBe(true)
    expect(out.evidence_check_report).toContain('证据 0 条')
    expect(violations(out)).toEqual([])
  })

  it('在举证期限内提交、与理由关联的现有技术证据 → 通过', async () => {
    const out = await handler.execute({ state: stateWith([priorArt()]) })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toEqual([])
    expect(pending(out).map(item => item.code)).toEqual([])
    expect(out.evidence_check_report).toContain('通过')
    expect(out.evidence_check_report).toContain('2024-07-01')
  })

  it('逾期提交且无正当理由 → 未通过（G-12 反例）', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ submittedAt: '2024-08-01' })]),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toContain('EVID-TIME-LATE')
    expect(out.evidence_check_report).toContain('未通过')
    expect(out.evidence_check_report).toContain('逾期证据可能不被采纳')
  })

  it('逾期但说明正当理由 → 提示而非阻断', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ submittedAt: '2024-08-01', lateJustification: '补充检索到该证据' })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toMatchObject([
      { code: 'EVID-TIME-LATE-JUSTIFIED', severity: 'warn' },
    ])
    expect(out.evidence_check_report).toContain('补充检索到该证据')
  })

  it('缺少举证期限 → 期限检查列入清单级待核', async () => {
    const out = await handler.execute({ state: stateWith([priorArt()], { evidence_deadline: '' }) })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out).map(item => item.code)).toContain('EVID-TIME-DEADLINE')
    expect(out.evidence_check_report).toContain('期限检查未评估')
  })

  it('有举证期限但缺少提交日 → 单条待核', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ submittedAt: undefined })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out)).toMatchObject([{ code: 'EVID-TIME-SUBMITTED', label: '证据1' }])
  })

  it('外文证据未附中文译本 → 阻断', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: 'US1234567A', type: '外文证据', translated: false, submittedAt: '2024-06-01', grounds: ['新颖性'] },
      ]),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toContain('EVID-FORM-TRANSLATION')
  })

  it('外文证据未说明是否翻译 → 待核而非阻断', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: 'US1234567A', type: 'foreign_language', submittedAt: '2024-06-01', grounds: ['新颖性'] },
      ]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out).map(item => item.code)).toContain('EVID-FORM-TRANSLATION')
  })

  it('域外证据未公证认证 → 提示；声明免除 → 不再提示', async () => {
    const out = await handler.execute({
      state: stateWith([
        {
          title: '域外销售合同',
          type: '域外证据',
          notarized: false,
          legalized: false,
          submittedAt: '2024-06-01',
          grounds: ['公开使用'],
        },
      ]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(codes(out)).toEqual(['EVID-FORM-NOTARIZATION', 'EVID-FORM-LEGALIZATION'])

    const exempt = await handler.execute({
      state: stateWith([
        {
          title: '域外公开发行物',
          type: '域外证据',
          notarizedExempt: true,
          legalizedExempt: true,
          submittedAt: '2024-06-01',
          grounds: ['新颖性'],
        },
      ]),
    })
    expect(violations(exempt)).toEqual([])
    expect(pending(exempt)).toEqual([])
  })

  it('复合证据同时检查外文译本与域外公证认证', async () => {
    const out = await handler.execute({
      state: stateWith([
        {
          title: 'US1234567A',
          type: '现有技术 外文证据 域外证据',
          translated: false,
          notarized: false,
          legalized: false,
          publicationDate: '2023-01-01',
          submittedAt: '2024-06-01',
          grounds: ['新颖性'],
        },
      ]),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toEqual(
      expect.arrayContaining([
        'EVID-FORM-TRANSLATION',
        'EVID-FORM-NOTARIZATION',
        'EVID-FORM-LEGALIZATION',
      ]),
    )
    expect(out.evidence_check_report).toContain('[现有技术/外文证据/域外证据]')
  })

  it('电子数据：形式要件列入待核，不静默通过', async () => {
    const out = await handler.execute({
      state: stateWith([
        {
          title: '电子邮件记录',
          type: '电子数据',
          submittedAt: '2024-06-01',
          grounds: ['公开使用'],
        },
      ]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out).map(item => item.code)).toContain('EVID-FORM-ELECTRONIC')
    expect(out.evidence_check_report).toContain('[电子数据]')
  })

  it('证人证言未载明证人身份 → 阻断', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: '证人证言', type: '证人证言', submittedAt: '2024-06-01', grounds: ['公开使用'] },
      ]),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toContain('EVID-FORM-WITNESS')
  })

  it('证人未披露利害关系 → 提示', async () => {
    const out = await handler.execute({
      state: stateWith([
        {
          title: '证人王某证言',
          type: '证人证言',
          witness: '王某',
          witnessDisclosed: false,
          submittedAt: '2024-06-01',
          grounds: ['公开使用'],
        },
      ]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(codes(out)).toContain('EVID-FORM-WITNESS-INTEREST')
  })

  it('现有技术公开日早于截止日 → 通过', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-05-31' })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('现有技术公开日等于截止日 → 阻断（A22.5 申请日以前）', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-06-01' })]),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toContain('EVID-TIME-NOT-PRIOR-ART')
  })

  it('月级公开日按月末推定后再比较', async () => {
    const before = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-05' })]),
    })
    expect(before.evidence_check_passed).toBe(true)
    const after = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-06' })]),
    })
    expect(after.evidence_check_passed).toBe(false)
    expect(codes(after)).toContain('EVID-TIME-NOT-PRIOR-ART')
  })

  it('月级公开日的月末晚于月中截止日 → 不构成现有技术', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-06' })], { reference_date: '2024-06-15' }),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toContain('EVID-TIME-NOT-PRIOR-ART')
    expect(String(out.evidence_check_report)).toContain('公开日 2024-06-30 不早于现有技术截止日 2024-06-15')
  })

  it('A24 宽限期标注只提示，不在本原子判断是否适用', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-06-01', a24Exception: 'A24.2' })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toMatchObject([{ code: 'EVID-TIME-A24', severity: 'warn' }])
  })

  it('现有技术缺少公开日 → 待核', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ publicationDate: undefined })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out).map(item => item.code)).toContain('EVID-TIME-PUBLICATION-DATE')
  })

  it('缺少申请日/优先权日 → 公开日检查待核', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt()], { filing_date: '', priority_date: '' }),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out).map(item => item.code)).toContain('EVID-TIME-REFERENCE')
  })

  it('证据未关联理由或权项 → 提示关联性无法确认', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ grounds: undefined })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(codes(out)).toContain('EVID-RELEVANCE-UNLINKED')
  })

  it('SHA-256 内容哈希与原文摘录一致 → 通过；篡改 → 阻断', async () => {
    const snippet = '证据原文摘录'
    const match = await handler.execute({
      state: stateWith([priorArt({ contentHash: contentHash(snippet), snippet })]),
    })
    expect(match.evidence_check_passed).toBe(true)
    expect(violations(match)).toEqual([])
    expect(pending(match)).toEqual([])

    const mismatch = await handler.execute({
      state: stateWith([priorArt({ contentHash: contentHash(snippet), snippet: `${snippet}（篡改）` })]),
    })
    expect(mismatch.evidence_check_passed).toBe(false)
    expect(codes(mismatch)).toContain('EVID-FORM-INTEGRITY')
    expect(violations(mismatch)[0]?.message).toMatch(/SHA-256/)
  })

  it('sha256: 前缀缺失或摘要不合法 → 待核，不自动按内建哈希校验', async () => {
    const bare = await handler.execute({
      state: stateWith([priorArt({ contentHash: 'a'.repeat(64), snippet: '证据原文摘录' })]),
    })
    expect(bare.evidence_check_passed).toBe(true)
    expect(pending(bare).map(item => item.code)).toContain('EVID-FORM-INTEGRITY')
    expect(pending(bare)[0]?.message).toMatch(/sha256:/)

    const malformed = await handler.execute({
      state: stateWith([priorArt({ contentHash: 'sha256:abc', snippet: '证据原文摘录' })]),
    })
    expect(malformed.evidence_check_passed).toBe(true)
    expect(pending(malformed)[0]?.message).toMatch(/64 位/)
  })

  it('缺少原文摘录 → 待核，不误判完整性', async () => {
    const noSnippet = await handler.execute({
      state: stateWith([priorArt({ contentHash: contentHash('证据原文摘录') })]),
    })
    expect(noSnippet.evidence_check_passed).toBe(true)
    expect(pending(noSnippet).map(item => item.code)).toContain('EVID-FORM-INTEGRITY')
  })

  it('旧版 FNV 哈希匹配 → 通过但标记 legacy-hash；不匹配 → 待核而非阻断', async () => {
    const snippet = '证据原文摘录'
    const legacy = await handler.execute({
      state: stateWith([priorArt({ contentHash: legacyFnv1a(snippet), snippet })]),
    })
    expect(legacy.evidence_check_passed).toBe(true)
    expect(violations(legacy)).toEqual([])
    expect(pending(legacy).map(item => item.code)).toContain('EVID-FORM-INTEGRITY-LEGACY')
    expect(pending(legacy)[0]?.message).toMatch(/legacy-hash/)
    expect(pending(legacy)[0]?.message).toContain(contentHash(snippet))

    const unmatched = await handler.execute({
      state: stateWith([priorArt({ contentHash: 'deadbeef', snippet })]),
    })
    expect(unmatched.evidence_check_passed).toBe(true)
    expect(codes(unmatched)).toEqual([])
    expect(pending(unmatched).map(item => item.code)).toContain('EVID-FORM-INTEGRITY')
    expect(pending(unmatched)[0]?.message).toMatch(/无法确认为内建 FNV/)
  })

  it('旧版短哈希缺少摘录 → 待核', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ contentHash: 'deadbeef' })]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(pending(out)[0]?.message).toMatch(/缺少原文摘录/)
  })

  it('无法识别名称或来源的证据 → 阻断', async () => {
    const out = await handler.execute({
      state: stateWith([{ type: '一般证据', submittedAt: '2024-06-01', grounds: ['其他'] }]),
    })
    expect(out.evidence_check_passed).toBe(false)
    expect(codes(out)).toEqual(['EVID-FORM-IDENTITY'])
  })

  it('params 可指定证据、期限与时间基准的状态键', async () => {
    const out = await handler.execute({
      state: {
        my_evidence: [priorArt({ submittedAt: '2024-06-01' })],
        my_deadline: '2024-07-01',
        my_reference: '2024-06-01',
        evidence_key: 'my_evidence',
        deadline_key: 'my_deadline',
        reference_date_key: 'my_reference',
        filing_date_key: 'unused_filing',
        priority_date_key: 'unused_priority',
      },
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toEqual([])
    expect(out.evidence_check_report).toContain('2024-07-01')
  })

  it('证据清单不是数组 → 降级', async () => {
    const out = await handler.execute({ state: { evidence: { title: 'not an array' } } })
    expect(String(out._error)).toContain('[evidence-check]')
    expect(String(out._error)).toContain('不是数组')
  })

  it('条目不是对象 → 降级', async () => {
    const out = await handler.execute({ state: stateWith([null]) })
    expect(String(out._error)).toContain('证据1 条目不是对象')
  })

  it('提交日或公开日不可解析 → 降级，不静默跳过', async () => {
    const submitted = await handler.execute({
      state: stateWith([priorArt({ submittedAt: '2024-13-01' })]),
    })
    expect(String(submitted._error)).toContain('submittedAt')
    const published = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-13-01' })]),
    })
    expect(String(published._error)).toContain('publicationDate')
  })

  it('举证期限或现有技术截止日不可解析 → 降级', async () => {
    const deadline = await handler.execute({ state: stateWith([], { evidence_deadline: '2024-13-01' }) })
    expect(String(deadline._error)).toContain('举证期限')
    const reference = await handler.execute({
      state: stateWith([], { reference_date: '2024-13-01' }),
    })
    expect(String(reference._error)).toContain('现有技术截止日')
  })

  it('状态键参数非法 → 降级', async () => {
    const out = await handler.execute({ state: { evidence_key: 123 } })
    expect(String(out._error)).toContain('evidence_key')
  })

  it('未标注证据类型 → 不命中任何形式检查', async () => {
    const out = await handler.execute({
      state: stateWith([{ title: '未分类证据', submittedAt: '2024-06-01', grounds: ['其他'] }]),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('外文证据已附译本 → 不产生违规或待核', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: 'US1234567A', type: '外文证据', translated: true, submittedAt: '2024-06-01', grounds: ['新颖性'] },
      ]),
    })
    expect(violations(out)).toEqual([])
    expect(pending(out)).toEqual([])
  })

  it('外文证据提供译本正文但未声明布尔值 → 视为已说明', async () => {
    const out = await handler.execute({
      state: stateWith([
        {
          title: 'US1234567A',
          type: '外文证据',
          translation: '中文译文全文',
          submittedAt: '2024-06-01',
          grounds: ['新颖性'],
        },
      ]),
    })
    expect(violations(out)).toEqual([])
    expect(pending(out)).toEqual([])
  })

  it('布尔字段为 null 按缺失处理', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: 'US1234567A', type: '外文证据', translated: null, submittedAt: '2024-06-01', grounds: ['新颖性'] },
      ]),
    })
    expect(pending(out).map(item => item.code)).toContain('EVID-FORM-TRANSLATION')
  })

  it('域外证据未说明公证与认证 → 两项待核', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: '域外合同', type: '域外证据', submittedAt: '2024-06-01', grounds: ['公开使用'] },
      ]),
    })
    expect(pending(out).map(item => item.code)).toEqual(
      expect.arrayContaining(['EVID-FORM-NOTARIZATION', 'EVID-FORM-LEGALIZATION']),
    )
  })

  it('布尔字段类型错误 → 降级并指出字段', async () => {
    const notarized = await handler.execute({
      state: stateWith([
        { title: '域外合同', type: '域外证据', notarized: 'yes', submittedAt: '2024-06-01', grounds: ['公开使用'] },
      ]),
    })
    expect(String(notarized._error)).toContain('notarized 必须是布尔值')
    const legalized = await handler.execute({
      state: stateWith([
        { title: '域外合同', type: '域外证据', legalized: 1, submittedAt: '2024-06-01', grounds: ['公开使用'] },
      ]),
    })
    expect(String(legalized._error)).toContain('legalized 必须是布尔值')
    const witness = await handler.execute({
      state: stateWith([
        { title: '证人证言', type: '证人证言', witness: '王某', witnessDisclosed: 'no', submittedAt: '2024-06-01', grounds: ['公开使用'] },
      ]),
    })
    expect(String(witness._error)).toContain('witnessDisclosed 必须是布尔值')
  })

  it('关联理由或权项接受字符串数组并丢弃无效项', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ grounds: [1, '新颖性'], claims: [null, 'claim_1'] })]),
    })
    expect(codes(out)).not.toContain('EVID-RELEVANCE-UNLINKED')
  })

  it('举证期限为 null、空白或月级 → 缺失或降级', async () => {
    const missing = await handler.execute({ state: stateWith([], { evidence_deadline: null }) })
    expect(pending(missing).map(item => item.code)).toContain('EVID-TIME-DEADLINE')
    const blank = await handler.execute({ state: stateWith([], { evidence_deadline: '   ' }) })
    expect(pending(blank).map(item => item.code)).toContain('EVID-TIME-DEADLINE')
    const month = await handler.execute({ state: stateWith([], { evidence_deadline: '2024-06' }) })
    expect(String(month._error)).toContain('仅精确到月')
  })

  it('申请日或优先权日仅到月 → 降级', async () => {
    const filing = await handler.execute({
      state: stateWith([], { reference_date: undefined, filing_date: '2024-06' }),
    })
    expect(String(filing._error)).toContain('无法解析为具体日期')
    const priority = await handler.execute({
      state: stateWith([], { reference_date: undefined, filing_date: undefined, priority_date: '2024-06' }),
    })
    expect(String(priority._error)).toContain('无法解析为具体日期')
  })

  it('外文证据译本声明类型错误 → 降级', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: 'US1234567A', type: '外文证据', translated: 'yes', submittedAt: '2024-06-01', grounds: ['新颖性'] },
      ]),
    })
    expect(String(out._error)).toContain('translated 必须是布尔值')
  })

  it('域外证据已公证认证 → 不产生待核', async () => {
    const out = await handler.execute({
      state: stateWith([
        { title: '域外合同', type: '域外证据', notarized: true, legalized: true, submittedAt: '2024-06-01', grounds: ['公开使用'] },
      ]),
    })
    expect(pending(out)).toEqual([])
    expect(violations(out)).toEqual([])
  })

  it('关联理由与权项接受单个字符串，空字符串被忽略', async () => {
    const scalar = await handler.execute({
      state: stateWith([priorArt({ grounds: '新颖性', claims: 'claim_1' })]),
    })
    expect(codes(scalar)).not.toContain('EVID-RELEVANCE-UNLINKED')
    const blank = await handler.execute({
      state: stateWith([priorArt({ grounds: '', claims: [] })]),
    })
    expect(codes(blank)).toContain('EVID-RELEVANCE-UNLINKED')
  })

  it('举证期限类型错误 → 降级', async () => {
    const out = await handler.execute({ state: stateWith([], { evidence_deadline: 20240701 }) })
    expect(String(out._error)).toContain('必须是字符串')
  })

  it('提交日仅到月 → 降级', async () => {
    const out = await handler.execute({ state: stateWith([priorArt({ submittedAt: '2024-06' })]) })
    expect(String(out._error)).toContain('仅精确到月')
  })

  it('截止日类型错误、月级或不可解析 → 降级', async () => {
    const wrongType = await handler.execute({ state: stateWith([], { reference_date: 20240601 }) })
    expect(String(wrongType._error)).toContain('reference_date 必须是字符串')
    const month = await handler.execute({ state: stateWith([], { reference_date: '2024-06' }) })
    expect(String(month._error)).toContain('仅精确到月')
  })

  it('申请日或优先权日类型错误 → 降级', async () => {
    const filing = await handler.execute({
      state: stateWith([], { reference_date: undefined, filing_date: 20240601 }),
    })
    expect(String(filing._error)).toContain('filing_date 必须是字符串')
    const priority = await handler.execute({
      state: stateWith([], { reference_date: undefined, filing_date: undefined, priority_date: 20240601 }),
    })
    expect(String(priority._error)).toContain('priority_date 必须是字符串')
  })

  it('只提供优先权日时取优先权日作为截止日', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt({ publicationDate: '2024-04-01' })], {
        reference_date: undefined,
        filing_date: undefined,
        priority_date: '2024-05-01',
      }),
    })
    expect(out.evidence_check_passed).toBe(true)
    expect(out.evidence_check_report).toContain('优先权日')
  })

  it('申请日与优先权日为空白字符串 → 视为缺失', async () => {
    const out = await handler.execute({
      state: stateWith([priorArt()], { reference_date: undefined, filing_date: '  ', priority_date: ' ' }),
    })
    expect(pending(out).map(item => item.code)).toContain('EVID-TIME-REFERENCE')
  })

  it('各状态键参数非法 → 分别降级', async () => {
    const cases = ['deadline_key', 'reference_date_key', 'filing_date_key', 'priority_date_key'] as const
    for (const key of cases) {
      const out = await handler.execute({ state: { evidence: [], [key]: 123 } })
      expect(String(out._error)).toContain(key)
    }
  })

  it('报告固定写明实质判断仍需人工复核', async () => {
    const out = await handler.execute({ state: stateWith([priorArt()]) })
    expect(out.evidence_check_report).toContain('证据真实性、证明力以及公开内容的实质比对仍需人工复核')
  })
})
