/**
 * The boundary table for `verify-patent-team-roster`: which rows the parser
 * admits, the drift directions the gate must reject, and the scenario rosters
 * it holds to the registered display names. The last case runs the gate's own
 * functions over the shipped skill and the shipped catalog, so a green pair is
 * distinguishable from a parser that found no table at all.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defaultRoleContracts } from '@deepseek-ai/dsh-patent-workflow'
import { describe, expect, it } from 'vitest'
import {
  ROSTER_SKILL_PATH,
  parseRosterRoleIds,
  parseScenarioMemberNames,
  parseScenarioRosters,
  roleIdsByDisplayName,
  rosterDrift,
  scenarioRosterDrift,
} from './verify-patent-team-roster.ts'

const FIXTURE = [
  '## 角色总表',
  '',
  '| 角色 | role id | 立场 |',
  '|---|---|---|',
  '| 检索员 | `researcher` | 中立 |',
  '| 制图员 | `illustrator` | 中立（流程） |',
  '',
  '立场纪律：裁判角色不得参与任一方案略起草。',
  '',
  '## 场景角色包与任务 DAG',
  '',
  '| 任务 | 负责人 |',
  '|---|---|',
  '| t1 | 撰写员 |',
].join('\n')

const SCENARIO_FIXTURE = [
  '## 场景角色包与任务 DAG',
  '',
  '### 场景二：撰写包（7 成员）',
  '',
  '成员：检索员、撰写员、制图员（+ 技术调查官，高价值案件）。目标：交付。',
  '',
  '| 任务 | 主题 | 责任面 | 负责人 | 依赖 |',
  '|---|---|---|---|---|',
  '| t1 | 理解交底书 | 团队 | 撰写员 | — |',
  '| t2 | 跑 manifest | manifest | captain | t1 |',
  '',
  '### 场景六：无效宣告包（7 成员）',
  '',
  '成员：无效请求人、专利权人、合议组。',
  '',
  '| 任务 | 主题 | 负责人 | 依赖 |',
  '|---|---|---|---|',
  '| t1 | 裁决模拟 | 裁判 | — |',
].join('\n')

describe('parseRosterRoleIds', () => {
  it('reads the role table and stops at the next heading', () => {
    expect(parseRosterRoleIds(FIXTURE)).toEqual(['researcher', 'illustrator'])
  })

  it('returns nothing when the skill carries no role table', () => {
    expect(parseRosterRoleIds('## 别的章节\n\n| a | b |\n|---|---|\n')).toEqual([])
  })
})

describe('parseScenarioMemberNames', () => {
  it('reads required members and one optional parenthetical member', () => {
    expect(parseScenarioMemberNames('成员：检索员、撰写员（+ 技术调查官，高价值案件）。目标：交付。'))
      .toEqual(['检索员', '撰写员', '技术调查官'])
  })

  it('stops at the sentence end so the goal is not a member', () => {
    expect(parseScenarioMemberNames('成员：检索员、撰写员。目标：检索并撰写。'))
      .toEqual(['检索员', '撰写员'])
  })
})

describe('parseScenarioRosters', () => {
  it('reads each scenario roster and the owner column of its task table', () => {
    const scenarios = parseScenarioRosters(SCENARIO_FIXTURE)
    expect(scenarios.map(scenario => scenario.heading)).toEqual([
      '场景二：撰写包（7 成员）',
      '场景六：无效宣告包（7 成员）',
    ])
    expect(scenarios[0]?.members).toEqual(['检索员', '撰写员', '制图员', '技术调查官'])
    expect(scenarios[0]?.assignees).toEqual(['撰写员', 'captain'])
    expect(scenarios[1]?.assignees).toEqual(['裁判'])
  })

  it('keeps a scenario whose member line is missing', () => {
    const scenarios = parseScenarioRosters('### 场景一：立案包（5 成员）\n\n| 任务 | 负责人 |\n|---|---|\n| t1 | 检索员 |')
    expect(scenarios[0]?.members).toEqual([])
    expect(scenarios[0]?.assignees).toEqual(['检索员'])
  })
})

describe('rosterDrift', () => {
  it('reports a registered role missing from the table', () => {
    expect(rosterDrift(['researcher', 'illustrator'], ['researcher']))
      .toEqual(['角色总表缺少 "illustrator"（role-contracts.ts 已注册）'])
  })

  it('reports a table row with no registered role', () => {
    expect(rosterDrift(['researcher'], ['researcher', 'ghost']))
      .toEqual(['角色总表多出 "ghost"（role-contracts.ts 未注册）'])
  })

  it('reports nothing when the table and the catalog agree', () => {
    expect(rosterDrift(['researcher', 'illustrator'], ['illustrator', 'researcher'])).toEqual([])
  })
})

describe('roleIdsByDisplayName', () => {
  it('maps both slash aliases to the same role id', () => {
    const byName = roleIdsByDisplayName(defaultRoleContracts())
    expect(byName.get('合议组')).toBe('adjudicator')
    expect(byName.get('裁判')).toBe('adjudicator')
  })
})

describe('scenarioRosterDrift', () => {
  const byName = roleIdsByDisplayName(defaultRoleContracts())

  it('reports an unregistered member and an owner outside the member line', () => {
    expect(scenarioRosterDrift(
      { heading: '场景九：草案', members: ['检索员', '幽灵'], assignees: ['检索员', '撰写员', 'captain'] },
      byName,
    )).toEqual([
      '"场景九：草案" 的成员 "幽灵" 不是已注册角色名（role-contracts.ts）',
      '"场景九：草案" 的任务负责人 "撰写员" 不在该场景的成员行中',
    ])
  })

  it('reports a scenario with no member line', () => {
    expect(scenarioRosterDrift({ heading: '场景九：草案', members: [], assignees: [] }, byName))
      .toEqual(['"场景九：草案" 缺少“成员：”行'])
  })

  it('accepts a captain owner and exact member names', () => {
    expect(scenarioRosterDrift(
      { heading: '场景五：复审包', members: ['申请人代理', '合议组'], assignees: ['申请人代理', '合议组', 'captain'] },
      byName,
    )).toEqual([])
  })
})

describe('shipped roster', () => {
  it('matches the registered roles and scenario rosters', () => {
    const markdown = readFileSync(resolve(import.meta.dirname, '..', ROSTER_SKILL_PATH), 'utf8')
    const catalog = defaultRoleContracts()
    const table = parseRosterRoleIds(markdown)
    const scenarios = parseScenarioRosters(markdown)
    const roleIdByName = roleIdsByDisplayName(catalog)
    expect(table.length).toBeGreaterThan(0)
    expect(rosterDrift(catalog.map(contract => contract.role), table)).toEqual([])
    expect(scenarios.length).toBeGreaterThanOrEqual(7)
    for (const scenario of scenarios) {
      expect(scenarioRosterDrift(scenario, roleIdByName)).toEqual([])
    }
  })
})
