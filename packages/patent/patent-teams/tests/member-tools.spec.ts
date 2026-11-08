import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BASELINE_MEMBER_TOOLS, memberToolAllowList } from '../src/members.ts'

/** A context whose `tools` service reports exactly the given restrictable names. */
function ctxWith(names: readonly string[] | undefined): Context {
  const ctx = new Context()
  if (names !== undefined) ctx.provide('tools', { restrictableNames: () => new Set(names) } as never)
  return ctx
}

describe('memberToolAllowList', () => {
  it('keeps the deny-only surface for a member without a role', () => {
    expect(memberToolAllowList(ctxWith(['read', 'patent_search', 'mcp__cnlaw__search']), undefined)).toBeUndefined()
  })

  it('keeps the deny-only surface when the composition has no tools service', () => {
    expect(memberToolAllowList(ctxWith(undefined), 'researcher')).toBeUndefined()
  })

  it('keeps the deny-only surface for an unregistered role', () => {
    expect(memberToolAllowList(ctxWith(['read', 'mcp__cnlaw__search']), 'no-such-role')).toBeUndefined()
  })

  it("still trims to the baseline when none of the role's own tools are mounted", () => {
    // `researcher` declares patent_search/patent_metadata/…; none are mounted here,
    // so the member keeps the shared surface and gains no domain tool.
    expect(memberToolAllowList(ctxWith(['read', 'bash', 'mcp__cnlaw__search']), 'researcher'))
      .toEqual([
        'read',
        'bash',
        'mcp__cnlaw__search',
        'patent_teams_claim_task',
        'patent_teams_update_task',
        'patent_teams_send_message',
        'patent_teams_status',
      ])
  })

  it('keeps the deny-only surface when the cnlaw MCP tools are absent', () => {
    // The persona requires verifying statutes through cnlaw; a trimmed member
    // that cannot reach it would be told to use a tool it lacks.
    expect(memberToolAllowList(ctxWith(['read', 'bash', 'patent_search']), 'researcher')).toBeUndefined()
  })

  it('grants the baseline, the cnlaw tools, and the role tools that exist here', () => {
    const allow = memberToolAllowList(
      ctxWith(['read', 'bash', 'write', 'patent_search', 'patent_metadata', 'mcp__cnlaw__search']),
      'researcher',
    )

    expect(allow).toEqual([
      'read',
      'write',
      'bash',
      'mcp__cnlaw__search',
      'patent_search',
      'patent_metadata',
      'patent_teams_claim_task',
      'patent_teams_update_task',
      'patent_teams_send_message',
      'patent_teams_status',
    ])
    // A declared tool this composition does not register is dropped, not passed
    // to `tools.restrict()`, which rejects unknown names at member creation.
    expect(allow).not.toContain('web_search')
  })

  it('keeps the coordination channel even when the queried view omits it', () => {
    const allow = memberToolAllowList(ctxWith(['read', 'mcp__cnlaw__search']), 'researcher')

    expect(allow).toEqual([
      'read',
      'mcp__cnlaw__search',
      'patent_teams_claim_task',
      'patent_teams_update_task',
      'patent_teams_send_message',
      'patent_teams_status',
    ])
  })

  it('drops a denied name even when the queried view reports it', () => {
    const allow = memberToolAllowList(
      ctxWith(['read', 'mcp__cnlaw__search', 'patent_teams_create', 'send_message']),
      'researcher',
    )

    expect(allow).not.toContain('patent_teams_create')
    expect(allow).not.toContain('send_message')
  })

  it('never grants a captain-only team tool or an unlisted tool', () => {
    const allow = memberToolAllowList(
      ctxWith(['read', 'bash', 'mcp__cnlaw__search', 'patent_search', 'patent_teams_create', 'ask_user_question']),
      'researcher',
    )

    expect(allow).not.toContain('patent_teams_create')
    expect(allow).not.toContain('ask_user_question')
    expect(allow?.every(name => name !== 'patent_teams_create')).toBe(true)
  })

  it('shares one baseline across roles', () => {
    const names = ['read', 'bash', ...BASELINE_MEMBER_TOOLS, 'mcp__cnlaw__search', 'patent_search', 'patent_eval', 'patent_metadata']
    const researcher = memberToolAllowList(ctxWith(names), 'researcher')
    const reviewer = memberToolAllowList(ctxWith(names), 'adversarial-reviewer')

    const shared = BASELINE_MEMBER_TOOLS.filter(name => researcher?.includes(name) && reviewer?.includes(name))
    expect(shared).toEqual(BASELINE_MEMBER_TOOLS.filter(name => names.includes(name)))
    expect(researcher).not.toEqual(reviewer)
  })
})
