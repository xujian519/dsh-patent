// @vitest-environment jsdom
/**
 * StudioView presentation behavior: produced-file list, selection, preview
 * pane (HTML frame vs text vs sidebar handoff), the quality-gate claim, the
 * machine-check badges, the workspace probes, and the file actions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  allowAllAccess, bindSnapshotSelector, conversationSnapshot, makeTranslate, sessionSnapshot, workspaceSnapshot,
} from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ConversationSnapshot, ConversationViewSnapshotMap,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { DOCUMENT_DELIVERABLES_TARGET } from '../src/client/document-deliverables.ts'
import {
  StudioView, isHtmlPath, isTextPreviewable, parseDocumentSections,
  type StudioViewInjected, type StudioViewProps,
} from '../src/client/StudioView.tsx'
import type { CompleteReadText } from '../src/client/file-reads.ts'
import { WorkspaceReadError } from '../src/client/file-reads.ts'
import { en, zh } from '../src/client/locales.ts'
// Type-only: pulls the LocaleNamespaceMap augmentation into this program.
import type {} from '../src/client/index.ts'

const t: StudioViewProps['t'] = makeTranslate(zh, en)

/** Empty global standard-kit hooks the studio does not read. */
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const useResource = (() => ({
  status: 'none' as const, value: undefined, failure: undefined, reload: () => {},
})) as GlobalStandardProps['useResource']

interface ProducedFile {
  seq: number
  path: string
  identity?: string
  format?: string
  gate?: { p0: string[]; p1: string[] }
  checks?: {
    status: string
    reason?: string
    findings: Array<{ check: string; level: string; detail: string; line?: number }>
    identity?: string
  }
  checksWithdrawn?: true
  briefRef?: string
}

function session(produced: Array<ProducedFile>) {
  const views: ConversationSnapshot['views'] = {
    // The target check makes this assertion exact for the one registered target.
    get: <Target extends Extract<keyof ConversationViewSnapshotMap, string>>(target: Target) =>
      (target === DOCUMENT_DELIVERABLES_TARGET ? { produced } : undefined) as
        ConversationViewSnapshotMap[Target] | undefined,
    grouped: () => undefined,
  }
  const store = createSnapshotStore<ConversationSnapshot>(conversationSnapshot({ views }))
  return { store, useConversation: bindSnapshotSelector(store) }
}

function sessionsOf(preset: string | null = 'document') {
  const summary: SessionSummary = {
    id: SessionId('s1'),
    displayTitle: 's1',
    running: false,
    retainedBy: {},
    blank: false,
    updatedAt: 0,
    projectionValues: { agentPreset: preset },
  }
  const store = createSnapshotStore<SessionListState>({
    ids: [summary.id],
    byId: { [summary.id]: summary },
    phase: 'ready',
    projectionsBySession: {},
  })
  return bindSnapshotSelector(store)
}

function injected(overrides: Partial<StudioViewInjected> = {}): StudioViewInjected {
  return {
    isLoopback: true,
    canOpenInSidebar: true,
    openFile: vi.fn(() => Promise.resolve()),
    showInFolder: vi.fn(() => Promise.resolve()),
    openInSidebar: vi.fn(() => true),
    readFileText: vi.fn((path: string) => Promise.resolve({ content: `<h1>${path}</h1>`, truncated: false })),
    readFileTextComplete: vi.fn((path: string): Promise<CompleteReadText> =>
      Promise.resolve({ truncated: false, content: `<h1>${path}</h1>` })),
    statVersions: vi.fn((paths: readonly string[]) => Promise.resolve(
      Object.fromEntries(paths.map(path => [path, `v1:${path}`])),
    )),
    probeUnregistered: vi.fn(() => Promise.resolve([])),
    insertDraft: vi.fn(() => true),
    ...overrides,
  }
}

function studioProps(
  produced: Array<ProducedFile>,
  overrides: Partial<StudioViewInjected> = {},
  preset: string | null = 'document',
): StudioViewProps {
  const s = session(produced)
  // The full session-scope standard kit the outlet would bake; members the
  // studio does not read are stubbed inert (the trajectory spec pattern).
  return {
    sessionId: SessionId('s1'),
    useConversation: s.useConversation,
    useSessions: sessionsOf(preset),
    useSession: bindSnapshotSelector(createSnapshotStore(sessionSnapshot(SessionId('s1')))),
    useSessionStatus: bindSnapshotSelector(createSnapshotStore<SessionStatusSnapshot>(new Map())),
    useChat: () => { throw new Error('unused') },
    useTrajectory: () => { throw new Error('unused') },
    useSessionRetainInfo: () => undefined,
    useWorkspaces: bindSnapshotSelector(createSnapshotStore(workspaceSnapshot())),
    useProjection: () => undefined,
    useInput: (() => undefined) as StudioViewProps['useInput'],
    inputActions: {} as StudioViewProps['inputActions'],
    ...allowAllAccess,
    usePanelInfo,
    useResource,
    inspectCall: undefined,
    viewRequest: null,
    openView: () => {},
    completeViewRequest: vi.fn(),
    ...injected(overrides),
    t,
  }
}

afterEach(cleanup)

describe('StudioView', () => {
  it('shows the empty state when the session produced no files', async () => {
    const probeUnregistered = vi.fn(() => Promise.resolve([]))
    render(<StudioView {...studioProps([], { probeUnregistered })} />)
    expect(screen.getByText(t('studio.empty'))).toBeTruthy()
    // The probe runs once on mount, never on a timer.
    await screen.findByRole('button', { name: t('studio.empty.scan') })
    expect(probeUnregistered).toHaveBeenCalledTimes(1)
    expect(probeUnregistered).toHaveBeenCalledWith([])
  })

  it('reports unregistered deliverable files beside the empty state instead of claiming nothing was produced', async () => {
    const probeUnregistered = vi.fn(() => Promise.resolve(['out/report.docx', 'out/deck.pptx']))
    render(<StudioView {...studioProps([], { probeUnregistered })} />)
    expect(await screen.findByText(t('studio.empty.unregistered', { count: 2 }))).toBeTruthy()
    expect(screen.getByText('out/report.docx')).toBeTruthy()
    expect(screen.getByText(t('studio.empty.unregisteredHint'))).toBeTruthy()
  })

  it('surfaces a failed workspace probe as its own state, and rescans on request', async () => {
    const probeUnregistered = vi.fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(['a.html'])
    render(<StudioView {...studioProps([], { probeUnregistered })} />)
    expect(await screen.findByText(t('studio.empty.scanFailed', { message: 'permission denied' }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('studio.empty.scan') }))
    expect(await screen.findByText(t('studio.empty.unregistered', { count: 1 }))).toBeTruthy()
    expect(probeUnregistered).toHaveBeenCalledTimes(2)
  })

  it('lists produced files, auto-selects the first, and previews HTML in a sandboxed frame', async () => {
    const readFileText = vi.fn((path: string) => {
      if (path === 'out/index.html') return Promise.resolve({ content: '<h1>Hi</h1>', truncated: false })
      return Promise.resolve({ content: '# Notes', truncated: true })
    })
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/index.html' }, { seq: 2, path: 'notes.md' }], { readFileText })} />,
    )
    expect(screen.getAllByText('index.html').length).toBeGreaterThan(0)
    expect(screen.getAllByText('notes.md').length).toBeGreaterThan(0)
    expect(screen.getByText(t('studio.files', { count: 2 }))).toBeTruthy()
    // First file auto-selected → HTML frame (content loads asynchronously).
    const frame = await screen.findByTitle('index.html') as unknown as HTMLIFrameElement
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.srcdoc).toContain('<h1>Hi</h1>')
    // Selecting the markdown file shows the text pane with the truncation note.
    const notesChip = screen.getAllByText('notes.md')[0]
    expect(notesChip).toBeDefined()
    fireEvent.click(notesChip!)
    expect(await screen.findByText('# Notes')).toBeTruthy()
    expect(screen.getByText(t('studio.preview.truncated'))).toBeTruthy()
  })

  it('marks a truncated HTML preview instead of passing the head off as the document', async () => {
    const readFileText = vi.fn(() => Promise.resolve({ content: '<section data-doc-id="a">x</section>', truncated: true }))
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/index.html' }], { readFileText })} />)
    expect(await screen.findByText(t('studio.preview.truncated'))).toBeTruthy()
    expect(screen.getByTitle('index.html').getAttribute('sandbox')).toBe('')
  })

  it('keeps the declared quality gate neutral and lists its items as the model\'s claim', () => {
    render(
      <StudioView {...studioProps([
        {
          seq: 1, path: 'out/report.html',
          format: 'html', gate: { p0: ['命名规范'], p1: ['可访问性'] }, briefRef: 'brief.md',
        },
        { seq: 2, path: 'out/report.md' },
      ])} />,
    )
    expect(screen.getByText('html')).toBeTruthy()
    // The claim badge says it is a claim, and names the declared items.
    expect(screen.getByText(t('studio.file.gateIds', { ids: '命名规范 · 可访问性' }))).toBeTruthy()
    // The expansion lists them as items, under the claim label.
    expect(screen.getByText(t('studio.claim.title'))).toBeTruthy()
    expect(screen.getByText(t('studio.claim.p0'))).toBeTruthy()
    expect(screen.getAllByText('命名规范').length).toBeGreaterThan(0)
    expect(screen.getAllByText('可访问性').length).toBeGreaterThan(0)
    expect(screen.getByText(t('studio.file.gateMissing'))).toBeTruthy()
  })

  it('renders stable P0 ids verbatim and falls back to counts for a long claim list', () => {
    render(
      <StudioView {...studioProps([
        {
          seq: 1, path: 'out/short.html', format: 'html',
          gate: { p0: ['P0-1 命名', 'P0-2 自包含'], p1: [] },
        },
        {
          seq: 2, path: 'out/long.html', format: 'html',
          gate: { p0: ['P0-1 命名', 'P0-2 自包含', 'P0-3 无占位残留', 'P0-4 断链'], p1: [] },
        },
      ])} />,
    )
    // Short claims name their ids; the badge is not a bare count.
    expect(screen.getByText(t('studio.file.gateIds', { ids: 'P0-1 命名 · P0-2 自包含' }))).toBeTruthy()
    // A claim list too long for the badge keeps the count there.
    expect(screen.getByText(t('studio.file.gateClaim', { p0: 4, p1: 0 }))).toBeTruthy()
    // Selecting that file still lists every declared item verbatim.
    fireEvent.click(screen.getAllByText('long.html')[0]!)
    expect(screen.getAllByText('P0-3 无占位残留').length).toBeGreaterThan(0)
    expect(screen.getAllByText('P0-4 断链').length).toBeGreaterThan(0)
  })

  it('keeps the missing-gate badge for document sessions only', () => {
    cleanup()
    render(<StudioView {...studioProps([{ seq: 1, path: 'src/app.ts' }], {}, 'standard')} />)
    expect(screen.queryByText(t('studio.file.gateMissing'))).toBeNull()
  })

  it('renders the machine-check badge per recorded status, with its findings as the tooltip', () => {
    render(
      <StudioView {...studioProps([
        {
          seq: 1, path: 'out/clean.html', format: 'html',
          checks: { status: 'checked', findings: [] },
        },
        {
          seq: 2, path: 'out/warned.md', format: 'markdown',
          checks: {
            status: 'checked',
            findings: [{ check: 'empty_section', level: 'warn', detail: '第 5 行的标题 "空节" 下没有任何内容', line: 5 }],
          },
        },
        {
          seq: 3, path: 'out/deck.pdf', format: 'pdf',
          checks: { status: 'unchecked', reason: 'pdf 格式没有文本读取器', findings: [] },
        },
        {
          seq: 4, path: 'out/partial.docx', format: 'docx',
          checks: { status: 'unreadable', reason: 'DOCX 结构报告 malformed-xml，投影文本可能不完整', findings: [] },
        },
        { seq: 5, path: 'out/unregistered.txt' },
      ])} />,
    )
    expect(screen.getByText(t('studio.file.checkedPassed'))).toBeTruthy()
    const warned = screen.getByText(t('studio.file.checkedFindings', { count: 1 }))
    expect(warned.getAttribute('title')).toBe('第 5 行的标题 "空节" 下没有任何内容')
    expect(screen.getByText(t('studio.file.checkedSkipped')).getAttribute('title')).toBe('pdf 格式没有文本读取器')
    expect(screen.getByText(t('studio.file.checkedFailed')).getAttribute('title')).toBe('DOCX 结构报告 malformed-xml，投影文本可能不完整')
    // A file with no recorded checks renders no machine-check badge at all.
    expect(screen.getByText('unregistered.txt').closest('button')?.textContent).not.toContain(t('studio.file.checkedPassed'))
  })

  it('withdraws the verdict once the file\'s freshness token moved', async () => {
    const statVersions = vi.fn()
      .mockResolvedValueOnce({ 'out/report.html': 'v1' })
      .mockResolvedValueOnce({ 'out/report.html': 'v2' })
    const props = studioProps([
      {
        seq: 1, path: 'out/report.html', format: 'html', gate: { p0: ['命名规范'], p1: [] },
        checks: { status: 'checked', findings: [] },
      },
    ], { statVersions })
    const { rerender } = render(<StudioView {...props} />)
    expect(await screen.findByText(t('studio.file.checkedPassed'))).toBeTruthy()
    // A new produced list (the log moved) re-checks the token.
    rerender(<StudioView {...studioProps([{
      seq: 1, path: 'out/report.html', format: 'html', gate: { p0: ['命名规范'], p1: [] },
      checks: { status: 'checked', findings: [] },
    }], { statVersions })} />)
    expect(await screen.findByText(t('studio.file.changed'))).toBeTruthy()
    expect(screen.queryByText(t('studio.file.checkedPassed'))).toBeNull()
  })

  it('shows the changed badge for a verdict the fold already withdrew, without any stat', () => {
    // What a reloaded session sees: the withdrawal is replayed from the log, so
    // the badge never depends on this console having observed the rewrite.
    const statVersions = vi.fn(() => Promise.resolve({}))
    render(
      <StudioView {...studioProps([{
        seq: 1, path: 'out/report.html', format: 'html', gate: { p0: ['命名规范'], p1: [] },
        checksWithdrawn: true,
      }], { statVersions })} />,
    )
    expect(screen.getByText(t('studio.file.changed'))).toBeTruthy()
    expect(screen.queryByText(t('studio.file.checkedPassed'))).toBeNull()
  })

  it('labels one file once when it carries both a withdrawn verdict and a moved token', () => {
    const statVersions = vi.fn()
      .mockResolvedValueOnce({ 'out/report.html': 'v1' })
      .mockResolvedValueOnce({ 'out/report.html': 'v2' })
    const withdrawn = [{
      seq: 1, path: 'out/report.html', format: 'html', gate: { p0: ['命名规范'], p1: [] },
      checksWithdrawn: true as const,
    }]
    const { rerender } = render(<StudioView {...studioProps(withdrawn, { statVersions })} />)
    expect(screen.getAllByText(t('studio.file.changed'))).toHaveLength(1)
    rerender(<StudioView {...studioProps(withdrawn, { statVersions })} />)
    expect(screen.getAllByText(t('studio.file.changed'))).toHaveLength(1)
  })

  it('runs the open and reveal actions and reports a failed one instead of swallowing it', async () => {
    const openFile = vi.fn(() => Promise.resolve())
    const showInFolder = vi.fn(() => Promise.resolve())
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/report.md' }], { openFile, showInFolder })} />,
    )
    fireEvent.click(screen.getByText(t('studio.action.open')))
    expect(openFile).toHaveBeenCalledWith('out/report.md')
    fireEvent.click(screen.getByText(t('studio.action.folder')))
    expect(showInFolder).toHaveBeenCalledWith('out/report.md')

    cleanup()
    const failing = vi.fn(() => Promise.reject(new Error('no desktop')))
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/report.md' }], { openFile: failing })} />)
    fireEvent.click(screen.getByText(t('studio.action.open')))
    expect(await screen.findByText(t('studio.action.openFailed', { message: 'no desktop' }))).toBeTruthy()
  })

  it('gates the reveal action on loopback', () => {
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/report.md' }], { isLoopback: false })} />)
    expect(screen.queryByText(t('studio.action.folder'))).toBeNull()
  })

  it('prints the HTML preview through a print window and reports a blocked popup', async () => {
    const write = vi.fn()
    const print = vi.fn()
    const open = vi.spyOn(window, 'open')
    open.mockReturnValueOnce({
      document: { open: vi.fn(), write, close: vi.fn() },
      focus: vi.fn(),
      print,
    } as never)
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/index.html' }])} />)
    await screen.findByTitle('index.html')
    // The export hint is visible before the browser print dialog opens.
    expect(screen.getByText(t('studio.print.note'))).toBeTruthy()
    fireEvent.click(screen.getByText(t('studio.action.print')))
    expect(write).toHaveBeenCalledWith('<h1>out/index.html</h1>')
    expect(print).toHaveBeenCalled()
    // Blocked popup: window.open returns null and the view says so.
    open.mockReturnValueOnce(null)
    fireEvent.click(screen.getByText(t('studio.action.print')))
    expect(print).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(t('studio.print.failed', { message: t('studio.print.blocked') }))).toBeTruthy()
    open.mockRestore()
  })

  it('localizes a read failure from its Host code instead of showing the wire text', async () => {
    const readFileText = vi.fn(() => Promise.reject(
      new WorkspaceReadError('no entry at "out/gone.md"', 'workspace-file/not-found'),
    ))
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/gone.md' }], { readFileText })} />)
    expect(await screen.findByText(t('studio.error.notFound'))).toBeTruthy()
    expect(screen.queryByText('no entry at "out/gone.md"')).toBeNull()
  })

  it('hands a non-previewable file to the sidebar instead of asking which file to select', async () => {
    const openInSidebar = vi.fn(() => true)
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/report.docx' }], { openInSidebar })} />,
    )
    expect(await screen.findByText(t('studio.preview.sidebarOnly'))).toBeTruthy()
    // The old hint told the user to select a file that was already selected.
    expect(screen.queryByText(t('studio.preview.hint'))).toBeNull()
    fireEvent.click(screen.getAllByText(t('studio.action.previewSidebar'))[0]!)
    expect(openInSidebar).toHaveBeenCalledWith('out/report.docx')
  })

  it('omits the sidebar handoff when no preview surface is mounted', async () => {
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/report.docx' }], { canOpenInSidebar: false })} />)
    expect(await screen.findByText(t('studio.preview.sidebarOnly'))).toBeTruthy()
    expect(screen.queryByText(t('studio.action.previewSidebar'))).toBeNull()
  })

  it('fills the composer draft with the machine findings and never sends it', async () => {
    const insertDraft = vi.fn((text: string) => text.length > 0)
    render(
      <StudioView {...studioProps([
        {
          seq: 1, path: 'out/warned.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] },
          checks: {
            status: 'checked',
            findings: [{ check: 'empty_section', level: 'warn', detail: '空标题下没有任何内容', line: 5 }],
          },
        },
      ], { insertDraft })} />,
    )
    fireEvent.click(screen.getByText(t('studio.action.revise')))
    expect(insertDraft).toHaveBeenCalledTimes(1)
    const draft = insertDraft.mock.calls[0]?.[0] ?? ''
    expect(draft).toContain(t('studio.revise.prefix'))
    expect(draft).toContain('空标题下没有任何内容')
    expect(draft).toContain(t('studio.revise.line', { line: 5 }))
    // The insert is the only write: the message is a draft, and the view says so.
    expect(await screen.findByText(t('studio.revise.inserted'))).toBeTruthy()
  })

  it('inserts a section reference draft for a delivered HTML file', async () => {
    const insertDraft = vi.fn((text: string) => text.length > 0)
    const html = '<html><body><section data-doc-id="sec-intro"><h2>引言</h2><p>a</p></section>'
      + '<section data-doc-id="sec-end"><h2>结论</h2><p>b</p></section></body></html>'
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/report.html' }], {
        insertDraft,
        readFileText: vi.fn(() => Promise.resolve({ content: html, truncated: false })),
      })} />,
    )
    await screen.findByTitle('report.html')
    fireEvent.change(screen.getByLabelText(t('studio.section.pick')), { target: { value: 'sec-end' } })
    fireEvent.click(screen.getByText(t('studio.section.insert')))
    expect(insertDraft).toHaveBeenCalledTimes(1)
    const draft = insertDraft.mock.calls[0]?.[0] ?? ''
    expect(draft).toContain(t('studio.section.reference', { path: 'out/report.html', id: 'sec-end' }))
    expect(draft).toContain('结论')
    expect(draft).toContain(t('studio.section.instruction'))
    expect(await screen.findByText(t('studio.section.inserted'))).toBeTruthy()
  })

  it('distinguishes two files that share a basename', () => {
    render(
      <StudioView {...studioProps([
        { seq: 1, path: 'out/v1/report.html' },
        { seq: 2, path: 'out/v2/report.html' },
      ])} />,
    )
    expect(screen.getByText('report.html · out/v1')).toBeTruthy()
    expect(screen.getByText('report.html · out/v2')).toBeTruthy()
  })

  it('keeps every action reachable in one row for a narrow panel', async () => {
    // jsdom has no layout, so the 390px acceptance is asserted structurally:
    // all five actions render and each one is wired.
    const openFile = vi.fn(() => Promise.resolve())
    render(
      <StudioView {...studioProps([
        {
          seq: 1, path: 'out/report.html', format: 'html', gate: { p0: ['x'], p1: [] },
          checks: { status: 'checked', findings: [] },
        },
      ], { openFile })} />,
    )
    await screen.findByTitle('report.html')
    for (const label of [
      t('studio.action.open'),
      t('studio.action.folder'),
      t('studio.action.previewSidebar'),
      t('studio.action.print'),
      t('studio.action.revise'),
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    fireEvent.click(screen.getByText(t('studio.action.open')))
    expect(openFile).toHaveBeenCalled()
  })

  it('honors a one-shot focus request naming a produced file', async () => {
    const completeViewRequest = vi.fn()
    const props = {
      ...studioProps([{ seq: 1, path: 'a.html' }, { seq: 2, path: 'out/b.md' }]),
      completeViewRequest,
    }
    const { rerender } = render(<StudioView {...props} />)
    expect(await screen.findByTitle('a.html')).toBeTruthy()
    rerender(<StudioView {...{
      ...props,
      viewRequest: { view: 'documentDeliverables', focus: 'out/b.md' },
    }} />)
    expect(await screen.findByText('<h1>out/b.md</h1>')).toBeTruthy()
    expect(completeViewRequest).toHaveBeenCalledTimes(1)
  })

  it('renders the empty list when the session carries no produced snapshot', async () => {
    const props = studioProps([])
    const store = createSnapshotStore<ConversationSnapshot>(conversationSnapshot({
      views: { get: () => undefined, grouped: () => undefined },
    }))
    render(<StudioView {...props} useConversation={bindSnapshotSelector(store)} />)
    expect(await screen.findByText(t('studio.empty'))).toBeTruthy()
  })

  it('holds a focus request until the list resolves it, and acknowledges one that names no listed file', async () => {
    const completeViewRequest = vi.fn()
    const request = { view: 'documentDeliverables', focus: 'out/a.md' }
    const { rerender } = render(
      <StudioView {...studioProps([])} viewRequest={request} completeViewRequest={completeViewRequest} />,
    )
    expect(await screen.findByText(t('studio.empty'))).toBeTruthy()
    // An empty list cannot resolve the request, so the request survives.
    expect(completeViewRequest).not.toHaveBeenCalled()
    // A list that does not hold the named file still settles the request.
    rerender(
      <StudioView
        {...studioProps([{ seq: 1, path: 'out/b.md' }])}
        viewRequest={{ view: 'documentDeliverables', focus: 'out/gone.md' }}
        completeViewRequest={completeViewRequest}
      />,
    )
    expect(await screen.findByText('<h1>out/b.md</h1>')).toBeTruthy()
    expect(completeViewRequest).toHaveBeenCalledTimes(1)
  })

  it('drops a read that settles after the selection moved on', async () => {
    let rejectFirst: (reason: unknown) => void = () => {}
    const readFileText = vi.fn((path: string) => path === 'out/a.md'
      ? new Promise<never>((_, reject) => { rejectFirst = reject })
      : Promise.resolve({ content: '# B', truncated: false }))
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/a.md' }, { seq: 2, path: 'out/b.md' }], { readFileText })} />,
    )
    fireEvent.click(screen.getAllByText('b.md')[0]!)
    expect(await screen.findByText('# B')).toBeTruthy()
    rejectFirst(new Error('late failure'))
    await vi.waitFor(() => { expect(screen.queryByText(t('studio.error.notText'))).toBeNull() })
  })

  it('localizes every read failure by its Host code, including a client-side decode failure', async () => {
    const cases: Array<[unknown, string]> = [
      [new WorkspaceReadError('outside', 'workspace-file/outside-workspace'), t('studio.error.denied')],
      [new WorkspaceReadError('too big', 'workspace-file/too-large'), t('studio.error.generic', { message: 'too big' })],
      [new Error('not valid UTF-8: out/a.md'), t('studio.error.notText')],
      ['unreadable', t('studio.error.notText')],
    ]
    for (const [rejection, expected] of cases) {
      cleanup()
      // The view has a non-Error rejection arm that must be exercised.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the rejection reason is the fixture
      const readFileText = vi.fn(() => Promise.reject(rejection))
      render(<StudioView {...studioProps([{ seq: 1, path: 'out/a.md' }], { readFileText })} />)
      expect(await screen.findByText(expected)).toBeTruthy()
    }
  })

  it('leaves the verdict unmarked when the Host cannot stat the file, and keeps it while the token holds', async () => {
    const unstatable = vi.fn(() => Promise.resolve({}))
    render(
      <StudioView {...studioProps([{
        seq: 1, path: 'out/r.html', checks: { status: 'checked', findings: [] },
      }], { statVersions: unstatable })} />,
    )
    expect(await screen.findByText(t('studio.file.checkedPassed'))).toBeTruthy()

    cleanup()
    const statVersions = vi.fn(() => Promise.resolve({ 'out/r.html': 'v1' }))
    const produced = () => [{ seq: 1, path: 'out/r.html', checks: { status: 'checked', findings: [] } }]
    const { rerender } = render(<StudioView {...studioProps(produced(), { statVersions })} />)
    expect(await screen.findByText(t('studio.file.checkedPassed'))).toBeTruthy()
    rerender(<StudioView {...studioProps(produced(), { statVersions })} />)
    await vi.waitFor(() => { expect(statVersions).toHaveBeenCalledTimes(2) })
    expect(screen.getByText(t('studio.file.checkedPassed'))).toBeTruthy()
    expect(screen.queryByText(t('studio.file.changed'))).toBeNull()
  })

  it('clears the changed marker once no listed file carries a verdict', async () => {
    const statVersions = vi.fn()
      .mockResolvedValueOnce({ 'out/r.html': 'v1' })
      .mockResolvedValueOnce({ 'out/r.html': 'v2' })
    const checked = [{ seq: 1, path: 'out/r.html', format: 'html', checks: { status: 'checked', findings: [] } }]
    const { rerender } = render(<StudioView {...studioProps(checked, { statVersions })} />)
    expect(await screen.findByText(t('studio.file.checkedPassed'))).toBeTruthy()
    // Let the first stat settle so its token becomes the baseline the next one moves.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    rerender(<StudioView {...studioProps([{ seq: 1, path: 'out/r.html', format: 'html', checks: { status: 'checked', findings: [] } }], { statVersions })} />)
    expect(await screen.findByText(t('studio.file.changed'))).toBeTruthy()
    rerender(<StudioView {...studioProps([{ seq: 2, path: 'out/plain.md' }], { statVersions })} />)
    expect(await screen.findByText('<h1>out/plain.md</h1>')).toBeTruthy()
    expect(screen.queryByText(t('studio.file.changed'))).toBeNull()
  })

  it('drops a freshness stat that settles after the produced list changed, and one that fails', async () => {
    const resolvers: Array<(versions: Record<string, string>) => void> = []
    const statVersions = vi.fn(() => new Promise<Record<string, string>>((resolve) => { resolvers.push(resolve) }))
    const checked = () => [{ seq: 1, path: 'out/r.html', checks: { status: 'checked', findings: [] } }]
    const { rerender } = render(<StudioView {...studioProps(checked(), { statVersions })} />)
    rerender(<StudioView {...studioProps(checked(), { statVersions })} />)
    await vi.waitFor(() => { expect(resolvers).toHaveLength(2) })
    // The first effect's window closed with the list; its answer must not land.
    resolvers[0]!({ 'out/r.html': 'v2' })
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(screen.queryByText(t('studio.file.changed'))).toBeNull()
    resolvers[1]!({ 'out/r.html': 'v1' })
    await vi.waitFor(() => { expect(statVersions).toHaveBeenCalledTimes(2) })
    expect(screen.getByText(t('studio.file.checkedPassed'))).toBeTruthy()
  })

  it('leaves the verdict unmarked when the freshness stat fails', async () => {
    const statVersions = vi.fn(() => Promise.reject(new Error('stat unavailable')))
    render(
      <StudioView {...studioProps([{
        seq: 1, path: 'out/r.html', checks: { status: 'checked', findings: [] },
      }], { statVersions })} />,
    )
    expect(await screen.findByText(t('studio.file.checkedPassed'))).toBeTruthy()
    await vi.waitFor(() => { expect(statVersions).toHaveBeenCalledTimes(1) })
    expect(screen.queryByText(t('studio.file.changed'))).toBeNull()
  })

  it('drops a probe answer that a later scan superseded', async () => {
    const resolvers: Array<(paths: string[]) => void> = []
    const probeUnregistered = vi.fn(() => new Promise<string[]>((resolve) => { resolvers.push(resolve) }))
    const { rerender } = render(<StudioView {...studioProps([], { probeUnregistered })} />)
    // Produced files arriving and leaving again closes the first scan's window.
    rerender(<StudioView {...studioProps([{ seq: 1, path: 'out/report.md' }], { probeUnregistered })} />)
    rerender(<StudioView {...studioProps([], { probeUnregistered })} />)
    await vi.waitFor(() => { expect(resolvers).toHaveLength(2) })
    resolvers[0]!(['out/stale.md'])
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(screen.queryByText('out/stale.md')).toBeNull()
    resolvers[1]!(['out/fresh.md'])
    expect(await screen.findByText('out/fresh.md')).toBeTruthy()
  })

  it('drops a workspace probe that settles after the studio unmounts', async () => {
    let resolveProbe: (paths: string[]) => void = () => {}
    let rejectProbe: (reason: unknown) => void = () => {}
    const resolved = vi.fn(() => new Promise<string[]>((resolve) => { resolveProbe = resolve }))
    const rejected = vi.fn(() => new Promise<string[]>((_, reject) => { rejectProbe = reject }))

    const first = render(<StudioView {...studioProps([], { probeUnregistered: resolved })} />)
    first.unmount()
    resolveProbe(['out/late.md'])
    await Promise.resolve()

    const second = render(<StudioView {...studioProps([], { probeUnregistered: rejected })} />)
    second.unmount()
    rejectProbe(new Error('late failure'))
    await Promise.resolve()
    expect(screen.queryByText(t('studio.empty.scanFailed', { message: 'late failure' }))).toBeNull()
  })

  it('reports a non-error probe failure as its string form', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const probeUnregistered = vi.fn(() => Promise.reject('offline'))
    render(<StudioView {...studioProps([], { probeUnregistered })} />)
    expect(await screen.findByText(t('studio.empty.scanFailed', { message: 'offline' }))).toBeTruthy()
  })

  it('reports a non-error action failure as its string form', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection is the case under test
    const showInFolder = vi.fn(() => Promise.reject('denied'))
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/report.md' }], { showInFolder })} />)
    fireEvent.click(screen.getByText(t('studio.action.folder')))
    expect(await screen.findByText(t('studio.action.revealFailed', { message: 'denied' }))).toBeTruthy()
  })

  it('hands the previewed file to the sidebar from the action row', async () => {
    const openInSidebar = vi.fn(() => true)
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/report.md' }], { openInSidebar })} />)
    expect(await screen.findByText('<h1>out/report.md</h1>')).toBeTruthy()
    fireEvent.click(screen.getAllByText(t('studio.action.previewSidebar'))[0]!)
    expect(openInSidebar).toHaveBeenCalledWith('out/report.md')
  })

  it('requests a revision of a file with no machine findings, and reports a refused insert', async () => {
    const insertDraft = vi.fn((_text: string) => false)
    render(<StudioView {...studioProps([{ seq: 1, path: 'out/plain.md' }], { insertDraft })} />)
    fireEvent.click(screen.getByText(t('studio.action.revise')))
    expect(insertDraft).toHaveBeenCalledWith(t('studio.revise.none'))
    expect(screen.queryByText(t('studio.revise.inserted'))).toBeNull()
  })

  it('lists a finding that carries no line number as one item', async () => {
    const insertDraft = vi.fn((_text: string) => true)
    render(
      <StudioView {...studioProps([{
        seq: 1, path: 'out/warned.md',
        checks: { status: 'checked', findings: [{ check: 'c', level: 'warn', detail: '无行号提示' }] },
      }], { insertDraft })} />,
    )
    fireEvent.click(screen.getByText(t('studio.action.revise')))
    const draft = insertDraft.mock.calls[0]?.[0] ?? ''
    expect(draft).toContain('无行号提示')
    expect(draft).not.toContain('第 ')
  })

  it('reports the Host cap in a readable size when a complete read refuses the file', async () => {
    const caps: Array<[number, string]> = [[512, '512B'], [2048, '2.0KB'], [5 * 1024 * 1024, '5.0MB']]
    for (const [limitBytes, size] of caps) {
      cleanup()
      const readFileTextComplete = vi.fn((): Promise<CompleteReadText> =>
        Promise.resolve({ truncated: true, limitBytes }))
      render(
        <StudioView {...studioProps([{ seq: 1, path: 'out/big.html' }], {
          readFileText: vi.fn(() => Promise.resolve({ content: '<h1>head</h1>', truncated: true })),
          readFileTextComplete,
        })} />,
      )
      await screen.findByTitle('big.html')
      fireEvent.click(screen.getByText(t('studio.action.print')))
      expect(await screen.findByText(t('studio.print.failed', {
        message: t('studio.print.tooLarge', { limit: size }),
      }))).toBeTruthy()
      expect(readFileTextComplete).toHaveBeenCalledWith('out/big.html')
    }
  })

  it('prints the complete file when the preview window was cut', async () => {
    const write = vi.fn()
    const open = vi.spyOn(window, 'open').mockReturnValue({
      document: { open: vi.fn(), write, close: vi.fn() },
      focus: vi.fn(),
      print: vi.fn(),
    } as never)
    const readFileTextComplete = vi.fn((): Promise<CompleteReadText> =>
      Promise.resolve({ truncated: false, content: '<html>full</html>' }))
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/big.html' }], {
        readFileText: vi.fn(() => Promise.resolve({ content: '<html>head', truncated: true })),
        readFileTextComplete,
      })} />,
    )
    await screen.findByTitle('big.html')
    fireEvent.click(screen.getByText(t('studio.action.print')))
    await vi.waitFor(() => { expect(write).toHaveBeenCalledWith('<html>full</html>') })
    open.mockRestore()
  })

  it('reports a failed complete read beside the file it could not print', async () => {
    const cases: Array<[unknown, string]> = [
      [new WorkspaceReadError('gone', 'workspace-file/not-found'), t('studio.error.notFound')],
      [new Error('disk full'), 'disk full'],
      ['unreadable', 'unreadable'],
    ]
    for (const [rejection, message] of cases) {
      cleanup()
      render(
        <StudioView {...studioProps([{ seq: 1, path: 'out/big.html' }], {
          readFileText: vi.fn(() => Promise.resolve({ content: '<h1>head</h1>', truncated: true })),
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the rejection reason is the fixture
          readFileTextComplete: vi.fn(() => Promise.reject(rejection)),
        })} />,
      )
      await screen.findByTitle('big.html')
      fireEvent.click(screen.getByText(t('studio.action.print')))
      expect(await screen.findByText(t('studio.print.failed', { message }))).toBeTruthy()
    }
  })

  it('prints through the desktop bridge and reports saved, failed, and dismissed outcomes', async () => {
    const printHtmlToPdf = vi.fn()
      .mockResolvedValueOnce({ path: '/tmp/out/report.pdf' })
      .mockResolvedValueOnce({ error: 'raster failed' })
      .mockResolvedValueOnce({ cancelled: true })
      .mockResolvedValueOnce({})
    window.desktop = { printHtmlToPdf }
    try {
      render(<StudioView {...studioProps([{ seq: 1, path: 'out/report.html' }])} />)
      await screen.findByTitle('report.html')

      fireEvent.click(screen.getByText(t('studio.action.print')))
      expect(await screen.findByText(t('studio.print.exported', { path: '/tmp/out/report.pdf' }))).toBeTruthy()
      expect(printHtmlToPdf).toHaveBeenCalledWith({
        html: '<h1>out/report.html</h1>', suggestedName: 'report.html',
      })

      fireEvent.click(screen.getByText(t('studio.action.print')))
      expect(await screen.findByText(t('studio.print.failed', { message: 'raster failed' }))).toBeTruthy()

      fireEvent.click(screen.getByText(t('studio.action.print')))
      await vi.waitFor(() => { expect(printHtmlToPdf).toHaveBeenCalledTimes(3) })
      expect(screen.queryByText(t('studio.print.failed', { message: 'raster failed' }))).toBeNull()

      fireEvent.click(screen.getByText(t('studio.action.print')))
      await vi.waitFor(() => { expect(printHtmlToPdf).toHaveBeenCalledTimes(4) })
      expect(screen.queryByText(t('studio.print.failed', { message: 'raster failed' }))).toBeNull()
    } finally {
      delete window.desktop
    }
  })

  it('inserts a reference for a section without a heading and reports a refused insert', async () => {
    const insertDraft = vi.fn((_text: string) => false)
    const html = '<section data-doc-id="plain"><p>x</p></section>'
    render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/report.html' }], {
        insertDraft,
        readFileText: vi.fn(() => Promise.resolve({ content: html, truncated: false })),
      })} />,
    )
    await screen.findByTitle('report.html')
    fireEvent.change(screen.getByLabelText(t('studio.section.pick')), { target: { value: 'plain' } })
    fireEvent.click(screen.getByText(t('studio.section.insert')))
    expect(insertDraft).toHaveBeenCalledWith(
      `${t('studio.section.reference', { path: 'out/report.html', id: 'plain' })}\n\n${t('studio.section.instruction')}`,
    )
    expect(screen.queryByText(t('studio.section.inserted'))).toBeNull()
  })

  it('ignores a section pick the reloaded document no longer declares', async () => {
    const insertDraft = vi.fn(() => true)
    const first = '<section data-doc-id="sec-a"><h2>A</h2></section>'
    const second = '<section data-doc-id="sec-b"><h2>B</h2></section>'
    const { rerender } = render(
      <StudioView {...studioProps([{ seq: 1, path: 'out/report.html' }], {
        insertDraft,
        readFileText: vi.fn(() => Promise.resolve({ content: first, truncated: false })),
      })} />,
    )
    await screen.findByTitle('report.html')
    fireEvent.change(screen.getByLabelText(t('studio.section.pick')), { target: { value: 'sec-a' } })
    rerender(
      <StudioView {...studioProps([{ seq: 1, path: 'out/report.html' }], {
        insertDraft,
        readFileText: vi.fn(() => Promise.resolve({ content: second, truncated: false })),
      })} />,
    )
    expect(await screen.findByText('sec-b · B')).toBeTruthy()
    fireEvent.click(screen.getByText(t('studio.section.insert')))
    expect(insertDraft).not.toHaveBeenCalled()
  })

  it('classifies preview kinds by extension and parses declared sections', () => {
    expect(isHtmlPath('a.html')).toBe(true)
    expect(isHtmlPath('a.htm')).toBe(true)
    expect(isHtmlPath('a.HTML')).toBe(true)
    expect(isHtmlPath('a.pdf')).toBe(false)
    expect(isTextPreviewable('a.md')).toBe(true)
    expect(isTextPreviewable('a.json')).toBe(true)
    expect(isTextPreviewable('a.yml')).toBe(true)
    expect(isTextPreviewable('a.csv')).toBe(true)
    expect(isTextPreviewable('a.png')).toBe(false)

    expect(parseDocumentSections(
      '<section data-doc-id="one"><h2>One &amp; only</h2></section>'
      + '<section class="x" data-doc-id=\'two\'><p>no heading</p></section>'
      + '<section data-doc-id="one"><h2>duplicate</h2></section>',
    )).toEqual([
      { id: 'one', heading: 'One & only' },
      { id: 'two', heading: '' },
    ])
  })
})
