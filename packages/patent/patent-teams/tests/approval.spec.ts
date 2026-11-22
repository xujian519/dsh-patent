/**
 * The approval seam for the two gated team mutations: the promise settles only on a
 * grant, and a deployment that mounts no answerer refuses the mutation instead of
 * creating or closing a team unapproved.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
// Type-only: makes `ctx.provide('approval', …)` and `ctx.get('approval')` resolve.
import type { ApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { requireTeamApproval, TeamApprovalError, type TeamApprovalAsk } from '../src/approval.ts'

/** The captain stand-in: the seam forwards the agent without reading it. */
type ToolAgent = NonNullable<ToolExecutionInput['agent']>

/**
 * @param id - the identity to carry.
 * @returns an agent stand-in carrying that id.
 */
function fakeAgent(id: string): ToolAgent {
  return { id: SessionId(id) } as ToolAgent
}

const CAPTAIN = fakeAgent('captain-1')
const SIGNAL = new AbortController().signal
const CREATE_REASON = '创建专利团队「Alpha」：团队方案（成员与任务分工）需用户确认后建队'

/**
 * @param overrides - ask fields to replace.
 * @returns one ask over `patent_teams_create` carrying every forwarded field.
 */
function ask(overrides: Partial<TeamApprovalAsk> = {}): TeamApprovalAsk {
  return {
    agent: CAPTAIN,
    toolName: 'patent_teams_create',
    callId: ToolCallId('call-1'),
    reason: CREATE_REASON,
    signal: SIGNAL,
    ...overrides,
  }
}

/**
 * @param outcome - the decision the fake answerer returns, or `'throws'` for an answerer failure.
 * @param policy - the effective approval policy the fake service reports.
 * @returns a context carrying that answerer, its spy, and the policy spy.
 */
function contextWithAnswerer(
  outcome: ApprovalOutcome | 'throws',
  policy: ApprovalPolicy = 'ask',
): { ctx: Context; request: ReturnType<typeof vi.fn>; policyOf: ReturnType<typeof vi.fn> } {
  const ctx = new Context()
  const request = vi.fn(() => outcome === 'throws'
    ? Promise.reject(new Error('answerer exploded'))
    : Promise.resolve(outcome))
  const policyOf = vi.fn(() => policy)
  ctx.provide('approval', { request, policyOf } as never)
  return { ctx, request, policyOf }
}

/**
 * @param body - the seam call under test.
 * @returns the refusal it raised.
 */
async function refusalFrom(body: () => Promise<void>): Promise<TeamApprovalError> {
  try {
    await body()
  } catch (error) {
    if (error instanceof TeamApprovalError) return error
    throw error
  }
  throw new Error('expected the seam to refuse')
}

describe('requireTeamApproval', () => {
  it('forwards the ask to the mounted answerer and settles on a grant', async () => {
    const { ctx, request } = contextWithAnswerer('allowed-once')
    await requireTeamApproval(ctx, ask())
    expect(request).toHaveBeenCalledWith({
      agent: CAPTAIN,
      toolName: 'patent_teams_create',
      callId: 'call-1',
      reason: CREATE_REASON,
      signal: SIGNAL,
    })
  })

  it.each(['rejected', 'cancelled', 'unavailable'] as const)('refuses the mutation on %s', async (outcome) => {
    const { ctx } = contextWithAnswerer(outcome)
    const refusal = await refusalFrom(() => requireTeamApproval(ctx, ask()))
    expect(refusal.outcome).toBe(outcome)
    expect(refusal.message).toContain('本次操作未执行')
  })

  it('names a never policy as an automatic refusal, not a user rejection', async () => {
    const { ctx } = contextWithAnswerer('rejected', 'never')
    const refusal = await refusalFrom(() => requireTeamApproval(ctx, ask()))
    expect(refusal.outcome).toBe('rejected')
    expect(refusal.message).toContain('审批策略为 never')
    expect(refusal.message).toContain('这不是用户对本次操作的否决')
  })

  it('refuses when the deployment mounts no answerer', async () => {
    const ctx = new Context()
    const refusal = await refusalFrom(() => requireTeamApproval(ctx, ask()))
    expect(refusal.outcome).toBe('unavailable')
    expect(refusal.message).toContain('未挂载审批服务')
  })

  it('propagates an answerer failure instead of reading it as a grant', async () => {
    const { ctx } = contextWithAnswerer('throws')
    await expect(requireTeamApproval(ctx, ask())).rejects.toThrow('answerer exploded')
  })
})
