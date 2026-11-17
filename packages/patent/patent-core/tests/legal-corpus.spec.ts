import { describe, expect, it } from 'vitest'
import { deriveClaimRefs, parseOfficeAction } from '@deepseek-ai/dsh-patent-core'
import { AmendmentBasisHandler } from '../src/atoms/handlers/builtin/amendment-basis.ts'
import { PriorArtFilterHandler } from '../src/atoms/handlers/builtin/prior-art-filter.ts'
import { analyzeNumericRanges } from '../src/novelty/numeric-range.ts'
import { deriveAllElementsCoverage } from '../src/infringement/all-elements.ts'
import { identifyInvalidationGrounds } from '../src/notice/grounds.ts'
import { validateClaimRefs } from '../src/claim-chart/runtime/claim-refs.ts'
import type { AmendmentBasisViolation } from '../src/atoms/handlers/builtin/amendment-basis.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { LEGAL_CORPUS, type LegalCorpusCase } from './fixtures/legal-corpus/index.ts'

/**
 * 执行一则金标语料用例并断言其法律结论。
 * @param entry - 按引擎分派的语料条目。
 */
async function assertCase(entry: LegalCorpusCase): Promise<void> {
  switch (entry.engine) {
    case 'numeric-range': {
      const analysis = analyzeNumericRanges({
        claims: [{ id: 'claim-1', text: entry.claim }],
        priorArt: entry.priorArt,
      })
      expect(analysis.verdict).toBe(entry.expected)
      return
    }
    case 'claim-refs': {
      const refs = deriveClaimRefs(entry.text)
      expect(refs).toEqual(entry.expected)
      expect(validateClaimRefs(refs)).toEqual(entry.expectedIssues)
      return
    }
    case 'amendment-basis': {
      const out = await new AmendmentBasisHandler().execute({
        state: {
          draft: entry.draft,
          claims: entry.claims,
          ...(entry.description === undefined ? {} : { description: entry.description }),
        },
      })
      expect(out.amendment_basis_passed).toBe(entry.expectedPassed)
      const violations = out.amendment_basis_violations as AmendmentBasisViolation[]
      expect(violations.map(violation => violation.addedSpan)).toEqual(entry.expectedSpans)
      return
    }
    case 'prior-art-filter': {
      const out = await new PriorArtFilterHandler().execute({ state: entry.state })
      const kept = out.prior_art as { title?: string }[]
      const excluded = out.prior_art_excluded as { reason: string }[]
      expect(kept.map(document => document.title)).toEqual(entry.expectedKeptTitles)
      expect(excluded.map(record => record.reason)).toEqual(entry.expectedExcludedReasons)
      const report = String(out.prior_art_filter_report)
      for (const expected of entry.expectedReportText) expect(report).toContain(expected)
      return
    }
    case 'office-action': {
      const parsed = parseOfficeAction(entry.text)
      expect(parsed.rejectionTypes).toEqual(entry.expected.types)
      expect(parsed.affectedClaims).toEqual(entry.expected.claims)
      expect(
        parsed.citations.map(citation => ({
          documentNumber: citation.documentNumber,
          claimsAffected: citation.claimsAffected,
        })),
      ).toEqual(entry.expected.citations)
      expect(parsed.parseConflicts).toHaveLength(entry.expected.conflictCount)
      return
    }
    case 'all-elements': {
      const coverage = deriveAllElementsCoverage(entry.rows, entry.targetId, entry.elements)
      expect(coverage.outcome).toBe(entry.expected.outcome)
      expect(coverage.literalElements).toEqual(entry.expected.literal)
      expect(coverage.missingElements).toEqual(entry.expected.missing)
      return
    }
    case 'grounds': {
      const findings = identifyInvalidationGrounds(entry.text)
      expect(findings.map(finding => ({ ground: finding.ground, negated: finding.negated }))).toEqual(
        entry.expected,
      )
      return
    }
    default:
      assertNever(entry)
  }
}

describe('legal corpus', () => {
  for (const entry of LEGAL_CORPUS) {
    it(`${entry.id} ${entry.title}`, async () => {
      await assertCase(entry)
    })
  }
})
