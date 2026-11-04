// Tool registration: all twelve patent_teams_* tools register through a stub
// tools registry and route parsed args to a fake service; render output is
// asserted directly, including the rich status snapshot text.
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it, vi } from 'vitest'
import { TeamApprovalError } from '../src/approval.ts'
import { PATENT_TEAMS_TOOL_NAMES, registerPatentTeamsTools, type PatentTeamsToolOptions } from '../src/tools.ts'
import type { PatentTeamsArchive, PatentTeamsStatus } from '../src/service.ts'

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: unknown; render: (args: unknown, value: unknown) => Array<{ type: string; text: string }> }
  execute: (args: never, exec: { agent?: Agent; signal: AbortSignal; callId?: ToolCallId }) => Promise<unknown>
}

function makeService() {
  return {
    create: vi.fn(async () => ({ team_id: 'alpha', team_name: 'Alpha', state_dir: '/tmp/alpha' })),
    addMember: vi.fn(async () => ({ member_name: 'alice', member_id: 'm1', provider: 'p', model: 'm', reasoning_effort: 'high', status: 'idle' })),
    removeMember: vi.fn(async () => ({ member_name: 'alice', status: 'removed', requeued_tasks: ['t1'] })),
    createTask: vi.fn(async () => ({ task_id: 't1', subject: 'research', status: 'pending', assignee: 'alice' })),
    reassignTask: vi.fn(async () => ({ task_id: 't1', previous_assignee: 'alice', assignee: 'captain', status: 'claimed', attempt: 2, attempt_id: 'a2' })),
    claimTask: vi.fn(async () => ({ task_id: 't1', status: 'claimed', assignee: 'alice', attempt: 1, attempt_id: 'a1' })),
    updateTask: vi.fn(async () => ({ task_id: 't1', status: 'completed', output: 'done', attempt: 1, attempt_id: 'a1' })),
    sendMessage: vi.fn(async () => ({ message_id: 'm1', from: 'alice', to: 'captain', delivered: 'mailbox' })),
    wait: vi.fn(async () => ({ timed_out: false })),
    status: vi.fn(async () => sampleStatus()),
    archive: vi.fn(async () => sampleArchiveDetail()),
    delete: vi.fn(async () => ({ deleted: true, team_name: 'Alpha' })),
  }
}

function sampleArchiveDetail(): PatentTeamsArchive {
  return {
    mode: 'detail',
    team: {
      team_id: 'alpha',
      team_name: 'Alpha',
      created_at: 1000,
      members: [
        { name: 'alice', role: 'researcher' },
        { name: 'bob', role: '' },
      ],
      tasks: [
        { id: 't1', subject: 'search prior art', status: 'completed', assignee: 'alice', dependencies: [], output: 'z'.repeat(400) },
        { id: 't2', subject: 'draft claims', status: 'cancelled', assignee: '', dependencies: ['t1'] },
      ],
    },
  }
}

function sampleStatus(): PatentTeamsStatus {
  return {
    team_id: 'alpha',
    team_name: 'Alpha',
    description: 'Goal: novelty',
    viewer: 'captain',
    members: [
      { name: 'alice', role: 'researcher', provider: 'spawn', model: 'm1', reasoning_effort: 'high', status: 'working', activity: 'running' },
      { name: 'bob', role: '', provider: '', model: '', reasoning_effort: '', status: 'idle', activity: 'ready' },
    ],
    tasks: [
      { id: 't1', subject: 'search prior art', status: 'in_progress', assignee: 'alice', dependencies: ['t0'], attempt: 2, attempt_id: 'a2', reassigning: false, output: 'x'.repeat(400) },
      { id: 't2', subject: 'draft claims', status: 'pending', assignee: '', dependencies: [], attempt: 0, attempt_id: '', reassigning: true },
    ],
    captain_inbox: [
      { from: 'alice', content: 'finished the search' + 'y'.repeat(250), ts: 1 },
    ],
    captain_inbox_omitted: 0,
    captain_inbox_leased: 0,
    member_inboxes: {
      bob: { count: 1, leased: 0, omitted: 0, latest: 'please review' },
    },
    mailbox_warnings: ['bob mailbox line 3', 'bob mailbox line 9'],
    mailbox_warning_count: 2,
  }
}

function makeAgent(id = 'captain-1'): Agent {
  return { id } as unknown as Agent
}

function register(
  ctx: Context,
  service: ReturnType<typeof makeService>,
  options: PatentTeamsToolOptions = { approveCreation: false, approveClosure: false },
): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  ctx.provide('tools', {
    register: (definition: ToolDefinition) => {
      tools.set(definition.name, definition)
      return () => {}
    },
  } as never)
  ctx.provide('patentTeams', service as never)
  registerPatentTeamsTools(ctx, options)
  return tools
}

describe('registerPatentTeamsTools', () => {
  it('registers every patent_teams_* tool', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    expect([...tools.keys()]).toEqual([...PATENT_TEAMS_TOOL_NAMES])
    expect(tools.get('patent_teams_create')!.description).toContain('Create a new PatentTeams team')
  })

  it('routes each tool execution to the service with the calling agent', async () => {
    const ctx = new Context()
    const service = makeService()
    const tools = register(ctx, service)
    const exec = { agent: makeAgent('captain-1'), signal: new AbortController().signal }

    await tools.get('patent_teams_create')!.execute({ name: 'Alpha', description: 'goal' } as never, exec)
    expect(service.create).toHaveBeenCalledWith(exec.agent, 'Alpha', 'goal')

    await tools.get('patent_teams_add_member')!.execute({ name: 'alice', role: 'researcher' } as never, exec)
    expect(service.addMember).toHaveBeenCalledWith(exec.agent, { name: 'alice', role: 'researcher' }, exec.signal)

    await tools.get('patent_teams_remove_member')!.execute({ name: 'alice' } as never, exec)
    expect(service.removeMember).toHaveBeenCalledWith(exec.agent, 'alice', exec.signal)

    await tools.get('patent_teams_create_task')!.execute({ subject: 'research', dependencies: ['t0'] } as never, exec)
    expect(service.createTask).toHaveBeenCalledWith(exec.agent, { subject: 'research', dependencies: ['t0'] }, exec.signal)

    await tools.get('patent_teams_reassign_task')!.execute({ task_id: 't1', assignee: 'captain' } as never, exec)
    expect(service.reassignTask).toHaveBeenCalledWith(exec.agent, { task_id: 't1', assignee: 'captain' }, exec.signal)

    await tools.get('patent_teams_claim_task')!.execute({ task_id: 't1', assignee: 'alice' } as never, exec)
    expect(service.claimTask).toHaveBeenCalledWith(exec.agent, { task_id: 't1', assignee: 'alice' })

    await tools.get('patent_teams_update_task')!.execute({ task_id: 't1', status: 'completed', output: 'done' } as never, exec)
    expect(service.updateTask).toHaveBeenCalledWith(exec.agent, { task_id: 't1', status: 'completed', output: 'done' }, exec.signal)

    await tools.get('patent_teams_send_message')!.execute({ to: 'captain', content: 'hi' } as never, exec)
    expect(service.sendMessage).toHaveBeenCalledWith(exec.agent, { to: 'captain', content: 'hi' }, exec.signal)

    await tools.get('patent_teams_status')!.execute({} as never, exec)
    expect(service.status).toHaveBeenCalledWith(exec.agent, exec.signal)

    await tools.get('patent_teams_archive')!.execute({ team_id: 'alpha' } as never, exec)
    expect(service.archive).toHaveBeenCalledWith(exec.agent, 'alpha')
    await tools.get('patent_teams_archive')!.execute({} as never, exec)
    expect(service.archive).toHaveBeenCalledWith(exec.agent, undefined)

    await tools.get('patent_teams_delete')!.execute({} as never, exec)
    expect(service.delete).toHaveBeenCalledWith(exec.agent, exec.signal)
  })

  it('fails loud when a tool runs without a calling agent', async () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const exec = { signal: new AbortController().signal } as unknown as ToolRunContext
    await expect(tools.get('patent_teams_create')!.execute({ name: 'Alpha' } as never, exec))
      .rejects.toThrow('patent_teams tools require a calling agent (exec.agent was undefined)')
  })

  it('renders plain result texts', async () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const render = (name: string, value: unknown): string => {
      const output = tools.get(name)!.output
      return output.render({}, value as never).map(block => block.text).join('\n')
    }
    expect(render('patent_teams_create', { team_id: 'alpha', team_name: 'Alpha', state_dir: '/tmp/alpha' }))
      .toBe('Team "Alpha" created (id alpha) under /tmp/alpha. You are the captain.')
    expect(render('patent_teams_add_member', { member_name: 'alice', member_id: 'm1', provider: 'p', model: 'm', reasoning_effort: 'high', status: 'idle' }))
      .toContain('Member "alice" added (subagent id m1, p/m, reasoning high, status idle).')
    expect(render('patent_teams_remove_member', { member_name: 'alice', status: 'removed', requeued_tasks: ['t1', 't2'] }))
      .toContain('Member "alice" removed (status removed); requeued tasks: t1, t2.')
    expect(render('patent_teams_remove_member', { member_name: 'bob', status: 'removed', requeued_tasks: [] }))
      .toContain('requeued tasks: none.')
    expect(render('patent_teams_create_task', { task_id: 't1', subject: 'research', status: 'pending', assignee: 'alice' }))
      .toContain('Task "research" created as t1 (status pending, assigned to alice).')
    expect(render('patent_teams_create_task', { task_id: 't2', subject: 'draft', status: 'pending' }))
      .toContain('Task "draft" created as t2 (status pending).')
    expect(render('patent_teams_add_member', { member_name: 'carol', member_id: 'm3', provider: 'p', model: 'm', status: 'idle' }))
      .toContain('Member "carol" added (subagent id m3, p/m, status idle).')
    expect(render('patent_teams_reassign_task', { task_id: 't1', previous_assignee: 'alice', assignee: 'captain', status: 'claimed', attempt: 2, attempt_id: 'a2' }))
      .toContain('Task t1 reassigned alice → captain (attempt 2, status claimed, attempt_id a2).')
    expect(render('patent_teams_reassign_task', { task_id: 't2', previous_assignee: '', assignee: 'bob', status: 'pending', attempt: 1 }))
      .toContain('Task t2 reassigned unassigned → bob (attempt 1, status pending).')
    expect(render('patent_teams_claim_task', { task_id: 't1', status: 'claimed', assignee: 'alice', attempt: 1, attempt_id: 'a1' }))
      .toContain('Task t1 claimed by alice (attempt 1, attempt_id a1, status claimed).')
    expect(render('patent_teams_claim_task', { task_id: 't2', status: 'claimed', assignee: 'bob', attempt: 2 }))
      .toContain('Task t2 claimed by bob (attempt 2, status claimed).')
    expect(render('patent_teams_update_task', { task_id: 't1', status: 'completed', output: 'done', attempt: 1 }))
      .toContain('Task t1 attempt 1 → completed\nOutput: done')
    expect(render('patent_teams_update_task', { task_id: 't2', status: 'failed', attempt: 1 }))
      .toContain('Task t2 attempt 1 → failed')
    expect(render('patent_teams_send_message', { message_id: 'm1', from: 'alice', to: 'captain', delivered: 'mailbox' }))
      .toContain('Message m1 alice → captain delivered via mailbox.')
    expect(render('patent_teams_archive', { mode: 'list', teams: [] }))
      .toBe('No archived teams in this workspace.')
    expect(render('patent_teams_archive', {
      mode: 'list',
      teams: [
        { team_id: 'alpha', team_name: 'Alpha', created_at: 1, members: 2, tasks: 3, completed_tasks: 1 },
        { team_id: 'beta', team_name: 'Beta', created_at: 2, members: 1, tasks: 0, completed_tasks: 0 },
      ],
    }))
      .toContain('  - alpha "Alpha" (1/3 tasks completed, 2 members)')
    expect(render('patent_teams_archive', sampleArchiveDetail()))
      .toContain('Archived team "Alpha" (id alpha)')
    expect(render('patent_teams_archive', sampleArchiveDetail()))
      .toContain('  - alice [researcher]')
    expect(render('patent_teams_archive', sampleArchiveDetail()))
      .toContain('  - bob')
    expect(render('patent_teams_archive', sampleArchiveDetail()))
      .toContain('  - t1 [completed] search prior art → alice')
    expect(render('patent_teams_archive', sampleArchiveDetail()))
      .toContain(`output: ${'z'.repeat(300)}`)
    expect(render('patent_teams_delete', { deleted: true, team_name: 'Alpha' }))
      .toBe('Team "Alpha" deleted.')
  })

  it('renders the full status snapshot text', async () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status = sampleStatus()
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).toContain('Team "Alpha" — Goal: novelty')
    expect(text).toContain('Viewing as: captain')
    expect(text).toContain('Members (2):')
    expect(text).toContain('  - alice [researcher] working/running · spawn/m1 · reasoning high')
    expect(text).toContain('  - bob [] idle/ready')
    expect(text).toContain('Tasks (2):')
    expect(text).toContain('  - t1 [in_progress] attempt 2 search prior art → alice (deps: t0)')
    expect(text).toContain('output: ' + 'x'.repeat(300))
    expect(text).not.toContain('x'.repeat(301))
    expect(text).toContain('  - t2 [pending] attempt 0 (reassigning) draft claims → unassigned')
    expect(text).toContain('Captain inbox (1):')
    expect(text).toContain('  - [alice] finished the search' + 'y'.repeat(250))
    expect(text).not.toContain('y'.repeat(251))
    expect(text).toContain('Member inbox bob (1): latest — please review')
    expect(text).toContain('Mailbox warnings (2; malformed lines were skipped; showing up to 10):')
    expect(text).toContain('  - bob mailbox line 3')
    expect(text).toContain('  - bob mailbox line 9')
  })

  it('renders omitted counts and a member inbox page', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status = sampleStatus()
    status.viewer = 'alice'
    status.captain_inbox_omitted = 2
    status.captain_inbox_leased = 3
    status.member_inboxes = {
      alice: {
        count: 12,
        leased: 1,
        omitted: 2,
        messages: [
          { from: 'captain', content: 'first', ts: 1 },
          { from: 'captain', content: 'second', ts: 2 },
        ],
      },
    }
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).toContain('Captain inbox (1, 3 in delivery, 2 older omitted):')
    expect(text).toContain('Member inbox alice (12, 1 in delivery, 2 omitted):')
    expect(text).toContain('  - [captain] first')
    expect(text).toContain('  - [captain] second')
  })

  it('renders an inbox whose only messages are waiting for delivery', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status = sampleStatus()
    status.captain_inbox = []
    status.captain_inbox_leased = 2
    status.member_inboxes = { bob: { count: 0, leased: 1, omitted: 0 } }
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).toContain('Captain inbox (0, 2 in delivery):')
    expect(text).toContain('Member inbox bob (0, 1 in delivery):')
    expect(text).not.toContain('latest — ')
  })

  it('renders a status without optional fields', async () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const minimal: PatentTeamsStatus = {
      team_id: 'a', team_name: 'A', description: '', viewer: 'alice',
      members: [{ name: 'alice', role: '', provider: '', model: '', reasoning_effort: '', status: 'idle', activity: 'unspawned' }],
      tasks: [{ id: 't1', subject: 's', status: 'pending', assignee: '', dependencies: [], attempt: 0, attempt_id: '', reassigning: false }],
      captain_inbox: [], captain_inbox_omitted: 0, captain_inbox_leased: 0,
      member_inboxes: {}, mailbox_warnings: [], mailbox_warning_count: 0,
    }
    const text = tools.get('patent_teams_status')!.output.render({}, minimal)
      .map(block => block.text).join('\n')
    expect(text).toContain('Team "A"')
    expect(text).toContain('  - alice [] idle/unspawned')
    expect(text).toContain('  - t1 [pending] attempt 0 s → unassigned')
    expect(text).toContain('Captain inbox (0):')
  })

  it('renders role contract and quality-gate annotations', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status: PatentTeamsStatus = {
      team_id: 'alpha', team_name: 'Alpha', description: '', viewer: 'captain',
      members: [{
        name: 'alice', role: 'researcher', provider: 'spawn', model: 'm1', reasoning_effort: 'high',
        status: 'idle', activity: 'idle', role_contract: { stance: 'neutral', deliverables: '检索式、对比文件、公开日、命名族清单、正交维度' },
      }],
      tasks: [
        { id: 't1', subject: 'ok', status: 'completed', assignee: 'alice', dependencies: [], attempt: 1, attempt_id: 'a1', reassigning: false, output: 'x', worker: 'patent-search-commander', contract_validation: { valid: true, missing_hard_fields: [], degraded: false } },
        { id: 't2', subject: 'bad', status: 'in_progress', assignee: 'alice', dependencies: [], attempt: 1, attempt_id: 'a2', reassigning: false, output: 'y', worker: 'patent-search-commander', gate_feedback: { score: 0.4, satisfied: false, failures: ['质量评分:0.40/1.0 未达 0.70', '内容充分性(0.10)'], feedback: 'revise' }, gate_rejections: 3 },
      ],
      captain_inbox: [], captain_inbox_omitted: 0, captain_inbox_leased: 0,
      member_inboxes: {}, mailbox_warnings: [], mailbox_warning_count: 0,
    }
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).toContain('role: neutral (交付: 检索式、对比文件、公开日、命名族清单、正交维度)')
    expect(text).toContain('worker: patent-search-commander')
    expect(text).toContain('contract: ok')
    expect(text).toContain('gated ×3: 0.40 (质量评分:0.40/1.0 未达 0.70、内容充分性(0.10))')
  })

  it('renders a degraded contract validation', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status: PatentTeamsStatus = {
      team_id: 'alpha', team_name: 'Alpha', description: '', viewer: 'captain',
      members: [],
      tasks: [{
        id: 't1', subject: 'bad', status: 'completed', assignee: 'alice', dependencies: [],
        attempt: 1, attempt_id: 'a1', reassigning: false, output: 'x', worker: 'patent-search-commander',
        contract_validation: { valid: false, missing_hard_fields: ['公开日', '对比文件'], degraded: true },
      }],
      captain_inbox: [], captain_inbox_omitted: 0, captain_inbox_leased: 0,
      member_inboxes: {}, mailbox_warnings: [], mailbox_warning_count: 0,
    }
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).toContain('contract: degraded(公开日、对比文件)')
  })

  it('renders no gate annotation for satisfied feedback and an empty member preview', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status: PatentTeamsStatus = {
      team_id: 'alpha', team_name: 'Alpha', description: '', viewer: 'captain',
      members: [],
      tasks: [{
        id: 't1', subject: 'ok', status: 'in_progress', assignee: 'alice', dependencies: [],
        attempt: 1, attempt_id: 'a1', reassigning: false, output: 'x',
        gate_feedback: { score: 1, satisfied: true, failures: [], feedback: '' },
      }],
      captain_inbox: [], captain_inbox_omitted: 0, captain_inbox_leased: 0,
      member_inboxes: { bob: { count: 0, leased: 0, omitted: 0 } },
      mailbox_warnings: [], mailbox_warning_count: 0,
    }
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).not.toContain('gated')
    expect(text).toContain('Member inbox bob (0):')
    expect(text).not.toContain('latest — ')
  })

  it('renders a status gate annotation with the default rejection count', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const status: PatentTeamsStatus = {
      team_id: 'alpha', team_name: 'Alpha', description: '', viewer: 'captain',
      members: [],
      tasks: [{
        id: 't1', subject: 'bad', status: 'in_progress', assignee: 'alice', dependencies: [],
        attempt: 1, attempt_id: 'a1', reassigning: false,
        gate_feedback: { score: 0.2, satisfied: false, failures: ['内容充分性'], feedback: 'revise' },
      }],
      captain_inbox: [], captain_inbox_omitted: 0, captain_inbox_leased: 0,
      member_inboxes: {}, mailbox_warnings: [], mailbox_warning_count: 0,
    }
    const text = tools.get('patent_teams_status')!.output.render({}, status)
      .map(block => block.text).join('\n')
    expect(text).toContain('gated ×1: 0.20 (内容充分性)')
  })

  it('renders a gated update without recorded details', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const text = tools.get('patent_teams_update_task')!.output.render({}, {
      task_id: 't1', status: 'in_progress', attempt: 1, gated: true,
    }).map(block => block.text).join('\n')
    expect(text).toContain('未过质量门禁（第 1 次被打回；保持 in_progress）')
  })

  it('renders a gated update result', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const text = tools.get('patent_teams_update_task')!.output.render({}, {
      task_id: 't1', status: 'in_progress', attempt: 1, gated: true, gate_feedback: 'revise', gate_rejections: 2,
    }).map(block => block.text).join('\n')
    expect(text).toContain('未过质量门禁（第 2 次被打回；保持 in_progress）')
    expect(text).toContain('revise')
  })

  it('reports the accumulated rejection count on an accepted update', () => {
    const ctx = new Context()
    const tools = register(ctx, makeService())
    const text = tools.get('patent_teams_update_task')!.output.render({}, {
      task_id: 't1', status: 'completed', attempt: 1, gate_rejections: 2, output: 'done',
    }).map(block => block.text).join('\n')
    expect(text).toContain('累计被打回 2 次')
  })
})

describe('patent_teams_wait', () => {
  it('defaults the timeout and forwards the caller to the service', async () => {
    const ctx = new Context()
    const service = makeService()
    const tools = register(ctx, service)
    const signal = new AbortController().signal
    const agent = makeAgent()
    const result = await tools.get('patent_teams_wait')!.execute({} as never, { agent, signal })
    expect(service.wait).toHaveBeenCalledWith(agent, 30_000, signal)
    expect(result).toEqual({ timed_out: false })
    expect(tools.get('patent_teams_wait')!.output.render({}, result)[0]!.text)
      .toBe('Team change observed. Re-read patent_teams_status for the authoritative state.')
  })

  it('forwards an explicit timeout', async () => {
    const ctx = new Context()
    const service = makeService()
    const tools = register(ctx, service)
    await tools.get('patent_teams_wait')!.execute(
      { timeout_ms: 600_000 } as never,
      { agent: makeAgent(), signal: new AbortController().signal },
    )
    expect(service.wait).toHaveBeenCalledWith(expect.anything(), 600_000, expect.anything())
  })

  it('explains a timeout as a decision point, not a reason to wait again', async () => {
    const tool = register(new Context(), makeService()).get('patent_teams_wait')!
    const [rendered] = tool.output.render({}, { timed_out: true })
    expect(rendered!.text).toContain('No team change within the wait window')
    expect(tool.parameters).toHaveProperty('properties.timeout_ms')
    expect(tool.description).toContain('Captain only')
  })
})

// The two approval switches: the mutation asks the mounted answerer first, proceeds
// only on a grant, and stays ask-free while the deployment leaves the switch off.
describe('approval gates', () => {
  /** An approval service whose request resolves with `outcome`. */
  function answerWith(outcome: 'allowed-once' | 'rejected' | 'cancelled') {
    const request = vi.fn(async (_ask: ApprovalRequest) => outcome)
    return { request, policyOf: vi.fn(() => 'ask' as const) }
  }

  function exec() {
    return { agent: makeAgent(), signal: new AbortController().signal, callId: ToolCallId('call-1') }
  }

  it('asks the answerer before creating a team and proceeds on a grant', async () => {
    const ctx = new Context()
    const approval = answerWith('allowed-once')
    ctx.provide('approval', approval as never)
    const service = makeService()
    const tools = register(ctx, service, { approveCreation: true, approveClosure: false })
    const call = exec()

    await tools.get('patent_teams_create')!.execute({ name: 'Alpha', description: 'goal' } as never, call)

    expect(approval.request).toHaveBeenCalledTimes(1)
    const asked = approval.request.mock.calls[0]![0]
    expect(asked.agent).toBe(call.agent)
    expect(asked.toolName).toBe('patent_teams_create')
    expect(asked.callId).toBe('call-1')
    expect(asked.reason).toContain('创建专利团队「Alpha」（目标：goal）')
    expect(asked.signal).toBe(call.signal)
    expect(service.create).toHaveBeenCalledWith(call.agent, 'Alpha', 'goal')
  })

  it('does not create the team when the answerer refuses', async () => {
    const ctx = new Context()
    ctx.provide('approval', answerWith('rejected') as never)
    const service = makeService()
    const tools = register(ctx, service, { approveCreation: true, approveClosure: false })

    await expect(tools.get('patent_teams_create')!.execute({ name: 'Alpha' } as never, exec()))
      .rejects.toBeInstanceOf(TeamApprovalError)
    expect(service.create).not.toHaveBeenCalled()
  })

  it('never asks while the deployment leaves the creation switch off', async () => {
    const ctx = new Context()
    const approval = answerWith('allowed-once')
    ctx.provide('approval', approval as never)
    const service = makeService()
    const tools = register(ctx, service)

    await tools.get('patent_teams_create')!.execute({ name: 'Alpha' } as never, exec())

    expect(approval.request).not.toHaveBeenCalled()
    expect(service.create).toHaveBeenCalled()
  })

  it('asks before closing the team and leaves it open when the answerer refuses', async () => {
    const ctx = new Context()
    const approval = answerWith('cancelled')
    ctx.provide('approval', approval as never)
    const service = makeService()
    const tools = register(ctx, service, { approveCreation: false, approveClosure: true })

    await expect(tools.get('patent_teams_delete')!.execute({} as never, exec()))
      .rejects.toBeInstanceOf(TeamApprovalError)
    expect(approval.request).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'patent_teams_delete' }))
    expect(service.delete).not.toHaveBeenCalled()
  })

  it('closes the team on a grant', async () => {
    const ctx = new Context()
    ctx.provide('approval', answerWith('allowed-once') as never)
    const service = makeService()
    const tools = register(ctx, service, { approveCreation: false, approveClosure: true })
    const call = exec()

    await tools.get('patent_teams_delete')!.execute({} as never, call)

    expect(service.delete).toHaveBeenCalledWith(call.agent, call.signal)
  })
})
