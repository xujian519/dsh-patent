import { describe, expect, it } from 'vitest'
import {
  ClaimBreadthHandler,
  EnablementReportHandler,
  type PipelineState,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'
import { LegalGapsHandler, type LegalGapItem } from '../src/atoms/legal-gaps.ts'
import {
  DRAFTING_DEFECT_FIXTURES,
  type DraftingDefectFixture,
} from './fixtures/drafting-defects/index.ts'

/** 构造只返回预设 JSON 的 provider；夹具不调用真实模型。 */
function providerFor(payload: unknown): StageProvider {
  return {
    callLLM: async () => JSON.stringify(payload),
  }
}

/** 一次夹具运行的原子输出与 legal-gaps 汇总。 */
type FixtureRun = {
  /** `legal-gaps` 的完整输出。 */
  gaps: PipelineState
  /** `enablement-report` 的输出；夹具不覆盖时省略。 */
  enablement?: PipelineState
  /** `claim-breadth` 的输出；夹具不覆盖时省略。 */
  breadth?: PipelineState
}

/**
 * 运行一条夹具：先跑对应判定原子，再把输出交给 `legal-gaps`。
 * @param fixture - 种植缺陷夹具。
 * @returns 原子输出与汇总结果。
 */
async function runFixture(fixture: DraftingDefectFixture): Promise<FixtureRun> {
  let state: PipelineState = {
    profile: 'disclosure',
    specification: fixture.specification,
    claims_draft: fixture.claims,
    ...(fixture.tech_domain === undefined ? {} : { tech_domain: fixture.tech_domain }),
  }
  let enablement: PipelineState | undefined
  let breadth: PipelineState | undefined
  if (fixture.enablement !== undefined) {
    enablement = await new EnablementReportHandler().execute({
      state,
      provider: providerFor(fixture.enablement),
    })
    expect(enablement._error, `${fixture.id} 的 enablement-report 应产出判定`).toBeUndefined()
    expect(enablement.enablement_passed, `${fixture.id} 的 enablement_passed`).toBe(
      fixture.expected === 'passed',
    )
    state = { ...state, ...enablement }
  }
  if (fixture.breadth !== undefined) {
    breadth = await new ClaimBreadthHandler().execute({
      state,
      provider: providerFor(fixture.breadth),
    })
    expect(breadth._error, `${fixture.id} 的 claim-breadth 应产出判定`).toBeUndefined()
    expect(breadth.claim_breadth_passed, `${fixture.id} 的 claim_breadth_passed`).toBe(
      fixture.expected === 'passed',
    )
    state = { ...state, ...breadth }
  }
  const gaps = await new LegalGapsHandler().execute({ state })
  return {
    gaps,
    ...(enablement === undefined ? {} : { enablement }),
    ...(breadth === undefined ? {} : { breadth }),
  }
}

describe('26.3/26.4 种植缺陷夹具', () => {
  it('覆盖两条法条、至少 10 条，且包含对照例', () => {
    expect(DRAFTING_DEFECT_FIXTURES.length).toBeGreaterThanOrEqual(10)
    expect(new Set(DRAFTING_DEFECT_FIXTURES.map(fixture => fixture.id)).size).toBe(
      DRAFTING_DEFECT_FIXTURES.length,
    )
    expect(DRAFTING_DEFECT_FIXTURES.some(fixture => fixture.checks.includes('enablement'))).toBe(true)
    expect(
      DRAFTING_DEFECT_FIXTURES.some(fixture => fixture.checks.includes('claim-support-breadth')),
    ).toBe(true)
    expect(DRAFTING_DEFECT_FIXTURES.some(fixture => fixture.expected === 'passed')).toBe(true)
  })

  for (const fixture of DRAFTING_DEFECT_FIXTURES) {
    it(`${fixture.id} ${fixture.title}`, async () => {
      const run = await runFixture(fixture)
      const items = run.gaps['legal_gaps_items'] as LegalGapItem[]
      // A26.3 与 A26.4 都是 warn 级：失败的判定可见，但不阻断交付。
      expect(run.gaps['legal_gaps_passed'], `${fixture.id} 不应阻断交付`).toBe(true)

      for (const check of fixture.checks) {
        const item = items.find(candidate => candidate.id === check)
        expect(item?.status, `${fixture.id} 的 ${check} 状态`).toBe(fixture.expected)
        expect(run.gaps['legal_gaps_unassessed'], `${fixture.id} 的 ${check} 未评估项`).not.toContain(check)
        if (fixture.expected === 'failed') {
          expect(item?.severity, `${fixture.id} 的 ${check} 级别`).toBe('warn')
          const key = check === 'enablement' ? 'enablement_passed' : 'claim_breadth_passed'
          expect(item?.evidence, `${fixture.id} 的 ${check} 证据`).toBe(`state.${key} = false`)
        }
      }

      if (fixture.checks.includes('claim-support-breadth')) {
        const targets = run.gaps['revision_targets'] as Array<{ checkId: string }>
        expect(targets.map(target => target.checkId)).not.toContain('claim-support-breadth')
      }

      if (fixture.anchor_reason !== undefined) {
        const recordSets = [
          run.enablement?.['enablement_records'],
          run.breadth?.['claim_breadth_records'],
        ].filter((records): records is Array<{ anchor_reason: string }> => Array.isArray(records))
        expect(recordSets.length).toBeGreaterThan(0)
        for (const records of recordSets) {
          expect(
            records.every(record => record.anchor_reason === fixture.anchor_reason),
            `${fixture.id} 的锚点判定`,
          ).toBe(true)
        }
      }
    })
  }
})
