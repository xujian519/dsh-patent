/**
 * 随包费用索引的来源记录检查（D9）。
 *
 * 费用金额与减缴比例都是人工转录的内容，判据不在运行期：一条金额是否正确，只能由
 * 「来源文书 + 核验日期 + 法条依据」三项记录来追。本组用例把这三项与年费档位、
 * 滞纳金规则的完整性钉住，并把每条 `legalBasis` 交给 `patent-law` 的索引逐条判定，
 * 使一条引用到不存在或未转录条文的费用条目在 CI 里直接失败。
 */

import { describe, expect, it } from 'vitest'
import { loadLawBaselines, verifyCitations } from '@deepseek-ai/dsh-patent-law'
import { loadFeeTable } from '../src/fees.ts'

const shipped = loadFeeTable()
const annual = shipped.items.filter(item => item.basis === 'per-annuity-year')

describe('the shipped fee index keeps its source records', () => {
  it('states the standard, its revision, and the copy that was checked', () => {
    expect(shipped.document).not.toBe('')
    expect(shipped.revision).not.toBeNull()
    expect(shipped.sourceDoc).not.toBeNull()
    expect(shipped.verifiedOn).not.toBeNull()
  })

  it('gives every priced item the document and date its amount came from', () => {
    const priced = shipped.items.filter(item => item.amount !== null || item.tiers.length > 0)
    expect(priced.length).toBeGreaterThan(0)
    for (const item of priced) {
      expect(item.sourceDoc, item.id).not.toBeNull()
      expect(item.verifiedOn, item.id).not.toBeNull()
    }
  })

  it('gives every item a statutory basis and records the two unpriced items as unpriced', () => {
    for (const item of shipped.items) {
      expect(item.legalBasis, item.id).not.toBeNull()
    }
    const unpriced = shipped.items.filter(item => item.amount === null && item.tiers.length === 0)
    expect(unpriced.map(item => item.id)).toEqual(['specification-surcharge', 'extension-fee'])
    for (const item of unpriced) {
      expect(item.sourceDoc, item.id).not.toBeNull()
      // No amount is recorded, so no amount has been checked.
      expect(item.verifiedOn, item.id).toBeNull()
    }
  })

  it('gives every annual-fee item tiers, a surcharge rule, a reduction cap, and a basis', () => {
    expect(annual.map(item => item.id)).toEqual(['annual-fee', 'annual-fee-utility-model', 'annual-fee-design'])
    for (const item of annual) {
      expect(item.amount, item.id).toBeNull()
      expect(item.tiers.length, item.id).toBeGreaterThan(0)
      expect(item.reducible, item.id).toBe(true)
      expect(item.reductionMaxYears, item.id).toBe(10)
      expect(item.latePayment, item.id).toBeDefined()
      expect(item.latePayment?.monthlyPercent, item.id).toBe(5)
      expect(item.latePayment?.maxMonths, item.id).toBe(6)
      expect(item.latePayment?.legalBasis, item.id).not.toBeNull()
      expect(item.latePayment?.sourceDoc, item.id).not.toBeNull()
      expect(item.latePayment?.verifiedOn, item.id).not.toBeNull()
    }
  })

  it('covers the patent years with contiguous, non-overlapping tiers', () => {
    for (const item of annual) {
      expect(item.tiers[0]?.fromYear, item.id).toBe(1)
      for (let index = 1; index < item.tiers.length; index += 1) {
        expect(item.tiers[index]!.fromYear, item.id).toBe(item.tiers[index - 1]!.toYear + 1)
      }
    }
  })

  it('gives each reduction programme its ratio, filing gate, and source', () => {
    expect(shipped.reductions.map(rule => rule.kind)).toEqual(['individual', 'enterprise'])
    for (const rule of shipped.reductions) {
      expect(rule.reductionPercent, rule.kind).not.toBeNull()
      expect(rule.requiresFiling, rule.kind).toBe(true)
      expect(rule.sourceDoc, rule.kind).not.toBeNull()
      expect(rule.verifiedOn, rule.kind).not.toBeNull()
    }
  })

  it('cites only provisions the shipped law index carries as verified', () => {
    const baselines = loadLawBaselines()
    for (const item of shipped.items) {
      const citations = verifyCitations(item.legalBasis ?? '', baselines)
      expect(citations.length, item.id).toBeGreaterThan(0)
      for (const citation of citations) {
        expect(citation.decision, `${item.id}: ${citation.raw}`).toBe('valid')
      }
    }
  })
})
