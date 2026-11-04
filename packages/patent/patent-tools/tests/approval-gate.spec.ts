// Live approval gate: the stage either obtains a grant from the deployment's
// approval service or pauses the run with the decision it got. Every path is
// fail-closed, so a missing service and a throwing request both refuse.

import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalPolicy, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { APPROVAL_GRANTED_KEY, InterruptStageError } from '@deepseek-ai/dsh-patent-core'
import { LiveApprovalGateHandler, type ApprovalFace } from '../src/tool/internal/approval-gate.ts'

// The gate only forwards the agent to the approval service; its id is the only
// field this unit reads.
const agent = { id: SessionId('sess-1') } as Agent

/** An approval face that records the requests it receives. */
function face(
  outcome: ApprovalOutcome,
  policy: ApprovalPolicy = 'ask',
): ApprovalFace & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = []
  return {
    requests,
    policyOf: () => policy,
    request: async (request) => {
      requests.push(request)
      return outcome
    },
  }
}

/** Run one gate with the given service lookup and state. */
function runGate(
  service: () => ApprovalFace | undefined,
  state: Record<string, unknown> = { review_context: '权利要求布局需人工确认' },
): ReturnType<LiveApprovalGateHandler['execute']> {
  return new LiveApprovalGateHandler({
    agent,
    callId: ToolCallId('call-1'),
    manifestId: 'patent_patentability_v1',
    service,
  }).execute({ state })
}

async function refusal(promise: Promise<unknown>): Promise<InterruptStageError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(InterruptStageError)
    return error as InterruptStageError
  }
  throw new Error('expected the gate to interrupt')
}

describe('LiveApprovalGateHandler', () => {
  it('returns the grant marker when the user allows once', async () => {
    const service = face('allowed-once')
    const delta = await runGate(() => service)
    expect(delta).toEqual({ [APPROVAL_GRANTED_KEY]: true })
    expect(service.requests).toHaveLength(1)
    const request = service.requests[0]!
    expect(request.agent).toBe(agent)
    expect(request.toolName).toBe('patent_workflow_run')
    expect(request.callId).toBe('call-1')
    expect(request.reason).toContain('patent_patentability_v1')
    expect(request.reason).toContain('权利要求布局需人工确认')
  })

  it('falls back to a generic review context when the stage carries none', async () => {
    const service = face('allowed-once')
    await runGate(() => service, {})
    expect(service.requests[0]?.reason).toContain('该阶段产出需要人工确认')
  })

  it('quotes the pending deliverables named by review_keys', async () => {
    const service = face('allowed-once')
    await runGate(() => service, {
      review_context: '答复书需人工确认',
      review_keys: ['draft', 'legal_gaps'],
      draft: '第一段正文。\n第二段正文。',
      legal_gaps: '缺口：无。',
    })
    const reason = service.requests[0]?.reason ?? ''
    expect(reason).toContain('待确认产出：draft：第一段正文。 第二段正文。；legal_gaps：缺口：无。')
  })

  it('skips review keys that carry no text', async () => {
    const service = face('allowed-once')
    await runGate(() => service, {
      review_context: '布局需确认',
      review_keys: [42, 'missing', 'blank', 'draft'],
      blank: '   ',
      draft: '正文',
    })
    const reason = service.requests[0]?.reason ?? ''
    expect(reason).toContain('draft：正文')
    expect(reason).not.toContain('missing')
    expect(reason).not.toContain('blank')
  })

  it('caps previews at two keys and truncates a long deliverable', async () => {
    const service = face('allowed-once')
    await runGate(() => service, {
      review_context: '权利要求布局需人工确认',
      review_keys: ['a', 'b', 'c'],
      a: 'x'.repeat(200),
      b: 'y',
      c: 'z',
    })
    const reason = service.requests[0]?.reason ?? ''
    expect(reason).toContain(`a：${'x'.repeat(140)}…`)
    expect(reason).toContain('b：y')
    expect(reason).not.toContain('c：z')
  })

  it('does not ask when the executor already injected the grant marker', async () => {
    const service = face('rejected')
    const delta = await runGate(() => service, { [APPROVAL_GRANTED_KEY]: true })
    expect(delta).toEqual({})
    expect(service.requests).toHaveLength(0)
  })

  it('pauses with the refusal outcome when the user rejects', async () => {
    const error = await refusal(runGate(() => face('rejected')))
    expect(error.stageId).toBe('approval-gate')
    expect(error.message).toContain('未放行')
    expect(error.message).toContain('rejected')
    expect(error.data).toEqual({ outcome: 'rejected' })
  })

  it('names a never policy as an automatic refusal', async () => {
    const error = await refusal(runGate(() => face('rejected', 'never')))
    expect(error.message).toContain('never')
    expect(error.message).toContain('不要重复调用')
  })

  it('refuses when the approval service is unavailable at the gate', async () => {
    const error = await refusal(runGate(() => undefined))
    expect(error.message).toContain('审批服务在运行中不可用')
    expect(error.message).toContain('关闭 approveStageGates')
    expect(error.data).toEqual({ outcome: 'unavailable' })
  })

  it('refuses when the approval request itself fails', async () => {
    const service = face('rejected')
    service.request = async () => {
      throw new Error('approval.request() outside an open turn')
    }
    const error = await refusal(runGate(() => service))
    expect(error.message).toContain('无法取得审批')
    expect(error.message).toContain('outside an open turn')
    expect(error.data).toEqual({ outcome: 'unavailable' })
  })
})
