import { describe, expect, it } from 'vitest'
import {
  FlexiblePlanError,
  abandon,
  addStage,
  attachArticleJudgment,
  complete,
  confirmStage,
  createFlexiblePlan,
  fromJSON,
  removeStage,
  reorderStages,
  rollbackStage,
  toCompiledGraph,
  toJSON,
  toManifest,
  type FlexibleStage,
} from '@deepseek-ai/dsh-patent-workflow'
import { FactBlackboard, globalAtomRegistry, globalStageHandlerRegistry, registerBuiltinAtoms } from '@deepseek-ai/dsh-patent-core'

/** 构造最小合法阶段（减少样板）。 */
function stage(id: string, overrides: Partial<FlexibleStage> = {}): FlexibleStage {
  return {
    id,
    name: id,
    goal: '目标 ' + id,
    strategy: 'chain',
    status: 'pending',
    artifacts: [],
    constraintIds: [],
    articleJudgments: [],
    ...overrides,
  }
}

function judgment(articleId = 'A22.2') {
  return {
    articleId,
    satisfied: true,
    reasoning: '对比文件未公开区别特征，具备新颖性',
    confidence: 0.9,
    judgedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('createFlexiblePlan', () => {
  it('creates an empty plan', () => {
    const plan = createFlexiblePlan('case-1', 'invalidation')
    expect(plan.caseId).toBe('case-1')
    expect(plan.caseType).toBe('invalidation')
    expect(plan.status).toBe('active')
    expect(plan.stages).toEqual([])
    expect(plan.currentStageId).toBeUndefined()
  })

  it('with initial stages currentStageId points to the first and all are pending', () => {
    const plan = createFlexiblePlan('case-1', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    expect(plan.currentStageId).toBe('s1')
    expect(plan.stages).toHaveLength(2)
    expect(plan.stages.every(s => s.status === 'pending')).toBe(true)
  })

  it('empty caseId/caseType throws', () => {
    expect(() => createFlexiblePlan('', 'invalidation')).toThrow(FlexiblePlanError)
    expect(() => createFlexiblePlan('case-1', '')).toThrow(FlexiblePlanError)
  })

  it('path-traversal caseId throws (fail-closed)', () => {
    expect(() => createFlexiblePlan('../evil', 'invalidation')).toThrow(FlexiblePlanError)
    expect(() => createFlexiblePlan('.hidden', 'invalidation')).toThrow(FlexiblePlanError)
    expect(() => createFlexiblePlan('case/1', 'invalidation')).toThrow(FlexiblePlanError)
    expect(() => createFlexiblePlan('case 1', 'invalidation')).toThrow(FlexiblePlanError)
    expect(() => createFlexiblePlan('case-1.v2_ok', 'invalidation')).not.toThrow()
  })

  it('duplicate or empty stage id throws', () => {
    expect(() => createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s1')] })).toThrow(FlexiblePlanError)
    expect(() => createFlexiblePlan('c', 'invalidation', { stages: [{ ...stage('s1'), id: ' ' }] })).toThrow(FlexiblePlanError)
  })
})

describe('addStage / removeStage / reorderStages', () => {
  it('addStage appends and only sets currentStageId when absent', () => {
    const plan = createFlexiblePlan('c', 'invalidation')
    const next = addStage(plan, stage('s1'))
    expect(next.stages).toHaveLength(1)
    expect(next.currentStageId).toBe('s1')
    const next2 = addStage(next, stage('s2'))
    expect(next2.stages).toHaveLength(2)
    expect(next2.currentStageId).toBe('s1')
    expect(next2.stages[1]!.status).toBe('pending')
  })

  it('addStage duplicate / empty id / non-active throws', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    expect(() => addStage(plan, stage('s1'))).toThrow(FlexiblePlanError)
    expect(() => addStage(plan, { ...stage('s2'), id: ' ' })).toThrow(FlexiblePlanError)
    const done = complete(plan)
    expect(() => addStage(done, stage('s2'))).toThrow(FlexiblePlanError)
  })

  it('removeStage deletes and currentStageId falls back to the next pending stage', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const next = removeStage(plan, 's1')
    expect(next.stages).toHaveLength(1)
    expect(next.stages[0]!.id).toBe('s2')
    expect(next.currentStageId).toBe('s2')
  })

  it('removeStage unknown stage / non-active throws', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    expect(() => removeStage(plan, 'nope')).toThrow(FlexiblePlanError)
    const done = complete(plan)
    expect(() => removeStage(done, 's1')).toThrow(FlexiblePlanError)
  })

  it('removeStage of a non-current stage keeps the currentStageId', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const next = removeStage(plan, 's2')
    expect(next.stages.map(s => s.id)).toEqual(['s1'])
    expect(next.currentStageId).toBe('s1')
  })

  it('reorderStages reorders stages', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const next = reorderStages(plan, ['s3', 's1', 's2'])
    expect(next.stages.map(s => s.id)).toEqual(['s3', 's1', 's2'])
  })

  it('reorderStages illegal order throws (missing / duplicate / unknown)', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    expect(() => reorderStages(plan, ['s1'])).toThrow(FlexiblePlanError)
    expect(() => reorderStages(plan, ['s1', 's1'])).toThrow(FlexiblePlanError)
    expect(() => reorderStages(plan, ['s1', 'nope'])).toThrow(FlexiblePlanError)
  })

  it('reorderStages on an empty plan falls back to firstUnconfirmed (undefined)', () => {
    const plan = createFlexiblePlan('c', 'invalidation')
    const next = reorderStages(plan, [])
    expect(next.stages).toEqual([])
    expect(next.currentStageId).toBeUndefined()
  })
})

describe('confirmStage / rollbackStage', () => {
  it('confirmStage advances to the next unconfirmed stage', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const s1 = confirmStage(plan, 's1')
    expect(s1.stages[0]!.status).toBe('confirmed')
    expect(s1.currentStageId).toBe('s2')
    const s2 = confirmStage(s1, 's2')
    expect(s2.stages[1]!.status).toBe('confirmed')
    expect(s2.currentStageId).toBe('s3')
  })

  it('confirmStage clears currentStageId after all confirmed', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const all = confirmStage(confirmStage(plan, 's1'), 's2')
    expect(all.currentStageId).toBeUndefined()
    expect(all.stages.every(s => s.status === 'confirmed')).toBe(true)
  })

  it('confirmStage out-of-order falls back to the earlier pending stage', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const premature = confirmStage(plan, 's3')
    expect(premature.stages[2]!.status).toBe('confirmed')
    expect(premature.currentStageId).toBe('s1')
  })

  it('confirmStage unknown stage / non-active throws', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    expect(() => confirmStage(plan, 'nope')).toThrow(FlexiblePlanError)
    const done = complete(plan)
    expect(() => confirmStage(done, 's1')).toThrow(FlexiblePlanError)
  })

  it('rollbackStage rolls back the target and later confirmed stages, keeping earlier ones', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const confirmed = confirmStage(confirmStage(confirmStage(plan, 's1'), 's2'), 's3')
    expect(confirmed.stages.every(s => s.status === 'confirmed')).toBe(true)

    const rolled = rollbackStage(confirmed, 's2')
    expect(rolled.stages[0]!.status).toBe('confirmed')
    expect(rolled.stages[1]!.status).toBe('rolled_back')
    expect(rolled.stages[2]!.status).toBe('rolled_back')
    expect(rolled.currentStageId).toBe('s2')
  })

  it('rollbackStage to a pending stage rolls back later confirmed and keeps pending', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const confirmed = confirmStage(plan, 's1')
    const premature = confirmStage(confirmed, 's3')
    expect(premature.stages[1]!.status).toBe('pending')

    const rolled = rollbackStage(premature, 's2')
    expect(rolled.stages[0]!.status).toBe('confirmed')
    expect(rolled.stages[1]!.status).toBe('pending')
    expect(rolled.stages[2]!.status).toBe('rolled_back')
    expect(rolled.currentStageId).toBe('s2')
  })

  it('rollbackStage unknown stage / non-active throws', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    expect(() => rollbackStage(plan, 'nope')).toThrow(FlexiblePlanError)
    const done = complete(plan)
    expect(() => rollbackStage(done, 's1')).toThrow(FlexiblePlanError)
  })

  it('rollbackStage records a bounded revision with the gap and rationale', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const confirmed = confirmStage(confirmStage(plan, 's1'), 's2')
    const rolled = rollbackStage(confirmed, 's2', {
      gapId: 'claim-1-unevaluated',
      rationale: '权利要求 1 的对应事实未提取',
      evidence: 'state.legal_gaps',
      before: 'old-output-digest',
    })
    expect(rolled.revisions).toHaveLength(1)
    const record = rolled.revisions![0]!
    expect(record).toMatchObject({
      gapId: 'claim-1-unevaluated',
      rewindTo: 's2',
      requestedBy: 's2',
      round: 1,
      rationale: '权利要求 1 的对应事实未提取',
      evidence: 'state.legal_gaps',
      outcome: 'applied',
    })
    expect(record.before).toBe('old-output-digest')
    // 未注入时钟时不写 at：持久化结果可重放且逐字一致。
    expect(record.at).toBeUndefined()
    // 再次回退同一阶段：round 递增，记录继续累积。
    const again = rollbackStage(rolled, 's2', { gapId: 'claim-2-unevaluated', now: () => '2026-10-22T00:00:00.000Z' })
    expect(again.revisions?.map(r => r.round)).toEqual([1, 2])
    expect(again.revisions?.[1]?.at).toBe('2026-10-22T00:00:00.000Z')
  })

  it('rollbackStage derives the default before digest and records an explicit after', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const confirmed = confirmStage(confirmStage(plan, 's1'), 's2')
    const rolled = rollbackStage(confirmed, 's2', { after: 'new-output-digest' })
    const record = rolled.revisions![0]!
    expect(record.before).toMatch(/^[0-9a-f]{16}$/)
    expect(record.after).toBe('new-output-digest')
  })

  it('rollback redo loop: redoing the target advances to the next redo stage', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const confirmed = confirmStage(confirmStage(confirmStage(plan, 's1'), 's2'), 's3')
    const rolled = rollbackStage(confirmed, 's2')
    expect(rolled.currentStageId).toBe('s2')
    expect(rolled.stages[1]!.status).toBe('rolled_back')
    expect(rolled.stages[2]!.status).toBe('rolled_back')

    const redone = confirmStage(rolled, 's2')
    expect(redone.currentStageId).toBe('s3')
    expect(redone.stages[2]!.status).toBe('rolled_back')
    const allDone = confirmStage(redone, 's3')
    expect(allDone.currentStageId).toBeUndefined()
    expect(allDone.stages.every(s => s.status === 'confirmed')).toBe(true)
  })
})

describe('attachArticleJudgment', () => {
  it('writes to the blackboard and records the stage reference', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    const bb = new FactBlackboard({ caseId: 'c', caseType: 'invalidation' })
    const next = attachArticleJudgment(plan, 's1', judgment(), bb)
    expect(next.stages[0]!.articleJudgments).toEqual(['A22.2'])
    expect(bb.getArticleJudgment('A22.2')?.articleId).toBe('A22.2')
    expect(bb.getArticleJudgment('A22.2')?.satisfied).toBe(true)
  })

  it('dedupes repeated references; locked blackboard and unknown stage throw', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    const bb = new FactBlackboard({ caseId: 'c', caseType: 'invalidation' })
    const once = attachArticleJudgment(plan, 's1', judgment(), bb)
    const twice = attachArticleJudgment(once, 's1', judgment(), bb)
    expect(twice.stages[0]!.articleJudgments).toEqual(['A22.2'])

    const lockedBb = new FactBlackboard({ caseId: 'c', caseType: 'invalidation' })
    lockedBb.lock()
    expect(() => attachArticleJudgment(plan, 's1', judgment(), lockedBb)).toThrow(/locked/i)
    expect(() => attachArticleJudgment(plan, 'nope', judgment(), bb)).toThrow(FlexiblePlanError)
  })

  it('a multi-stage plan leaves untouched stages as-is (i !== idx return)', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const bb = new FactBlackboard({ caseId: 'c', caseType: 'invalidation' })
    const next = attachArticleJudgment(plan, 's2', judgment('A22.3'), bb)
    expect(next.stages[0]!.articleJudgments).toEqual([])
    expect(next.stages[1]!.articleJudgments).toEqual(['A22.3'])
  })

  it('a blackboard sharing the caseId but not the caseType is rejected', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    const mismatchedBb = new FactBlackboard({ caseId: 'c', caseType: 'infringement' })
    expect(() => attachArticleJudgment(plan, 's1', judgment(), mismatchedBb)).toThrow(FlexiblePlanError)
  })

  it('a vanished target stage between lookup and access fails closed', () => {
    // findStageIndex 找到 s1 之后、按索引取阶段之前，阶段槽位消失（内部状态被破坏）。
    // Proxy 模拟：第一次索引读取返回阶段，第二次返回 undefined。
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    const bb = new FactBlackboard({ caseId: 'c', caseType: 'invalidation' })
    let reads = 0
    const vanishing = new Proxy([stage('s1')], {
      get(target, prop, receiver) {
        if (prop === '0') {
          reads += 1
          return reads === 1 ? target[0] : undefined
        }
        return Reflect.get(target, prop, receiver) as unknown
      },
    })
    const weird = { ...plan, stages: vanishing }
    expect(() => attachArticleJudgment(weird, 's1', judgment(), bb)).toThrow(FlexiblePlanError)
  })

  it('throws when the blackboard belongs to another case', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    const foreignBb = new FactBlackboard({ caseId: 'other-case', caseType: 'infringement' })
    expect(() => attachArticleJudgment(plan, 's1', judgment(), foreignBb)).toThrow(FlexiblePlanError)
    expect(foreignBb.getArticleJudgment('A22.2')).toBeUndefined()
  })

  it('rejects a new judgment on a rolled_back stage', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const bb = new FactBlackboard({ caseId: 'c', caseType: 'invalidation' })
    const confirmed = confirmStage(plan, 's1')
    const rolled = rollbackStage(confirmed, 's1')
    expect(() => attachArticleJudgment(rolled, 's1', judgment(), bb)).toThrow(FlexiblePlanError)
    expect(bb.getArticleJudgment('A22.2')).toBeUndefined()
  })
})

describe('toManifest', () => {
  it('emits all unfinished stages: confirmed skipped, rolled_back re-run', () => {
    const plan = createFlexiblePlan('c', 'invalidation', {
      stages: [stage('s1', { atom: 'extract', params: { output_key: 'x' } }), stage('s2'), stage('s3')],
    })
    const confirmed = confirmStage(plan, 's1')
    const rolled = rollbackStage(confirmed, 's1')
    const manifest = toManifest(rolled)
    expect(manifest.id).toBe('flexible_c')
    expect(manifest.caseType).toBe('invalidation')
    expect(manifest.stages.map(s => s.id)).toEqual(['s1', 's2', 's3'])
    expect(manifest.stages[0]!.description).toBe('目标 s1')
  })

  it('throws when all stages are confirmed', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const all = confirmStage(confirmStage(plan, 's1'), 's2')
    expect(() => toManifest(all)).toThrow(FlexiblePlanError)
  })

  it('completed/abandoned plans throw (assertActive)', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    expect(() => toManifest(complete(plan))).toThrow(FlexiblePlanError)
    expect(() => toManifest(abandon(plan, '用户取消'))).toThrow(FlexiblePlanError)
  })

  it('passes through strategy/atom/params', () => {
    const plan = createFlexiblePlan('c', 'invalidation', {
      stages: [{ ...stage('s1'), strategy: 'sub_agent', atom: 'reasoning', params: { mode: 'novelty' } }],
    })
    const manifest = toManifest(plan)
    expect(manifest.stages[0]!.strategy).toBe('sub_agent')
    expect(manifest.stages[0]!.atom).toBe('reasoning')
    expect(manifest.stages[0]!.params).toEqual({ mode: 'novelty' })
  })
})

describe('toJSON / fromJSON', () => {
  it('roundtrips state', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const confirmed = confirmStage(plan, 's1')
    const restored = fromJSON(toJSON(confirmed))
    expect(restored).toEqual(confirmed)
  })

  it('roundtrips a stage carrying an atom and params', () => {
    const plan = createFlexiblePlan('c', 'invalidation', {
      stages: [{ ...stage('s1'), atom: 'reasoning', params: { mode: 'novelty' } }],
    })
    expect(fromJSON(toJSON(plan))).toEqual(plan)
  })

  it('roundtrips the optional plan fields', () => {
    const plan = createFlexiblePlan('c', 'invalidation', {
      technicalField: 'H01:基本电气元件',
      inputText: '交底书正文',
      stages: [stage('s1')],
    })
    const abandoned = abandon(plan, '用户取消')
    expect(fromJSON(toJSON(abandoned))).toEqual(abandoned)
  })

  it('fromJSON rejects invalid snapshots', () => {
    expect(() => fromJSON('{}')).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ caseId: 'c', caseType: 'x' }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({
      caseId: 'c',
      caseType: 'x',
      stages: [],
      status: 'weird',
      createdAt: 'now',
      updatedAt: 'now',
    }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON('{not-json')).toThrow(SyntaxError)
  })

  it('fromJSON rejects stage-level / pointer-level invalid snapshots', () => {
    const base = {
      caseId: 'c',
      caseType: 'invalidation',
      status: 'active',
      stages: [stage('s1')],
      createdAt: 'now',
      updatedAt: 'now',
    }
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), goal: '' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), strategy: 'bogus' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), status: 'weird' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), artifacts: 'x' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [stage('s1'), stage('s1')] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, currentStageId: 'ghost' }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, caseId: '../evil' }))).toThrow(FlexiblePlanError)
  })

  it('fromJSON rejects header-level type errors beyond the existing cases', () => {
    const base = {
      caseId: 'c',
      caseType: 'invalidation',
      status: 'active',
      stages: [stage('s1')],
      createdAt: 'now',
      updatedAt: 'now',
    }
    expect(() => fromJSON(JSON.stringify({ ...base, caseType: 42 }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, caseType: '' }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: 'nope' }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [null] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [42] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), id: 42 }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), id: ' ' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), name: 42 }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), constraintIds: 'x' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), articleJudgments: 'x' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, revisions: 'x' }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, revisions: [null] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({ ...base, revisions: [{ gapId: 'g' }] }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({
      ...base,
      revisions: [{ gapId: 'g', rewindTo: 's1', requestedBy: 's1', round: 0, before: 'x', rationale: 'r', outcome: 'applied', at: 'now' }],
    }))).toThrow(FlexiblePlanError)
    expect(() => fromJSON(JSON.stringify({
      ...base,
      revisions: [{ gapId: 'g', rewindTo: 's1', requestedBy: 's1', round: 1, before: 'x', rationale: 'r', outcome: 'unknown' }],
    }))).toThrow(/outcome/)
    // at 可选；给出时必须是字符串。
    const withoutAt = { gapId: 'g', rewindTo: 's1', requestedBy: 's1', round: 1, before: 'x', rationale: 'r', outcome: 'applied' }
    expect(fromJSON(JSON.stringify({ ...base, revisions: [withoutAt] })).revisions).toHaveLength(1)
    const withOptionals = { ...withoutAt, after: 'y', evidence: 'state.x', at: '2026-10-22T00:00:00.000Z' }
    expect(fromJSON(JSON.stringify({ ...base, revisions: [withOptionals] })).revisions?.[0]).toMatchObject(withOptionals)
    expect(() => fromJSON(JSON.stringify({ ...base, revisions: [{ ...withoutAt, at: 42 }] }))).toThrow(FlexiblePlanError)
  })

  it('fromJSON rejects malformed optional fields and stage collections', () => {
    const base = {
      caseId: 'c',
      caseType: 'invalidation',
      status: 'active',
      stages: [stage('s1')],
      createdAt: 'now',
      updatedAt: 'now',
    }
    for (const [field, value] of [
      ['technicalField', 42],
      ['inputText', {}],
      ['abandonReason', false],
      ['createdAt', 42],
      ['updatedAt', null],
      ['currentStageId', 42],
    ] as const) {
      expect(() => fromJSON(JSON.stringify({ ...base, [field]: value }))).toThrow(FlexiblePlanError)
    }
    for (const overrides of [
      { artifacts: [42] },
      { constraintIds: [null] },
      { articleJudgments: [false] },
      { atom: 42 },
      { atom: ' ' },
      { params: [] },
      { params: 'mode' },
    ]) {
      expect(() => fromJSON(JSON.stringify({ ...base, stages: [{ ...stage('s1'), ...overrides }] }))).toThrow(FlexiblePlanError)
    }
  })
})

describe('complete / abandon / terminal guards', () => {
  it('complete marks all pending confirmed and ends the plan', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const done = complete(plan)
    expect(done.status).toBe('completed')
    expect(done.stages.every(s => s.status === 'confirmed')).toBe(true)
    expect(done.currentStageId).toBeUndefined()
  })

  it('complete keeps already-confirmed stages confirmed (no-op on them)', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2'), stage('s3')] })
    const confirmed = confirmStage(plan, 's1')
    const done = complete(confirmed)
    expect(done.status).toBe('completed')
    expect(done.stages.map(s => s.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
  })

  it('abandon rolls back pending, keeps confirmed for audit, records reason', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1'), stage('s2')] })
    const confirmed = confirmStage(plan, 's1')
    const ab = abandon(confirmed, '用户取消')
    expect(ab.status).toBe('abandoned')
    expect(ab.abandonReason).toBe('用户取消')
    expect(ab.stages[0]!.status).toBe('confirmed')
    expect(ab.stages[1]!.status).toBe('rolled_back')
  })

  it('abandon empty reason throws (audit fail-closed)', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    expect(() => abandon(plan, '')).toThrow(FlexiblePlanError)
    expect(() => abandon(plan, '   ')).toThrow(FlexiblePlanError)
    expect(() => abandon(plan, '\t')).toThrow(FlexiblePlanError)
  })

  it('completed/abandoned plans reject all mutations', () => {
    const plan = createFlexiblePlan('c', 'invalidation', { stages: [stage('s1')] })
    const done = complete(plan)
    expect(() => addStage(done, stage('s2'))).toThrow(FlexiblePlanError)
    expect(() => removeStage(done, 's1')).toThrow(FlexiblePlanError)
    expect(() => reorderStages(done, ['s1'])).toThrow(FlexiblePlanError)
    expect(() => confirmStage(done, 's1')).toThrow(FlexiblePlanError)
    expect(() => rollbackStage(done, 's1')).toThrow(FlexiblePlanError)
    expect(() => complete(done)).toThrow(FlexiblePlanError)

    const ab = abandon(plan, 'r')
    expect(() => addStage(ab, stage('s2'))).toThrow(FlexiblePlanError)
    expect(() => complete(ab)).toThrow(FlexiblePlanError)
    expect(() => abandon(ab, 'again')).toThrow(FlexiblePlanError)
  })
})

describe('toCompiledGraph (flexible plan → graph engine)', () => {
  it('stages declaring an atom are executed by the graph engine', async () => {
    registerBuiltinAtoms()
    const provider = {
      callLLM: async () => JSON.stringify({ features: ['特征A', '特征B'], problems: ['问题1'], effects: ['效果1'] }),
    }
    const plan = createFlexiblePlan('case-g', 'disclosure_analysis', {
      stages: [
        stage('extract', { atom: 'extract', params: { extraction_type: '提取技术特征', output_key: 'features' } }),
        stage('merge', { atom: 'merge' }),
        stage('done'),
      ],
    })
    const graph = toCompiledGraph(plan, {
      handlers: globalStageHandlerRegistry,
      atoms: globalAtomRegistry,
      provider,
    })
    const result = await graph.run({ text: '一种装置' })
    expect(result.completed).toBe(true)
    expect(Array.isArray(result.state.features)).toBe(true)
    expect(result.state.pfe_triples || result.state.merge_result).toBeTruthy()
  })
})
