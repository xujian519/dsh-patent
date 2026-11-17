import { describe, expect, it } from 'vitest'
import {
  LookupStageHandler,
  compileSignal,
  registerBuiltinAtoms,
  signalMatches,
} from '@deepseek-ai/dsh-patent-core'
import { PFE_CONSISTENCY_VIOLATION_IDS, checkPfeConsistency } from '../src/atoms/handlers/builtin/pfe.ts'
import type { PFETriple } from '../src/atoms/handlers/builtin/extract.ts'
import type { PfeConsistencyViolationId } from '../src/atoms/handlers/builtin/pfe.ts'

registerBuiltinAtoms()

/** 用例覆写：`insight: null` 表示本组未提炼发明认知（exactOptionalPropertyTypes 下不能显式传 undefined）。 */
type TripleOverride = Omit<Partial<PFETriple>, 'insight'> & { insight?: string | null }

/** 默认发明认知（承接完整组的正常取值）。 */
const DEFAULT_INSIGHT = '限位面与配合面同轴，使装配后的径向间隙自行消除'

/** 构造一组结构承接完整的四元组；用 overrides 制造单点缺陷。 */
function triple(overrides: TripleOverride = {}): PFETriple {
  const { insight = DEFAULT_INSIGHT, ...rest } = overrides
  return {
    id: 'T1',
    problem: '如何在部件装配后提供可靠的轴向定位',
    features: ['F1 限位凸台'],
    effects: ['装配后无径向位移'],
    ...(insight === null ? {} : { insight }),
    ...rest,
  }
}

/** 跑一遍检查，只取违规类别（用例断言的是类别，不是文案）。 */
function violationIds(triples: readonly PFETriple[]): PfeConsistencyViolationId[] {
  return checkPfeConsistency(triples).map(v => v.id)
}

/** consistency 阶段声明的回退信号（同一个正则也写在 patent_disclosure_v1 里，由该包交叉校验）。 */
const RETRY_SIGNAL = '不一致|矛盾|缺少|孤立'

/**
 * manifest 中 consistency 阶段的 `whenOutputMatches` 决定回退是否发生，而它匹配的是本原子的
 * 主输出。这里把该契约钉在用例里：违规必须命中信号，合规必须不命中。
 */
const signal = compileSignal(RETRY_SIGNAL)

/** 跑 pfe-consistency handler，返回主输出与报告。 */
async function runConsistency(
  state: Record<string, unknown>,
): Promise<{ summary: string; passed?: boolean; error?: string }> {
  const handler = LookupStageHandler('pfe-consistency')!
  const out = await handler.execute({ state })
  const report = out.pfe_consistency_report
  return {
    summary: typeof out.pfe_consistency_summary === 'string' ? out.pfe_consistency_summary : '',
    ...(typeof report === 'string' ? { passed: (JSON.parse(report) as { passed: boolean }).passed } : {}),
    ...(typeof out._error === 'string' ? { error: out._error } : {}),
  }
}

describe('checkPfeConsistency：结构性判据', () => {
  it('承接完整 → 无违规', () => {
    expect(violationIds([triple()])).toEqual([])
  })

  it('S⊨P：问题没有特征承接 → pfe-problem-without-solution', () => {
    // 关掉发明认知以隔离判据：留着它会同组命中 I⇒S。
    expect(violationIds([triple({ features: [], insight: null })])).toEqual([
      'pfe-problem-without-solution',
    ])
  })

  it('I⇒S：有发明认知但无特征承接 → pfe-insight-without-solution', () => {
    // 制造只有 insight 缺陷的一组：特征为空时问题检查也会触发，故把问题清空以隔离。
    expect(violationIds([triple({ problem: '', features: [] })])).toEqual(['pfe-insight-without-solution'])
  })

  it('无发明认知的改进型发明 → 不报 I⇒S 违规', () => {
    expect(violationIds([triple({ insight: null })])).toEqual([])
    expect(violationIds([triple({ insight: '   ' })])).toEqual([])
  })

  it('空问题 + 空发明认知 + 空特征 → 无违规（无可判定的承接对象）', () => {
    expect(
      violationIds([triple({ problem: '', insight: null, features: [], effects: [] })]),
    ).toEqual([])
  })

  it('R1 成因层：问题表述已绑定解决手段 → insight-encroaches-problem', () => {
    // "通过设置限位凸台防止位移"与 INVENTIVENESS-PROBLEM-SOLUTION-BINDING 命中同一文本。
    expect(violationIds([triple({ problem: '通过设置限位凸台防止位移' })])).toEqual([
      'insight-encroaches-problem',
    ])
  })

  it('R1 成因层：合规的问题表述（不含手段）→ 不报越位', () => {
    expect(violationIds([triple({ problem: '如何在部件装配后提供可靠的轴向定位' })])).toEqual([])
  })

  it('一个四元组可同时命中多类违规，逐条给出', () => {
    // 问题绑定手段 + 无特征承接 + 有发明认知：三类判据各自成立，互不吞并。
    const ids = violationIds([triple({ problem: '通过设置限位凸台防止位移', features: [] })])
    expect(new Set(ids)).toEqual(
      new Set(['pfe-problem-without-solution', 'pfe-insight-without-solution', 'insight-encroaches-problem']),
    )
    expect(ids).toHaveLength(3)
  })

  it('违规类别封闭：每一类都有可判定的触发用例', () => {
    const produced = new Set<PfeConsistencyViolationId>([
      ...violationIds([triple({ features: [], insight: null })]),
      ...violationIds([triple({ problem: '', features: [] })]),
      ...violationIds([triple({ problem: '通过设置限位凸台防止位移' })]),
    ])
    expect([...produced].sort()).toEqual([...PFE_CONSISTENCY_VIOLATION_IDS].sort())
  })

  it('逐条违规都带可定位的 tripleId 与非空 detail', () => {
    const violations = checkPfeConsistency([triple({ id: 'T7', features: [], insight: null })])
    expect(violations[0]!.tripleId).toBe('T7')
    expect(violations[0]!.detail).toContain('T7')
    expect(violations[0]!.detail.trim().length).toBeGreaterThan(0)
  })

  it('多组四元组各自判定，不串号', () => {
    const violations = checkPfeConsistency([
      triple({ id: 'T1' }),
      triple({ id: 'T2', features: [], insight: null }),
    ])
    expect(violations.map(v => v.tripleId)).toEqual(['T2'])
  })
})

describe('PfeConsistencyHandler：回退信号与降级', () => {
  it('违规时主输出命中 manifest 声明的回退信号，报告 passed=false', async () => {
    const result = await runConsistency({ pfe_triples: [triple({ features: [], insight: null })] })
    expect(signalMatches(result.summary, signal)).toBe(true)
    expect(result.passed).toBe(false)
  })

  it('合规时主输出不命中回退信号，报告 passed=true', async () => {
    const result = await runConsistency({ pfe_triples: [triple()] })
    expect(signalMatches(result.summary, signal)).toBe(false)
    expect(result.passed).toBe(true)
  })

  it('四元组为空数组 → 视为通过（上游全空已由 merge 降级标记，不重复判罚）', async () => {
    const result = await runConsistency({ pfe_triples: [] })
    expect(result.passed).toBe(true)
    expect(signalMatches(result.summary, signal)).toBe(false)
  })

  it('缺少 pfe_triples → 降级并点名上游阶段', async () => {
    const result = await runConsistency({})
    expect(result.error).toMatch(/缺少 pfe_triples/)
  })

  it('pfe_triples 不是数组 → 降级并说明期望', async () => {
    const result = await runConsistency({ pfe_triples: 'T1' })
    expect(result.error).toMatch(/不是数组/)
  })

  it('pfe_triples 含非对象条目 → 降级而不是抛 TypeError', async () => {
    const result = await runConsistency({ pfe_triples: [null] })
    expect(result.error).toMatch(/非对象/)
  })

  it('超长问题在报告中截断为可定位片段', async () => {
    const result = await runConsistency({
      pfe_triples: [triple({ problem: `通过设置${'长'.repeat(120)}防止位移` })],
    })
    expect(result.passed).toBe(false)
    expect(result.summary).toContain('…')
  })

  it('空对象四元组按缺失字段补默认值', async () => {
    const result = await runConsistency({ pfe_triples: [{}] })
    expect(result.summary).toContain('1 组')
    expect(result.passed).toBe(true)
  })

  it('容忍可选字段缺失：裸四元组不抛错', async () => {
    const result = await runConsistency({ pfe_triples: [{ id: 'T1', problem: 'P', features: [], effects: [] }] })
    expect(result.passed).toBe(false)
    expect(signalMatches(result.summary, signal)).toBe(true)
  })
})
