/**
 * The boundary table for `verify-patent-team-stages`: which rows the parser
 * admits, and each drift direction the gate must reject. The last cases run the
 * gate's own functions over the shipped skill and shipped manifests, so a green
 * pair is distinguishable from a parser that found no row at all.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'
import { describe, expect, it } from 'vitest'
import {
  SCENARIO_CONTRACTS,
  TEAM_SKILL_PATH,
  chainRow,
  citedStages,
  knownStageIds,
  scenarioDrift,
  scenarioSection,
} from './verify-patent-team-stages.ts'

const DISCLOSURE = 'patent_disclosure_v1'
const OA = 'patent_oa_response_v1'

/** The shipped manifests' stage ids, keyed by manifest id. */
const STAGES = new Map(builtinPatentManifests.map(manifest => [manifest.id, manifest.stages.map(stage => stage.id)]))
const KNOWN = knownStageIds(builtinPatentManifests)

/** The disclosure scenario contract, for drift cases that do not care which scenario they run on. */
const DISCLOSURE_CONTRACT = SCENARIO_CONTRACTS.find(contract => contract.manifestId === DISCLOSURE)

/** A chain row naming the disclosure stages in execution order. */
function disclosureRow(): string {
  return `| t4 | 执行 | ${(STAGES.get(DISCLOSURE) ?? []).map(id => `\`${id}\``).join(' → ')} |`
}

describe('scenarioSection', () => {
  it('returns the section body up to the next level-three heading', () => {
    const markdown = ['### 场景二：撰写包（7 成员）', '', '正文 A', '### 场景三：答复包', '正文 B'].join('\n')
    expect(scenarioSection(markdown, '### 场景二：撰写包')).toBe('\n正文 A')
  })

  it('matches the heading by prefix so a changed member count still resolves', () => {
    const markdown = ['### 场景二：撰写包（9 成员）', '正文'].join('\n')
    expect(scenarioSection(markdown, '### 场景二：撰写包')).toBe('正文')
  })

  it('returns undefined when no heading carries the prefix', () => {
    expect(scenarioSection('### 别的场景\n正文', '### 场景二：撰写包')).toBeUndefined()
  })
})

describe('citedStages', () => {
  it('keeps known stage ids in first-citation order and drops repeats', () => {
    expect(citedStages('`draft_claims` 与 `claim_strategy` 与 `draft_claims`', KNOWN))
      .toEqual(['draft_claims', 'claim_strategy'])
  })

  it('ignores backticked names the catalog does not declare', () => {
    expect(citedStages('`read` `patent_illustrator` `not-a-stage`', KNOWN)).toEqual([])
  })
})

describe('chainRow', () => {
  it('picks the row citing the most known stages', () => {
    const section = [
      '| t5 | 复核 `merge` 结果 |',
      disclosureRow(),
      '| t6 | 复核 `spec_check` |',
    ].join('\n')
    expect(chainRow(section, KNOWN)).toBe(disclosureRow())
  })

  it('returns undefined when no table row cites a known stage', () => {
    expect(chainRow('| t1 | 无阶段 |', KNOWN)).toBeUndefined()
  })
})

describe('scenarioDrift', () => {
  it('reports a stage the owning manifest does not declare', () => {
    // `preprocess` belongs to the disclosure chain, not the office-action one:
    // a copy-paste across the two scenarios must fail here.
    const oaStages = STAGES.get(OA) ?? []
    const contract = { heading: 'x', manifestId: OA, requiredStages: [] }
    const problems = scenarioDrift(contract, disclosureRow(), oaStages, KNOWN)
    expect(problems.some(problem => problem.includes('不声明阶段 "preprocess"'))).toBe(true)
  })

  it('rejects the disclosure gate when the row cites the office-action gate instead', () => {
    const disclosureStages = STAGES.get(DISCLOSURE) ?? []
    const row = `| t | \`slop_gate\` → \`draft_review\` |`
    const contract = { heading: 'x', manifestId: DISCLOSURE, requiredStages: [] }
    expect(scenarioDrift(contract, row, disclosureStages, KNOWN))
      .toEqual(['"patent_disclosure_v1" 不声明阶段 "slop_gate"（场景表引用了它）'])
  })

  it('reports a required stage the chain row omits', () => {
    const stages = STAGES.get(DISCLOSURE) ?? []
    const row = `| t4 | 执行 | ${stages.filter(id => id !== 'draft_review').map(id => `\`${id}\``).join(' → ')} |`
    expect(scenarioDrift(DISCLOSURE_CONTRACT!, row, stages, KNOWN))
      .toEqual(['场景链行漏掉阶段 "draft_review"'])
  })

  it('reports a citation order that contradicts the manifest order', () => {
    const stages = STAGES.get(DISCLOSURE) ?? []
    const swapped = ['draft_specification', 'draft_claims']
    const row = `| t4 | 执行 | ${swapped.map(id => `\`${id}\``).join(' → ')} |`
    const contract = { heading: 'x', manifestId: DISCLOSURE, requiredStages: [] }
    expect(scenarioDrift(contract, row, stages, KNOWN))
      .toEqual(['阶段 "draft_claims" 的引用顺序与 "patent_disclosure_v1" 的执行顺序相反'])
  })

  it('reports a required stage the contract pins to the wrong manifest', () => {
    const stages = STAGES.get(OA) ?? []
    const contract = { heading: 'x', manifestId: OA, requiredStages: ['draft_review'] }
    expect(scenarioDrift(contract, `| t | ${stages.map(id => `\`${id}\``).join(' ')} |`, stages, KNOWN))
      .toEqual(['必含阶段 "draft_review" 不在 "patent_oa_response_v1" 中（契约写错了 manifest）'])
  })

  it('reports nothing when the chain row matches the manifest', () => {
    const stages = STAGES.get(DISCLOSURE) ?? []
    const contract = { heading: 'x', manifestId: DISCLOSURE, requiredStages: stages }
    expect(scenarioDrift(contract, disclosureRow(), stages, KNOWN)).toEqual([])
  })
})

describe('shipped skill', () => {
  const markdown = readFileSync(resolve(import.meta.dirname, '..', TEAM_SKILL_PATH), 'utf8')

  it('keeps every scenario chain row in step with its manifest', () => {
    for (const contract of SCENARIO_CONTRACTS) {
      const section = scenarioSection(markdown, contract.heading)
      expect(section, `${contract.heading} 缺失`).toBeDefined()
      const row = chainRow(section ?? '', KNOWN)
      expect(row, `${contract.heading} 未引用任何已知阶段 id`).toBeDefined()
      const stageIds = STAGES.get(contract.manifestId)
      expect(stageIds, `${contract.manifestId} 不存在`).toBeDefined()
      expect(scenarioDrift(contract, row ?? '', stageIds ?? [], KNOWN)).toEqual([])
    }
  })

  it('names the office-action stage that rewinds rather than the disclosure-only gate', () => {
    // `slop_gate` retries `draft`; `slop_clean` only reports. A scenario that
    // swaps them tells the captain to wait for a rework that never comes.
    const section = scenarioSection(markdown, '### 场景三：答复审查意见包') ?? ''
    const row = chainRow(section, KNOWN) ?? ''
    expect(row).toContain('slop_gate')
    expect(row).not.toContain('slop_clean')
  })
})
