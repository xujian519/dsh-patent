/**
 * Keep the patent team's role catalog and the shipped team-composition skill in step.
 *
 * `role-contracts.ts` states that the catalog corresponds one-to-one with the
 * role table in `patent-team-composition/SKILL.md`, and the seven scenario packs
 * staff their task tables from that same catalog. Nothing held that
 * correspondence: the catalog, the skill table, and the preset READMEs were kept
 * in step by hand, so a role added to one of them drifts from the others until a
 * reader notices. This gate reads the shipped skill's role table, compares its
 * role ids with `defaultRoleContracts()`, and checks each scenario's `成员：`
 * line and task owners against the registered display names.
 *
 * It judges names only. Task order, dependencies, and the manifest stage chains
 * in the same sections are the skill's own content (the stage chains are held to
 * the manifests by `verify-patent-team-stages`).
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultRoleContracts } from '@deepseek-ai/dsh-patent-workflow'

const root = resolve(import.meta.dirname, '..')

/** The shipped team-composition skill owning the role table, relative to the repository root. */
export const ROSTER_SKILL_PATH = 'packages/bundle/web-app/skills/patent/patent-team-composition/SKILL.md'

/** The heading introducing the role table. */
const ROSTER_HEADING = '## 角色总表'

/** One scenario's declared members and the owners its task table names. */
export interface ScenarioRoster {
  /** The scenario's `###` heading text, without the marker. */
  heading: string
  /** Display names on the `成员：` line, in declaration order. */
  members: string[]
  /** Names in the task table's `负责人` column, in row order. */
  assignees: string[]
}

/**
 * Collect the role ids from a skill's role table, in table order.
 * @param markdown - the skill file's text.
 * @returns the second-column ids with backticks removed; empty when the heading or table is absent.
 */
export function parseRosterRoleIds(markdown: string): string[] {
  const ids: string[] = []
  let inTable = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      if (inTable) break
      inTable = line.startsWith(ROSTER_HEADING)
      continue
    }
    if (!inTable || !line.startsWith('|')) continue
    // '| 制图员 | `illustrator` | … |' splits into ['', '制图员', '`illustrator`', …, ''].
    const cell = line.split('|')[2]?.trim().replaceAll('`', '')
    if (cell === undefined || cell === '' || cell === 'role id' || cell.startsWith('-')) continue
    ids.push(cell)
  }
  return ids
}

/**
 * Read the display names declared on one scenario's `成员：` line.
 *
 * The line names required members before any parenthetical and may add one
 * optional member as `（+ 技术调查官，…）`; both count as declared members.
 * @param line - the line beginning with `成员：`.
 * @returns display names, without notes such as the value-condition suffix.
 */
export function parseScenarioMemberNames(line: string): string[] {
  const body = line.slice('成员：'.length).split('。')[0] ?? ''
  const [main = '', optional = ''] = body.split('（')
  const names = main.split('、').map(name => name.trim()).filter(name => name !== '')
  const addition = optional.match(/^\+\s*([^，）]+)/u)
  if (addition?.[1] !== undefined) names.push(addition[1].trim())
  return names
}

/**
 * Collect every scenario's declared members and task owners.
 *
 * Within one scenario, the first table row containing a `负责人` cell fixes
 * that column; the row's own value is not an assignee. A scenario without a
 * `成员：` line keeps an empty member list so the drift check can name it.
 * @param markdown - the skill file's text.
 * @returns one entry per `### 场景` section, in document order.
 */
export function parseScenarioRosters(markdown: string): ScenarioRoster[] {
  const scenarios: ScenarioRoster[] = []
  let current: ScenarioRoster | undefined
  let ownerColumn: number | undefined
  for (const line of markdown.split('\n')) {
    if (line.startsWith('### ')) {
      const heading = line.slice(4).trim()
      if (!heading.startsWith('场景')) {
        current = undefined
        ownerColumn = undefined
        continue
      }
      current = { heading, members: [], assignees: [] }
      scenarios.push(current)
      ownerColumn = undefined
      continue
    }
    if (line.startsWith('## ')) {
      current = undefined
      ownerColumn = undefined
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('成员：')) {
      current.members = parseScenarioMemberNames(line)
      continue
    }
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map(cell => cell.trim())
    const headerIndex = cells.indexOf('负责人')
    if (headerIndex !== -1) {
      ownerColumn = headerIndex
      continue
    }
    if (ownerColumn === undefined) continue
    const owner = cells[ownerColumn]
    if (owner === undefined || owner === '' || owner.startsWith('-')) continue
    current.assignees.push(owner)
  }
  return scenarios
}

/**
 * Map scenario display names to role ids, including slash aliases such as
 * `合议组/裁判` (both spellings name the `adjudicator` role).
 * @param contracts - the registered role contracts.
 * @returns one entry per display alias.
 */
export function roleIdsByDisplayName(
  contracts: readonly { role: string; name: string }[],
): Map<string, string> {
  const byName = new Map<string, string>()
  for (const contract of contracts) {
    for (const alias of contract.name.split('/')) byName.set(alias.trim(), contract.role)
  }
  return byName
}

/**
 * Compare the registered roles with the ones the role table lists.
 * @param catalog - role ids from the worker/role catalog.
 * @param table - role ids parsed from the skill.
 * @returns one message per divergence; empty when the two agree.
 */
export function rosterDrift(catalog: readonly string[], table: readonly string[]): string[] {
  const problems: string[] = []
  for (const role of catalog) {
    if (!table.includes(role)) problems.push(`角色总表缺少 "${role}"（role-contracts.ts 已注册）`)
  }
  for (const role of table) {
    if (!catalog.includes(role)) problems.push(`角色总表多出 "${role}"（role-contracts.ts 未注册）`)
  }
  return problems
}

/**
 * Compare one scenario's members and task owners with the registered roles.
 *
 * A task owner may be `captain`, who leads the team without joining it. Every
 * other owner must appear on the same scenario's member line, so a renamed or
 * dropped member cannot leave an orphaned task row.
 * @param scenario - one parsed scenario.
 * @param roleIdByName - registered display names, including slash aliases.
 * @returns one message per divergence; empty when the scenario agrees.
 */
export function scenarioRosterDrift(
  scenario: ScenarioRoster,
  roleIdByName: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = []
  if (scenario.members.length === 0) {
    problems.push(`"${scenario.heading}" 缺少“成员：”行`)
  }
  const members = new Set(scenario.members)
  for (const name of scenario.members) {
    if (!roleIdByName.has(name)) {
      problems.push(`"${scenario.heading}" 的成员 "${name}" 不是已注册角色名（role-contracts.ts）`)
    }
  }
  for (const name of scenario.assignees) {
    if (name === 'captain' || members.has(name)) continue
    problems.push(`"${scenario.heading}" 的任务负责人 "${name}" 不在该场景的成员行中`)
  }
  return problems
}

if (import.meta.main) {
  const markdown = readFileSync(resolve(root, ROSTER_SKILL_PATH), 'utf8')
  const catalog = defaultRoleContracts()
  const table = parseRosterRoleIds(markdown)
  const scenarios = parseScenarioRosters(markdown)
  const roleIdByName = roleIdsByDisplayName(catalog)
  const problems = rosterDrift(catalog.map(contract => contract.role), table)
  if (scenarios.length === 0) problems.push('找不到任何场景（`### 场景…`）段落')
  for (const scenario of scenarios) {
    problems.push(...scenarioRosterDrift(scenario, roleIdByName))
  }
  if (problems.length > 0) {
    console.error('verify-patent-team-roster failed:\n')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error(`\nUpdate ${ROSTER_SKILL_PATH} and packages/patent/patent-workflow/src/role-contracts.ts together.`)
    process.exit(1)
  }
  const owners = scenarios.reduce((total, scenario) => total + scenario.assignees.length, 0)
  console.log(`verify-patent-team-roster: ${catalog.length} roles agree between role-contracts.ts and the skill table; ${scenarios.length} scenario rosters agree across ${owners} task owner(s).`)
}
