import { describe, expect, it } from 'vitest'
import {
  DisputeFramingHandler,
  DisputeFramingRefineHandler,
  frameDispute,
  refineDispute,
  scanClaimNumbers,
  scanDisputeText,
} from '../src/atoms/handlers/builtin/dispute-framing.ts'

describe('争议粗定位', () => {
  it('从正文识别法条与权项区间', () => {
    const scanned = scanDisputeText('审查员认为权利要求 1-3 不具备创造性，不符合专利法第22条第3款的规定。')
    expect(scanned.statutes).toContain('A22.3')
    expect(scanned.claims).toEqual([1, 2, 3])
  })

  it('识别短式 A22.2 / A26.4 与中文条款号', () => {
    const scanned = scanDisputeText('A22.2 与 A26.4 均被援引；另见专利法第二十六条第三款。')
    expect(scanned.statutes.sort()).toEqual(['A22.2', 'A26.3', 'A26.4'])
  })

  it('权项列表去重、排序并展开区间', () => {
    expect(scanClaimNumbers('权利要求1、3、3-5和2')).toEqual([1, 2, 3, 4, 5])
  })

  it('优先使用 office_action 的结构化驳回类型与涉及权项', () => {
    const framing = frameDispute({
      office_action: JSON.stringify({ rejectionTypes: ['inventiveness', 'claim-clarity'], affectedClaims: [1, 2] }),
      input: '不应优先扫描这段文本 A22.2',
    })
    expect(framing?.source).toBe('office-action')
    expect(framing?.candidates.map(candidate => candidate.statute).sort()).toEqual(['A22.3', 'A26.4'])
    expect(framing?.claims).toEqual([1, 2])
  })

  it('oa-parse 的驳回类型（clarity/support/scope）映射到对应法条', () => {
    const framing = frameDispute({
      office_action: JSON.stringify({
        rejectionTypes: ['clarity', 'support', 'scope', 'disclosure', 'formal'],
        affectedClaims: [1, 2],
      }),
    })
    expect(framing?.candidates.map(candidate => candidate.statute).sort()).toEqual(['A26.3', 'A26.4', 'A33'])
  })

  it('grounds 中的否定表述不计入候选', () => {
    const framing = frameDispute({
      grounds: JSON.stringify([
        { ground: 'inventiveness', article: '专利法第22条第3款', label: '创造性', negated: false },
        { ground: 'novelty', article: '专利法第22条第2款', label: '新颖性', negated: true },
      ]),
      input: '正文',
    })
    expect(framing?.source).toBe('grounds')
    expect(framing?.candidates.map(candidate => candidate.statute)).toEqual(['A22.3'])
  })

  it('中文条号与权项的边界写法不产生伪候选', () => {
    expect(scanDisputeText('专利法第十条').statutes).toEqual([])
    expect(scanDisputeText('专利法第二十条').statutes).toEqual([])
    expect(scanDisputeText('专利法第九十九条').statutes).toEqual([])
    expect(scanDisputeText('A22').statutes).toEqual(['A22'])
    expect(scanDisputeText('专利法第22条第9款').statutes).toEqual([])
    expect(scanDisputeText('专利法第十十条').statutes).toEqual([])
    expect(scanDisputeText('A99.1').statutes).toEqual([])
    expect(scanClaimNumbers('权利要求1-0')).toEqual([])
    expect(scanClaimNumbers('权利要求1-60')).toEqual([])
    expect(scanClaimNumbers('权利要求0')).toEqual([])
    expect(scanClaimNumbers('权利要求1、2')).toEqual([1, 2])
  })

  it('正文没有法条时来源为 none，text/source_text 也可作为材料', () => {
    expect(frameDispute({ input: '没有法条的材料' })).toMatchObject({ source: 'none', candidates: [], claims: [] })
    expect(frameDispute({ text: 'A22.2' })?.candidates.map(candidate => candidate.statute)).toEqual(['A22.2'])
    expect(frameDispute({ source_text: 'A22.2' })?.candidates.map(candidate => candidate.statute)).toEqual(['A22.2'])
  })

  it('结构化来源里的非法元素被跳过，空结构回退正文', () => {
    expect(frameDispute({ office_action: '', input: 'A22.2' })?.source).toBe('text')
    expect(frameDispute({ office_action: '[]', input: 'A22.2' })?.source).toBe('text')
    expect(frameDispute({ office_action: '{', input: 'A22.2' })?.source).toBe('text')
    expect(frameDispute({ office_action: 'null', input: 'A22.2' })?.source).toBe('text')
    const office = frameDispute({
      office_action: JSON.stringify({ rejectionTypes: [1, 'unknown', 'novelty'], affectedClaims: ['1', 2, 0] }),
    })
    expect(office?.candidates.map(candidate => candidate.statute)).toEqual(['A22.2'])
    expect(office?.claims).toEqual([2])
    expect(frameDispute({ office_action: '{}', input: '' })).toBeUndefined()
  })

  it('grounds 里的非对象、否定与未知理由按规则跳过', () => {
    expect(frameDispute({ grounds: '{', input: 'A22.2' })?.source).toBe('text')
    expect(frameDispute({ grounds: '{}', input: '' })).toBeUndefined()
    const framed = frameDispute({
      grounds: JSON.stringify([
        null,
        'x',
        { ground: 'inventiveness', article: '专利法第22条第3款', negated: true },
        { ground: 'unknown', article: '专利法第22条第2款' },
        { article: 'A22.3' },
        { ground: 'unknown' },
      ]),
      input: '',
    })
    expect(framed?.candidates.map(candidate => candidate.statute)).toEqual(['A22.2', 'A22.3'])
    expect(frameDispute({ grounds: JSON.stringify([{ ground: 'unknown', article: '' }]), input: '' })).toBeUndefined()
  })

  it('无结构化产出时扫描正文；无任何材料时返回 undefined', () => {
    expect(frameDispute({ input: '权利要求 1 不具备新颖性，A22.2。' })?.source).toBe('text')
    expect(frameDispute({})).toBeUndefined()
  })

  it('handler 无材料时降级，不猜测争议', async () => {
    const out = await new DisputeFramingHandler().execute({ state: {} })
    expect(String(out['_error'])).toContain('缺少争议定位材料')
  })

  it('handler 输出报告、候选、权项与来源', async () => {
    const out = await new DisputeFramingHandler().execute({
      state: { input: '权利要求 1-2 不具备创造性，专利法第22条第3款。' },
    })
    expect(out['dispute_framing_report']).toContain('A22.3')
    expect(out['dispute_framing_candidates']).toEqual([
      { statute: 'A22.3', label: '专利法第22条第3款（创造性）', source: 'text' },
    ])
    expect(out['dispute_framing_claims']).toEqual([1, 2])
    expect(out['dispute_framing_source']).toBe('text')
  })

  it('handler 对无法条/无权项的正文仍给出可读报告', async () => {
    const empty = await new DisputeFramingHandler().execute({ state: { input: '没有法条的材料' } })
    expect(empty['dispute_framing_report']).toContain('未从当前材料识别到法条或权项')
    const noClaims = await new DisputeFramingHandler().execute({ state: { input: 'A22.2' } })
    expect(noClaims['dispute_framing_report']).toContain('涉及权利要求 未识别')
  })
})

describe('争议定位修正', () => {
  const candidates = [
    { statute: 'A22.3', label: '专利法第22条第3款（创造性）', source: 'text' as const },
    { statute: 'A59', label: '专利法第59条（保护范围）', source: 'text' as const },
  ]

  it('时间基准已锁定时标注 locked，且不改写时间基准', async () => {
    const state = {
      dispute_framing_candidates: candidates,
      reference_date: '2024-01-01',
      time_baseline_report: '现有技术时间基准：2024-01-01',
    }
    const refined = refineDispute(state)
    expect(refined.timeBasis).toBe('locked')
    expect(refined.candidates.find(candidate => candidate.statute === 'A22.3')).toMatchObject({
      timeDependent: true,
      timeBasis: 'locked',
    })
    expect(refined.candidates.find(candidate => candidate.statute === 'A59')).toMatchObject({
      timeDependent: false,
      timeBasis: 'locked',
    })
    const out = await new DisputeFramingRefineHandler().execute({ state })
    expect(out['time_basis_status']).toBe('locked')
    expect(out['dispute_framing_refined']).toContain('2024-01-01')
    // 修正阶段只读时间基准：返回片段不得携带任何时间基准键。
    expect(out).not.toHaveProperty('reference_date')
    expect(out).not.toHaveProperty('time_baseline_report')
  })

  it('时间基准缺失时标为 unverified，保留候选但不改基准', () => {
    const state = { dispute_framing_candidates: candidates }
    const refined = refineDispute(state)
    expect(refined.timeBasis).toBe('unverified')
    expect(refined.candidates.find(candidate => candidate.statute === 'A22.3')?.timeBasis).toBe('unverified')
    expect(state).toEqual({ dispute_framing_candidates: candidates })
  })

  it('时间基准降级文本不当作已锁定', () => {
    expect(refineDispute({
      dispute_framing_candidates: candidates,
      reference_date: '[WORKFLOW_DEGRADED] 缺少申请日',
    }).timeBasis).toBe('unverified')
  })

  it('无候选时输出空集报告，不报错', () => {
    const refined = refineDispute({})
    expect(refined.candidates).toEqual([])
    expect(refined.report).toContain('保持空集')
  })

  it('丢弃非法候选并把未知来源归一为 text/none', () => {
    const refined = refineDispute({
      dispute_framing_candidates: [
        null,
        'x',
        { statute: 1, label: 2, source: 'text' },
        { statute: 'A22.3', label: '', source: 'text' },
        { statute: 'A22.3', label: '专利法第22条第3款（创造性）', source: 'bogus' },
      ],
      dispute_framing_claims: 'not-an-array',
      dispute_framing_source: 'bogus',
    })
    expect(refined.candidates).toEqual([
      expect.objectContaining({ statute: 'A22.3', source: 'text' }),
    ])
    const withClaims = refineDispute({
      dispute_framing_candidates: [{ statute: 'A22.3', label: '专利法第22条第3款（创造性）', source: 'text' }],
      dispute_framing_claims: [2, 1],
    })
    expect(withClaims.candidates).toHaveLength(1)
  })

  it('候选超过上限时截断', () => {
    const many = Array.from({ length: 13 }, (_, index) => ({
      statute: `A${index + 1}`,
      label: `法条 ${index + 1}`,
      source: 'text' as const,
    }))
    expect(refineDispute({ dispute_framing_candidates: many }).candidates).toHaveLength(12)
  })

  it('实用性（A22.4）不依赖现有技术时间基准', () => {
    const refined = refineDispute({
      dispute_framing_candidates: [
        { statute: 'A22.4', label: '专利法第22条第4款（实用性）', source: 'text' },
      ],
    })
    expect(refined.candidates[0]).toMatchObject({ statute: 'A22.4', timeDependent: false, timeBasis: 'locked' })
    expect(refined.timeBasis).toBe('unverified')
  })

  it('修正阶段补读 office_action 的结构化候选，覆盖正文粗定位并合并权项', () => {
    const refined = refineDispute({
      dispute_framing_candidates: candidates,
      dispute_framing_claims: [1],
      dispute_framing_source: 'text',
      office_action: JSON.stringify({ rejectionTypes: ['novelty', 'utility'], affectedClaims: [2, 3] }),
    })
    const statutes = refined.candidates.map(candidate => candidate.statute).sort()
    expect(statutes).toEqual(['A22.2', 'A22.3', 'A22.4', 'A59'])
    // 结构化来源覆盖同一条法条（本条通知未涉及 A22.3，故它保留正文来源）。
    expect(refined.candidates.find(candidate => candidate.statute === 'A22.2')?.source).toBe('office-action')
    expect(refined.candidates.find(candidate => candidate.statute === 'A22.4')?.source).toBe('office-action')
    expect(refined.candidates.find(candidate => candidate.statute === 'A22.3')?.source).toBe('text')
  })

  it('修正阶段补读 grounds 的结构化候选', () => {
    const refined = refineDispute({
      dispute_framing_candidates: candidates,
      grounds: JSON.stringify([
        { ground: 'inventiveness', article: '专利法第22条第3款', negated: false },
        { ground: 'novelty', article: '专利法第22条第2款', negated: true },
      ]),
      input: '权利要求 3 不具备创造性',
    })
    expect(refined.candidates.map(candidate => candidate.statute).sort()).toEqual(['A22.3', 'A59'])
    expect(refined.candidates.find(candidate => candidate.statute === 'A22.3')?.source).toBe('grounds')
  })
})
