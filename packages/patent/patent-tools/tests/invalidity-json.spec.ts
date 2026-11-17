import { describe, expect, it } from 'vitest'
import { readInvalidityConclusion } from '../src/tool/internal/invalidity-json.ts'

describe('readInvalidityConclusion', () => {
  it('keeps the fields the invalidity renderer prints', () => {
    const conclusion = readInvalidityConclusion({
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
      novelty: [],
      distinguishing: [],
      dependentClaimIssues: [],
      claimRefIssues: [],
    })
    const sparse = readInvalidityConclusion({
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
})
