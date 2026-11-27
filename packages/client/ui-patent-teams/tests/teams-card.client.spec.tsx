// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { TeamsCard, type TeamsCardProps } from '../src/client/TeamsCard.tsx'
import { TeamsView, type TeamsViewProps } from '../src/client/TeamsView.tsx'
import { avatarGradient } from '../src/client/teams-avatar.ts'
import type { PatentTeamsCardData } from '../src/client/teams-model.ts'
import { PATENT_TEAMS_TARGET, type PatentTeamsViewSnapshot } from '../src/client/teams-view.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as applyNode } from '../src/index.ts'

afterEach(cleanup)

const PARENT_ID = 'captain' as SessionId
const CHILD_ID = 'child-1' as SessionId

const TEAM: PatentTeamsCardData = {
  teamId: 'search-team',
  name: '检索团队',
  description: '查新检索',
  status: 'active',
  members: [
    { memberId: CHILD_ID, name: 'alice', role: 'researcher', removed: false },
    { memberId: 'child-2' as SessionId, name: 'bob', removed: true },
  ],
  tasks: [
    { taskId: 't1', subject: '检索 A', dependencies: [], assignee: 'alice', status: 'completed', gated: false },
    { taskId: 't2', subject: '综述', dependencies: ['t1'], gated: false },
  ],
  completedTasks: 1,
  messageCount: 2,
  activity: [],
}

function listState(overrides: Partial<SessionListState> = {}): SessionListState {
  return {
    ids: [PARENT_ID, CHILD_ID],
    byId: {
      [PARENT_ID]: {
        id: PARENT_ID, displayTitle: 'captain', running: true, blank: false, updatedAt: 0,
        retainedBy: { mainView: 1 },
      },
      [CHILD_ID]: {
        id: CHILD_ID, displayTitle: 'alice', parentId: PARENT_ID, origin: 'subagent',
        running: true, blank: false, updatedAt: 0, retainedBy: {},
      },
    },
    phase: 'ready',
    projectionsBySession: {},
    ...overrides,
  }
}

function cardNode(team: PatentTeamsCardData): TeamsCardProps['node'] {
  return {
    key: '12:patent-teamssearch-team',
    kind: 'patent-teams',
    id: team.teamId,
    target: 'chat',
    anchorSeq: 2,
    location: { kind: 'unresolved' },
    visibility: 'visible',
    data: team,
  }
}

const runtimeShare = {
  sessionId: PARENT_ID,
  useSession: (() => undefined) as TeamsCardProps['useSession'],
  useConversation: (() => undefined) as TeamsCardProps['useConversation'],
  useChat: (() => undefined) as TeamsCardProps['useChat'],
  useTrajectory: (() => undefined) as TeamsCardProps['useTrajectory'],
  useSessionStatus: (() => undefined) as TeamsCardProps['useSessionStatus'],
  useProjection: () => undefined,
  useInput: () => { throw new Error('unused') },
  inputActions: { setDraft: () => {}, submit: () => {} } as unknown as TeamsCardProps['inputActions'],
  useWorkspaces: (() => undefined) as TeamsCardProps['useWorkspaces'],
  useTurnData: () => undefined,
  selectedCallId: undefined,
  cwd: undefined,
  openFile: () => {},
  inspectCall: () => {},
  forkAt: () => {},
  renderMessageImages: () => null,
  fileMentions: () => undefined,
}

function cardProps(
  team: PatentTeamsCardData = TEAM,
  sessions: SessionListState = listState(),
  openSession = vi.fn(),
): TeamsCardProps {
  return {
    node: cardNode(team),
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessions),
    openSession,
    t: makeTranslate(zh),
    ...runtimeShare,
  } as unknown as TeamsCardProps
}

interface ViewHarness {
  readonly loadOlder: ReturnType<typeof vi.fn<() => Promise<void>>>
  readonly hasMore: { current: boolean }
  readonly historyStatus?: { current: 'idle' | 'loading' | 'pendingConsumption' | 'error' }
}

function viewProps(
  snapshot: PatentTeamsViewSnapshot | undefined,
  sessions: SessionListState = listState(),
  openSession = vi.fn(),
  harness: ViewHarness = { loadOlder: vi.fn(async () => {}), hasMore: { current: false } },
): TeamsViewProps {
  return {
    ...runtimeShare,
    sessionId: PARENT_ID,
    useConversation: (selector: (state: { views: Map<string, unknown> }) => unknown) =>
      selector({ views: new Map(snapshot === undefined ? [] : [[PATENT_TEAMS_TARGET, snapshot]]) }),
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessions),
    useSession: (selector: (state: { hasMore: boolean; historyLoadStatus: string }) => unknown) =>
      selector({ hasMore: harness.hasMore.current, historyLoadStatus: harness.historyStatus?.current ?? 'idle' }),
    openSession,
    loadOlder: harness.loadOlder,
    t: makeTranslate(zh),
  } as unknown as TeamsViewProps
}

describe('TeamsCard', () => {
  it('renders the collapsed summary for an active team and expands on demand', () => {
    render(<TeamsCard {...cardProps()} />)
    const header = screen.getByRole('button', { name: /检索团队/ })
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(/2 名成员/)).toBeTruthy()
    expect(screen.getByText(/1\/2 项任务/)).toBeTruthy()
    expect(screen.getByText('进行中')).toBeTruthy()

    fireEvent.click(header)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('alice')).toBeNull()
  })

  it('starts collapsed for completed and disbanded teams', () => {
    render(<TeamsCard {...cardProps({ ...TEAM, status: 'deleted' })} />)
    expect(screen.getByRole('button', { name: /检索团队/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('已解散')).toBeTruthy()
  })

  it('opens a proven running member session and leaves others inert', () => {
    const openSession = vi.fn()
    render(<TeamsCard {...cardProps(TEAM, listState(), openSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /打开 alice/ }))
    expect(openSession).toHaveBeenCalledWith('child-1')
    expect(screen.queryByRole('button', { name: /打开 bob/ })).toBeNull()
    expect(screen.getByText('已离队')).toBeTruthy()
  })

  it('renders task rows with status, assignee, dependencies, and gate flags', () => {
    render(<TeamsCard {...cardProps()} />)
    const header = screen.getByRole('button', { name: /检索团队/ })
    fireEvent.click(header)
    fireEvent.click(header)
    expect(screen.getByText('检索 A')).toBeTruthy()
    expect(screen.getByText('综述')).toBeTruthy()
    expect(screen.getByText('未开始')).toBeTruthy()
    expect(screen.getByText('依赖 t1')).toBeTruthy()
    expect(screen.getByText('2 条消息')).toBeTruthy()
  })

  it('renders the bare hero and empty-list fallbacks for a team without content', () => {
    const { description: _description, ...bareTeam } = TEAM
    render(<TeamsCard {...cardProps({
      ...bareTeam,
      status: 'completed',
      members: [],
      tasks: [],
      completedTasks: 0,
      messageCount: 0,
    })} />)
    expect(screen.getByText('全部完成')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /检索团队/ }))
    expect(screen.getByText('0 名成员')).toBeTruthy()
    expect(screen.getAllByText('暂无任务').length).toBeGreaterThan(0)
    expect(screen.queryByText(/条消息/)).toBeNull()
  })

  it('renders every task dot state, unknown statuses, and contract flags', () => {
    render(<TeamsCard {...cardProps({
      ...TEAM,
      tasks: [
        { taskId: 't1', subject: '检索 A', dependencies: [], status: 'claimed', gated: false },
        { taskId: 't2', subject: '综述', dependencies: [], status: 'failed', gated: true },
        { taskId: 't3', subject: '核对', dependencies: [], status: 'cancelled', gated: false },
        { taskId: 't4', subject: '定稿', dependencies: [], assignee: 'alice', status: 'curated', gated: false, missingHardFields: ['sources'] },
        { taskId: 't5', subject: '补件', dependencies: [], status: 'pending', gated: false },
      ],
    })} />)
    expect(screen.getByText('已认领')).toBeTruthy()
    expect(screen.getByText('待领取')).toBeTruthy()
    expect(screen.getByText('失败')).toBeTruthy()
    expect(screen.getByText('已取消')).toBeTruthy()
    expect(screen.getByText('curated')).toBeTruthy()
    expect(screen.getByText('未过质量门')).toBeTruthy()
    expect(screen.getByText('契约缺字段：sources')).toBeTruthy()
  })

  it('demotes the open button when the member row stops running', () => {
    const view = render(<TeamsCard {...cardProps(TEAM)} />)
    expect(screen.getByRole('button', { name: /打开 alice/ })).toBeTruthy()
    view.rerender(<TeamsCard {...cardProps(TEAM, listState({
      byId: {
        ...listState().byId,
        [CHILD_ID]: { ...listState().byId[CHILD_ID]!, running: false },
      },
    }))} />)
    expect(screen.queryByRole('button', { name: /打开 alice/ })).toBeNull()
  })
})

describe('TeamsView shell', () => {
  it('renders the empty state without team records', () => {
    render(<TeamsView {...viewProps(undefined)} />)
    expect(screen.getByText(zh['view.empty'])).toBeTruthy()
  })

  it('drains backwards history while the fold holds no team and pages remain', async () => {
    const harness: ViewHarness = {
      loadOlder: vi.fn(async () => {}),
      hasMore: { current: true },
    }
    // The stub exhausts the window on the second page, like the real host.
    let pages = 0
    harness.loadOlder.mockImplementation(async () => {
      pages += 1
      if (pages >= 2) harness.hasMore.current = false
    })
    const view = render(<TeamsView {...viewProps(undefined, listState(), vi.fn(), harness)} />)
    await act(async () => { await Promise.resolve() })
    expect(pages).toBe(2)
    harness.hasMore.current = false
    view.rerender(<TeamsView {...viewProps(undefined, listState(), vi.fn(), harness)} />)
    await act(async () => { await Promise.resolve() })
    expect(pages).toBe(2)
    expect(screen.getByText(zh['view.empty'])).toBeTruthy()
  })

  it('stops draining once a team is on the page', async () => {
    const harness: ViewHarness = { loadOlder: vi.fn(async () => {}), hasMore: { current: true } }
    render(<TeamsView {...viewProps({ teams: [TEAM] }, listState(), vi.fn(), harness)} />)
    await act(async () => { await Promise.resolve() })
    expect(harness.loadOlder).not.toHaveBeenCalled()
    expect(screen.getByText('检索团队')).toBeTruthy()
  })

  it('drops a late drain completion after unmount', async () => {
    let resolve!: () => void
    const loadOlder = vi.fn((): Promise<void> => new Promise((done) => { resolve = done }))
    const view = render(<TeamsView {...viewProps(undefined, listState(), vi.fn(), {
      loadOlder,
      hasMore: { current: true },
    })} />)
    view.unmount()
    resolve()
    await act(async () => { await Promise.resolve() })
    expect(loadOlder).toHaveBeenCalledTimes(1)
  })

  it('stops draining and stops claiming "no teams" once history reports an error', async () => {
    // The Session settles both failures and no-progress pages to `error`
    // without rejecting, so the drain must read that status or it re-requests
    // the same page until the attempt cap.
    const harness: ViewHarness = {
      loadOlder: vi.fn(async () => {}),
      hasMore: { current: true },
      historyStatus: { current: 'error' },
    }
    render(<TeamsView {...viewProps(undefined, listState(), vi.fn(), harness)} />)
    await act(async () => { await Promise.resolve() })
    expect(harness.loadOlder).not.toHaveBeenCalled()
    expect(screen.getByText(zh['view.empty'])).toBeTruthy()
  })

  it('announces history paging instead of an empty session while pages remain', () => {
    const harness: ViewHarness = { loadOlder: vi.fn(async () => {}), hasMore: { current: true } }
    render(<TeamsView {...viewProps(undefined, listState(), vi.fn(), harness)} />)
    expect(screen.getByText(zh['view.loading'])).toBeTruthy()
    expect(screen.queryByText(zh['view.empty'])).toBeNull()
  })
})

describe('TeamsDashboard', () => {
  it('renders the hero, segmented progress, and roster for one folded team', () => {
    render(<TeamsView {...viewProps({ teams: [TEAM] })} />)
    const team = document.querySelector('[data-patent-teams-team="search-team"]')
    expect(team).not.toBeNull()
    expect(team!.getAttribute('data-team-status')).toBe('active')
    expect(screen.getByText('总进度')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    // The legend label and the DAG node's screen-reader status both read 已完成.
    expect(screen.getAllByText('已完成').length).toBeGreaterThan(0)
    // The proven running member is the only navigation button on the roster.
    expect(screen.getByRole('button', { name: /打开 alice/ })).toBeTruthy()
    expect(screen.getByText('已离队')).toBeTruthy()
    expect(screen.getByText('队长')).toBeTruthy()
  })

  it('binds a working member to its current task and an idle one to its last', () => {
    render(<TeamsView {...viewProps({ teams: [TEAM] })} />)
    // alice is running but t1 is completed and t2 is unassigned: no current task line.
    expect(screen.queryByText(/当前任务/)).toBeNull()
  })

  it('traces the dependency chain on hover and pins on click', () => {
    render(<TeamsView {...viewProps({ teams: [TEAM] })} />)
    const t2 = screen.getByRole('button', { name: /综述/ })
    fireEvent.mouseEnter(t2)
    expect(t2.getAttribute('data-dag-hot')).toBe('true')
    expect(screen.queryByRole('button', { name: /检索 A/ })!.getAttribute('data-dag-hot')).toBe('true')
    fireEvent.click(t2)
    expect(t2.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(t2)
    expect(t2.getAttribute('aria-pressed')).toBe('false')
    fireEvent.mouseLeave(t2)
  })

  it('flags a gate-rejected task in the DAG and the activity feed', () => {
    const gated: PatentTeamsCardData = {
      ...TEAM,
      tasks: [
        { ...TEAM.tasks[0]!, gated: true },
        ...TEAM.tasks.slice(1),
      ],
      activity: [
        { kind: 'task-created', seq: 5, taskId: 't1', subject: '检索 A' },
        { kind: 'task-gated', seq: 9, taskId: 't1', subject: '检索 A' },
        { kind: 'task-validated', seq: 10, taskId: 't1', subject: '检索 A', valid: false, missingHardFields: ['sources'] },
        { kind: 'message-sent', seq: 11, from: 'alice', to: 'captain' },
      ],
    }
    render(<TeamsView {...viewProps({ teams: [gated] })} />)
    const t1 = screen.getByRole('button', { name: /检索 A/ })
    expect(t1.textContent).toContain('未过质量门')
    expect(screen.getByText('t1「检索 A」未过质量门')).toBeTruthy()
    expect(screen.getByText('t1「检索 A」契约缺字段：sources')).toBeTruthy()
    expect(screen.getByText('alice → captain')).toBeTruthy()
    expect(screen.getByText('创建任务 t1「检索 A」')).toBeTruthy()
  })

  it('shows the empty activity note for a team without transitions', () => {
    render(<TeamsView {...viewProps({ teams: [{ ...TEAM, activity: [] }] })} />)
    expect(screen.getByText('暂无动态')).toBeTruthy()
  })

  it('hides the DAG section entirely for a team without tasks', () => {
    render(<TeamsView {...viewProps({ teams: [{ ...TEAM, tasks: [], completedTasks: 0 }] })} />)
    expect(screen.queryByRole('button', { name: /综述/ })).toBeNull()
    expect(screen.getByText('暂无动态')).toBeTruthy()
  })

  it('opens a running member session from the dashboard', () => {
    const openSession = vi.fn()
    render(<TeamsView {...viewProps({ teams: [TEAM] }, listState(), openSession)} />)
    fireEvent.click(screen.getByRole('button', { name: /打开 alice/ }))
    expect(openSession).toHaveBeenCalledWith('child-1')
  })

  it('renders non-active pills and sparse activity fallbacks', () => {
    const sparse: PatentTeamsCardData = {
      ...TEAM,
      status: 'deleted',
      activity: [
        { kind: 'task-created', seq: 1 },
        { kind: 'task-updated', seq: 2, status: 'completed' },
        { kind: 'task-validated', seq: 3, valid: false },
        { kind: 'task-validated', seq: 4, valid: true },
        { kind: 'task-gated', seq: 5 },
        { kind: 'message-sent', seq: 6 },
      ],
    }
    render(<TeamsView {...viewProps({ teams: [sparse, { ...TEAM, teamId: 'anon', name: '' }] })} />)
    expect(screen.getAllByText('已解散').length).toBeGreaterThan(0)
    const feed = document.querySelector('[data-patent-teams-activity="true"]')
    expect(feed).not.toBeNull()
    expect(feed!.textContent).toContain('创建任务 「」')
    expect(feed!.textContent).toContain('「」→ 已完成')
    expect(feed!.textContent).toContain('「」契约缺字段：')
    expect(feed!.textContent).toContain('「」通过契约校验')
    expect(feed!.textContent).toContain('「」未过质量门')
    expect(feed!.textContent).toContain('→')
  })

  it('derives a stable avatar gradient from the member id', () => {
    expect(avatarGradient('child-1')).toBe(avatarGradient('child-1'))
    expect(avatarGradient('child-1')).not.toBe(avatarGradient('child-2'))
    expect(avatarGradient('child-1')).toMatch(/^linear-gradient/)
  })

  it('renders every node status, the idle binding, and the feed kinds for a rich team', () => {
    const rich: PatentTeamsCardData = {
      teamId: 'review-team',
      name: '评审团队',
      status: 'active',
      members: [
        { memberId: CHILD_ID, name: 'alice', role: 'examiner', removed: false },
        { memberId: 'child-3' as SessionId, name: 'carol', removed: false },
      ],
      tasks: [
        { taskId: 't1', subject: '检索 A', dependencies: [], assignee: 'alice', status: 'completed', gated: false },
        { taskId: 't2', subject: '比对', dependencies: ['t1'], assignee: 'alice', status: 'in_progress', gated: false },
        { taskId: 't3', subject: '认领件', dependencies: ['t1'], assignee: 'carol', status: 'claimed', gated: false },
        { taskId: 't4', subject: '失败件', dependencies: ['t2'], status: 'failed', gated: false },
        { taskId: 't5', subject: '待办件', dependencies: [], gated: false },
        { taskId: 't6', subject: '旁支', dependencies: ['t3'], assignee: 'carol', status: 'completed', gated: false },
      ],
      completedTasks: 2,
      messageCount: 3,
      activity: [
        { kind: 'task-updated', seq: 12, taskId: 't2', subject: '比对', status: 'in_progress' },
        { kind: 'task-validated', seq: 11, taskId: 't1', subject: '检索 A', valid: true },
        { kind: 'message-sent', seq: 10, from: 'captain', to: 'carol' },
      ],
    }
    render(<TeamsView {...viewProps({ teams: [rich] })} />)
    // The running member binds to its open assignment; the idle one to its last.
    expect(screen.getByText(/当前任务 · 比对/)).toBeTruthy()
    expect(screen.getByText(/上一任务 · 旁支/)).toBeTruthy()
    expect(screen.getByText('t2「比对」→ 进行中')).toBeTruthy()
    expect(screen.getByText('t1「检索 A」通过契约校验')).toBeTruthy()
    expect(screen.getAllByText('未分配').length).toBe(2)
    // Hover traces one chain and dims the off-chain branch edges. DAG nodes
    // start their accessible name with the task id; the roster button carries
    // the same words further in, so anchor on the id.
    const t2 = screen.getByRole('button', { name: /^t2/ })
    fireEvent.focus(t2)
    expect(t2.getAttribute('data-dag-hot')).toBe('true')
    const offBranch = screen.getByRole('button', { name: /^t6/ })
    expect(offBranch.getAttribute('data-dag-dim')).toBe('true')
    // The SVG edges follow the same chain: on-path hot, off-path dimmed.
    const edgeClasses = [...document.querySelectorAll('path')].map(path => path.getAttribute('class') ?? '')
    expect(edgeClasses.some(name => name.includes('dagEdgeHot'))).toBe(true)
    expect(edgeClasses.some(name => name.includes('dagEdgeDim'))).toBe(true)
    fireEvent.blur(t2)
    expect(t2.getAttribute('data-dag-hot')).toBeNull()
    expect(offBranch.getAttribute('data-dag-dim')).toBeNull()
  })
})

class TestSessions extends Service {
  readonly opened: SessionId[] = []
  constructor(ctx: Context) { super(ctx, 'sessions') }
  open(id: SessionId): void { this.opened.push(id) }
  binding(id: SessionId): { session: { loadOlder: () => Promise<void> } } | undefined {
    if (id !== PARENT_ID) return undefined
    return { session: { loadOlder: async () => {} } }
  }
}

describe('plugin lifecycle', () => {
  it('registers and removes the Definitions, the view, and both slot entries with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    new UiConversation(ctx, { binding: () => undefined } as never)
    // The locale plugin requires the connection handle, the forwarded-event
    // port, and the configuration form transport; 'locale' backs the slot
    // entries' `t` seat.
    ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
    ctx.provide('remote', { $on: () => () => {} } as never)
    ctx.provide('configForms', { get: () => stubConfigForm().scope } as never)
    await ctx.plugin(TestSessions).await()
    const opened: SessionId[] = []
    ctx.provide('uiWorkspace', { openSession: (id: SessionId) => { opened.push(id) } } as never)
    ctx.slots.register({
      name: 'root',
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
        'conversation.view': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries('conversation.chat.node')).toHaveLength(1)
    expect(ctx.slots.entries('conversation.view')).toHaveLength(1)
    const cardEntry = ctx.slots.entries('conversation.chat.node')[0]!
    const cardFace = cardEntry.inject?.() as unknown as { openSession: (id: SessionId) => void }
    cardFace.openSession(CHILD_ID)
    expect(opened).toEqual([CHILD_ID])
    // The view entry resolves its drain verb from the session face and fails
    // loud when the session binding is absent.
    const viewEntry = ctx.slots.entries('conversation.view')[0]! as unknown as {
      options: { label?: () => string }
      inject?: (sessionId: SessionId) => {
        openSession: (id: SessionId) => void
        loadOlder: () => Promise<void>
      }
    }
    // The label thunk reads through the bound locale; the ambient test
    // environment resolves to the English dictionary.
    expect(viewEntry.options.label?.()).toBe(en['view.teams'])
    const viewFace = viewEntry.inject?.(PARENT_ID)
    if (viewFace === undefined) throw new Error('expected the view inject to bind a session')
    await viewFace.loadOlder()
    viewFace.openSession(CHILD_ID)
    expect(opened).toEqual([CHILD_ID, CHILD_ID])
    expect(() => viewEntry.inject?.('ghost' as SessionId)).toThrow(/unavailable/)
    await fiber.dispose()
    expect(ctx.slots.entries('conversation.chat.node')).toEqual([])
    expect(ctx.slots.entries('conversation.view')).toEqual([])
  })

  it('keeps the node half inert on a bare context', () => {
    expect(() => { applyNode() }).not.toThrow()
  })
})
