import { describe, expect, it } from 'vitest'
import {
  countCitationDecisions,
  missingIndexReason,
  renderCitationDecisionRows,
  resolveCitationDecisionPolicy,
  type ArticleDecision,
  type CitationDecisionPolicy,
} from '@deepseek-ai/dsh-law-core'

const POLICIES: CitationDecisionPolicy = {
  mismatch: 'block',
  unmatched: 'warn',
  outOfRange: 'block',
  notIndexed: 'warn',
  unverified: 'block',
}

const DECISIONS: ArticleDecision[] = [
  'valid',
  'mismatch',
  'unmatched',
  'out-of-range',
  'not-indexed',
  'unverified',
]

describe('resolveCitationDecisionPolicy', () => {
  it('valid 一律放行，其余读对应策略字段', () => {
    expect(resolveCitationDecisionPolicy('valid', POLICIES)).toBe('allow')
    expect(resolveCitationDecisionPolicy('mismatch', POLICIES)).toBe('block')
    expect(resolveCitationDecisionPolicy('unmatched', POLICIES)).toBe('warn')
    expect(resolveCitationDecisionPolicy('out-of-range', POLICIES)).toBe('block')
    expect(resolveCitationDecisionPolicy('not-indexed', POLICIES)).toBe('warn')
    expect(resolveCitationDecisionPolicy('unverified', POLICIES)).toBe('block')
  })
})

describe('renderCitationDecisionRows', () => {
  it('没有引用时给出未识别说明', () => {
    expect(renderCitationDecisionRows([])).toContain('未在文本中识别到法条引用')
  })

  it('转义单元格中的竖线，并使用共享判定文案', () => {
    const report = renderCitationDecisionRows(DECISIONS.map(decision => ({
      label: `条|${decision}`,
      decision,
      policy: resolveCitationDecisionPolicy(decision, POLICIES),
      reason: '说明|原文',
    })))
    expect(report).toContain('条\\|valid')
    expect(report).toContain('已核验')
    expect(report).toContain('与所引命题不符')
    expect(report).toContain('未与条文对应（未判定）')
    expect(report).toContain('条号超出有效范围')
    expect(report).toContain('索引中不存在')
    expect(report).toContain('条文未转录（未核验）')
    expect(report).toContain('拦截')
    expect(report).toContain('警告')
    expect(report).toContain('放行')
    expect(report).toContain('说明\\|原文')
  })
})

describe('countCitationDecisions', () => {
  it('未出现的判定也计为零', () => {
    expect(countCitationDecisions([{ decision: 'valid' }, { decision: 'valid' }])).toEqual({
      'valid': 2,
      'mismatch': 0,
      'unmatched': 0,
      'out-of-range': 0,
      'not-indexed': 0,
      'unverified': 0,
    })
  })
})

describe('missingIndexReason', () => {
  it('点名没有随包索引的法律', () => {
    expect(missingIndexReason('专利法')).toBe('本次部署没有随包索引《专利法》，该引用无法核验')
  })
})
