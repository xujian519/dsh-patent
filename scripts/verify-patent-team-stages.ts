/**
 * Keep the team skill's drafting and office-action scenario packs in step with
 * the manifests that own those stage sequences.
 *
 * The scenario tables name manifest stages, but nothing held them to the
 * manifests: `verify-patent-team-roster` judges names alone, so a
 * scenario could keep describing a chain that `patent_disclosure_v1` or
 * `patent_oa_response_v1` no longer runs — or keep a stage a rewind no longer
 * revisits. This gate reads each scenario's stage row, compares the cited stage
 * ids against the manifest's own id sequence, and rejects three drifts: a cited
 * id the manifest does not declare (including an id borrowed from the sibling
 * chain), a required stage the scenario omits, and a citation order that
 * contradicts the manifest order.
 *
 * It judges citations only. Team tasks, assignees, dependencies, and the
 * manifest-versus-team responsibility column are the skill's own content.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'

const root = resolve(import.meta.dirname, '..')

/** The shipped team skill owning the scenario tables, relative to the repository root. */
export const TEAM_SKILL_PATH = 'packages/bundle/web-app/skills/patent/patent-team-composition/SKILL.md'

/** One scenario the gate holds to a manifest. */
export interface ScenarioStageContract {
  /** Level-three heading prefix that opens the scenario section (the member count suffix may change). */
  heading: string
  /** Manifest id whose stage sequence the scenario cites. */
  manifestId: string
  /** Stage ids the scenario must cite, because the team's review work depends on their verdicts. */
  requiredStages: readonly string[]
}

/** The scenarios this gate holds; each names the manifest that owns its stage sequence. */
export const SCENARIO_CONTRACTS: readonly ScenarioStageContract[] = [
  {
    heading: '### 场景二：撰写包',
    manifestId: 'patent_disclosure_v1',
    requiredStages: [
      'claim_strategy',
      'draft_claims',
      'figure_analysis',
      'draft_specification',
      'spec_check',
      'enablement_report',
      'claim_breadth',
      'draft_review',
      'legal_gaps',
      'review_gate',
    ],
  },
  {
    heading: '### 场景三：答复审查意见包',
    manifestId: 'patent_oa_response_v1',
    requiredStages: [
      'parse',
      'claim-chart',
      'response-plan',
      'adversary-model',
      'draft',
      'tighten',
      'slop_gate',
      'adversary-review',
      'response_check',
      'amendment_basis',
      'approval',
    ],
  },
]

/**
 * Extract one scenario section's text, from its heading to the next level-three heading.
 * @param markdown - the skill file's text.
 * @param heading - the scenario's opening heading prefix.
 * @returns the section body, or undefined when no heading starts with the prefix.
 */
export function scenarioSection(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n')
  const start = lines.findIndex(line => line.startsWith(heading))
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('### ')) {
      end = index
      break
    }
  }
  return lines.slice(start + 1, end).join('\n')
}

/**
 * Collect the stage ids a scenario section cites, in citation order.
 *
 * Only ids the manifest catalog actually declares count as citations, so prose,
 * tool names, and worker names in the same section never read as stages.
 * @param section - one scenario's section text.
 * @param known - every stage id any builtin manifest declares.
 * @returns cited stage ids, deduplicated in first-citation order.
 */
export function citedStages(section: string, known: ReadonlySet<string>): string[] {
  const cited: string[] = []
  for (const match of section.matchAll(/`([a-z][a-z0-9_-]*)`/gu)) {
    const id = match[1]
    if (id === undefined || !known.has(id) || cited.includes(id)) continue
    cited.push(id)
  }
  return cited
}

/**
 * Pick the scenario's chain row: the table row citing the most known stages.
 *
 * The scenario prose legitimately mentions single stages out of execution order
 * (a review task reading `merge`, a note contrasting `slop_clean` with `slop_gate`),
 * so only the row that enumerates the chain is held to the manifest's order.
 * @param section - one scenario's section text.
 * @param known - every stage id any builtin manifest declares.
 * @returns the chain row's text, or undefined when no row cites a known stage.
 */
export function chainRow(section: string, known: ReadonlySet<string>): string | undefined {
  let best: string | undefined
  let bestCount = 0
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue
    const count = citedStages(line, known).length
    if (count > bestCount) {
      best = line
      bestCount = count
    }
  }
  return best
}

/**
 * Every stage id the shipped manifests declare, across all builtin manifests.
 * @param manifests - the builtin manifest list.
 * @returns the union of stage ids.
 */
export function knownStageIds(manifests: readonly { stages: readonly { id: string }[] }[]): Set<string> {
  const ids = new Set<string>()
  for (const manifest of manifests) {
    for (const stage of manifest.stages) ids.add(stage.id)
  }
  return ids
}

/**
 * Compare one scenario's chain row with the manifest that owns it.
 * @param contract - the scenario and its manifest.
 * @param row - the scenario's chain row text.
 * @param stageIds - the owning manifest's stage ids, in execution order.
 * @param known - every stage id the catalog declares.
 * @returns one message per divergence; empty when the row agrees.
 */
export function scenarioDrift(
  contract: ScenarioStageContract,
  row: string,
  stageIds: readonly string[],
  known: ReadonlySet<string>,
): string[] {
  const problems: string[] = []
  const cited = citedStages(row, known)
  const owned = new Set(stageIds)

  for (const id of cited) {
    if (!owned.has(id)) {
      problems.push(`"${contract.manifestId}" 不声明阶段 "${id}"（场景表引用了它）`)
    }
  }
  for (const id of contract.requiredStages) {
    if (!owned.has(id)) {
      problems.push(`必含阶段 "${id}" 不在 "${contract.manifestId}" 中（契约写错了 manifest）`)
      continue
    }
    if (!cited.includes(id)) problems.push(`场景链行漏掉阶段 "${id}"`)
  }

  const order = new Map(stageIds.map((id, index) => [id, index]))
  let highest = -1
  for (const id of cited) {
    const index = order.get(id)
    if (index === undefined) continue
    if (index < highest) {
      problems.push(`阶段 "${id}" 的引用顺序与 "${contract.manifestId}" 的执行顺序相反`)
      break
    }
    highest = index
  }
  return problems
}

if (import.meta.main) {
  const markdown = readFileSync(resolve(root, TEAM_SKILL_PATH), 'utf8')
  const known = knownStageIds(builtinPatentManifests)
  const problems: string[] = []
  let checked = 0

  for (const contract of SCENARIO_CONTRACTS) {
    const section = scenarioSection(markdown, contract.heading)
    if (section === undefined) {
      problems.push(`找不到场景标题 "${contract.heading}"`)
      continue
    }
    const manifest = builtinPatentManifests.find(entry => entry.id === contract.manifestId)
    if (manifest === undefined) {
      problems.push(`找不到 manifest "${contract.manifestId}"`)
      continue
    }
    const stageIds = manifest.stages.map(stage => stage.id)
    const row = chainRow(section, known)
    // No row citing a known stage means the parser matched nothing — a passing
    // gate here would report agreement with a table it never read.
    if (row === undefined || citedStages(row, known).length === 0) {
      problems.push(`"${contract.heading}" 未引用任何已知阶段 id（场景表可能被改写或清空）`)
      continue
    }
    checked += citedStages(row, known).length
    for (const problem of scenarioDrift(contract, row, stageIds, known)) {
      problems.push(`"${contract.heading}"：${problem}`)
    }
  }

  if (problems.length > 0) {
    console.error('verify-patent-team-stages failed:\n')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(`\nUpdate ${TEAM_SKILL_PATH} and packages/patent/patent-workflow/src/workflow/manifests.ts together.`)
    process.exit(1)
  }
  console.log(`verify-patent-team-stages: ${checked} stage citation(s) agree with ${SCENARIO_CONTRACTS.length} manifest(s).`)
}
