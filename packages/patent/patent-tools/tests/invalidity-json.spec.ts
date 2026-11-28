import { describe, expect, it } from 'vitest'
import { readInvalidityConclusion, renderInvalidityReadDefects } from '../src/tool/internal/invalidity-json.ts'

describe('readInvalidityConclusion', () => {
  it('keeps the fields the invalidity renderer prints', () => {
    const { conclusion } = readInvalidityConclusion({
      primaryTargetId: 'D1',
      novelty: [{
        targetId: 'D1',
        title: '对比文件1',
        claims: [{
          claimNo: 2,
          covered: false,
          missing: ['2a'],
          includesReferredClaims: true,
          referredClaimNos: [1],
          missingReferredClaims: [1],
          alternatives: [{ referredClaimNos: [1], covered: true, missing: [], missingReferredClaims: [9] }],
        }],
      }],
      distinguishing: [{
        claimNo: 2,
        elementIds: ['2a'],
        alternatives: [{ referredClaimNos: [1], elementIds: ['2a'] }],
      }],
      dependentClaimIssues: [{
        kind: 'additional-features-only',
        claimNo: 2,
        referredClaimNo: 1,
        targetId: 'D1',
        detail: '仅附加特征',
      }, { kind: 'other' }],
      claimRefIssues: [
        { kind: 'self-reference', claimNo: 3 },
        { kind: 'missing-reference', claimNo: 4, refersTo: [9] },
        { kind: 'later-reference', claimNo: 1, refersTo: [2] },
        { kind: 'reference-cycle', claimNos: [1, 2] },
        { kind: 'unknown' },
      ],
    })
    expect(conclusion.primaryTargetId).toBe('D1')
    expect(conclusion.novelty[0]?.title).toBe('对比文件1')
    expect(conclusion.novelty[0]?.claims[0]?.missingReferredClaims).toEqual([1])
    expect(conclusion.novelty[0]?.claims[0]?.alternatives?.[0]?.missingReferredClaims).toEqual([9])
    expect(conclusion.distinguishing[0]?.alternatives).toEqual([{ referredClaimNos: [1], elementIds: ['2a'] }])
    expect(conclusion.dependentClaimIssues).toHaveLength(1)
    expect(conclusion.claimRefIssues.map(issue => issue.kind)).toEqual([
      'self-reference',
      'missing-reference',
      'later-reference',
      'reference-cycle',
    ])
  })

  it('drops optional groups that are absent or not objects', () => {
    expect(readInvalidityConclusion('nope')).toEqual({
      conclusion: {
        novelty: [],
        distinguishing: [],
        dependentClaimIssues: [],
        claimRefIssues: [],
      },
      defects: [],
    })
    const { conclusion: sparse } = readInvalidityConclusion({
      novelty: [
        { targetId: 'D2', claims: [{ claimNo: 1 }] },
        { targetId: 'D3', claims: [{ claimNo: 2, alternatives: [{ referredClaimNos: [], covered: false, missing: [] }] }] },
      ],
      distinguishing: [{ claimNo: 1, elementIds: [] }],
    })
    expect(sparse.primaryTargetId).toBeUndefined()
    expect(sparse.novelty[0]?.title).toBeUndefined()
    expect(sparse.novelty[0]?.claims[0]?.alternatives).toBeUndefined()
    expect(sparse.novelty[0]?.claims[0]?.missingReferredClaims).toBeUndefined()
    expect(sparse.novelty[1]?.claims[0]?.alternatives?.[0]?.missingReferredClaims).toBeUndefined()
    expect(sparse.distinguishing[0]?.alternatives).toBeUndefined()
  })

  it('drops entries whose claim number is not a positive integer and reports each defect', () => {
    const { conclusion, defects } = readInvalidityConclusion({
      novelty: [
        {
          targetId: 'D1',
          claims: [
            { claimNo: 0, covered: false },
            { claimNo: 1.5, covered: false },
            { claimNo: 2, covered: true },
          ],
        },
      ],
      distinguishing: [
        { claimNo: Number.NaN, elementIds: [] },
        { claimNo: 2, elementIds: ['2a'] },
      ],
      dependentClaimIssues: [
        { kind: 'additional-features-only', claimNo: 0, referredClaimNo: 1, targetId: 'D1', detail: 'x' },
        { kind: 'additional-features-only', claimNo: 1, referredClaimNo: 0, targetId: 'D1', detail: 'y' },
        { kind: 'additional-features-only', claimNo: 2, referredClaimNo: 1, targetId: 'D1', detail: 'z' },
      ],
      claimRefIssues: [
        { kind: 'self-reference', claimNo: 0 },
        { kind: 'missing-reference', claimNo: 3, refersTo: [9] },
        { kind: 'reference-cycle', claimNos: [1, 0, 2] },
        { kind: 'reference-cycle', claimNos: [0] },
        { kind: 'later-reference', claimNo: 0, refersTo: [1] },
      ],
    })
    expect(conclusion.novelty[0]?.claims.map(claim => claim.claimNo)).toEqual([2])
    expect(conclusion.distinguishing.map(entry => entry.claimNo)).toEqual([2])
    expect(conclusion.dependentClaimIssues.map(issue => issue.claimNo)).toEqual([2])
    expect(conclusion.claimRefIssues).toEqual([
      { kind: 'missing-reference', claimNo: 3, refersTo: [9] },
      { kind: 'reference-cycle', claimNos: [1, 2] },
    ])
    expect(defects.map(defect => defect.path)).toEqual([
      'novelty[0].claims[0]',
      'novelty[0].claims[1]',
      'distinguishing[0]',
      'dependentClaimIssues[0]',
      'dependentClaimIssues[1]',
      'claimRefIssues[0]',
      'claimRefIssues[2]',
      'claimRefIssues[3]',
      'claimRefIssues[4]',
    ])
    expect(defects[0]?.reason).toContain('claimNo')
    expect(defects[2]?.reason).toContain('claimNo')
    expect(defects[4]?.reason).toContain('referredClaimNo')
    expect(defects[6]?.reason).toContain('剔除')
    expect(defects[8]?.reason).toContain('claimNo')
  })

  it('renders read defects only when the reader dropped entries', () => {
    expect(renderInvalidityReadDefects([])).toEqual([])
    expect(renderInvalidityReadDefects([{ path: 'novelty[0].claims[1]', reason: 'claimNo 非法' }])).toEqual([
      '',
      '## 无效宣告结论读取缺陷（1 条）',
      '- novelty[0].claims[1]：claimNo 非法',
    ])
  })
})
