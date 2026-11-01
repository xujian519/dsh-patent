/**
 * Document studio view: the session's produced files (from the
 * `documentDeliverables` target) as a selectable list with an HTML/text
 * preview pane, the quality-gate claims the model declared, and the file
 * actions. Pure presentation: file facts arrive through the conversation
 * snapshot, workspace probes and file bytes through injected host callbacks,
 * and user actions through injected callbacks.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { fileSizeText, pathBasename } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { DocumentDeliverable } from './document-deliverables.ts'
import { DOCUMENT_DELIVERABLES_TARGET } from './document-deliverables.ts'
import { DOCUMENT_PRESET_ID } from './auto-switch.ts'
import type { CompleteReadText, ReadFileText } from './file-reads.ts'
import { WorkspaceReadError } from './file-reads.ts'
import type { KnownPath } from './workspace-probe.ts'
import { parentDir } from './paths.ts'
import css from './StudioView.module.css'

/** Studio view props: runtime session share + injected callbacks + locale. */
export type StudioViewProps =
  & ConvViewProps
  & InjectFace<StudioViewInjected>
  & PropsLocale<'documentStudio'>

/** Plain callbacks the apply-world inject supplies (paths are workspace-relative). */
export interface StudioViewInjected {
  /** Whether the browser reaches the host over a loopback authority. */
  isLoopback: boolean
  /** Whether the sidebar preview surface is mounted (it renders Office and PDF files). */
  canOpenInSidebar: boolean
  /** Open one produced file with the OS default application. */
  openFile: (path: string) => Promise<void>
  /** Reveal one produced file in the OS file manager (only when supported). */
  showInFolder: (path: string) => Promise<void>
  /** Hand one produced file to the sidebar preview. */
  openInSidebar: (path: string) => boolean
  /** Read one produced file's bounded text head through the host's window cap. */
  readFileText: (path: string) => Promise<ReadFileText>
  /** Read one produced file completely, or the host cap that refused it. */
  readFileTextComplete: (path: string) => Promise<CompleteReadText>
  /** Read the current freshness token of each produced path. */
  statVersions: (paths: readonly string[]) => Promise<Readonly<Record<string, string>>>
  /** List deliverable-shaped workspace files that no registration recorded. */
  probeUnregistered: (known: readonly KnownPath[]) => Promise<readonly string[]>
  /** Append text to the session's composer draft without sending it. */
  insertDraft: (text: string) => boolean
}

/** One read failure, kept with the Host code so its message can be localized. */
interface ReadFailure {
  readonly code: string | undefined
  readonly message: string
}

/** The empty state's workspace probe; a failure carries the message it reports. */
type ScanState =
  | { readonly state: 'idle' | 'scanning'; readonly paths: readonly string[] }
  | { readonly state: 'done'; readonly paths: readonly string[] }
  | { readonly state: 'failed'; readonly paths: readonly string[]; readonly message: string }

/** Stable empty list so the selector never allocates per snapshot. */
const EMPTY_PRODUCED: readonly DocumentDeliverable[] = []

/** The one section picker's id, so its label can be associated with it. */
const SECTION_SELECT_ID = 'document-studio-section'

/** Whether a produced path renders as an inline HTML frame. */
export function isHtmlPath(path: string): boolean {
  return /\.html?$/i.test(path)
}

/** Whether a produced path renders as plain text in the preview pane. */
export function isTextPreviewable(path: string): boolean {
  return isHtmlPath(path) || /\.(md|txt|json|ya?ml|csv|log)$/i.test(path)
}

/** The failure message one read reports, localized by the Host's wire code. */
function readFailureText(failure: ReadFailure, t: StudioViewProps['t']): string {
  switch (failure.code) {
    case 'workspace-file/not-found':
    case 'workspace-file/not-regular-file':
      return t('studio.error.notFound')
    case 'workspace-file/outside-workspace':
      return t('studio.error.denied')
    default:
      // A client-side decode failure carries no wire code: the bytes were not
      // UTF-8, which is the same "no text preview" outcome.
      return failure.code === undefined
        ? t('studio.error.notText')
        : t('studio.error.generic', { message: failure.message })
  }
}

/** One section a delivered HTML file declares, for the reference draft. */
export interface DocumentSection {
  readonly id: string
  readonly heading: string
}

/** Strip tags and decode the few entities a heading realistically carries. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Read the `data-doc-id` sections a delivered HTML file declares.
 *
 * The preview frame is sandboxed without script or same-origin access, so the
 * parent cannot read a text selection inside it; the section ids come from the
 * source text the preview already holds. A heading is the first `<h1>`–`<h3>`
 * up to the next section.
 * @param html - the delivered HTML source.
 * @returns declared sections in document order, ids trimmed and de-duplicated.
 */
export function parseDocumentSections(html: string): readonly DocumentSection[] {
  const starts = [...html.matchAll(/<section\b[^>]*?data-doc-id\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)]
  const sections: DocumentSection[] = []
  const seen = new Set<string>()
  starts.forEach((start, index) => {
    const captured = start[1] ?? start[2]
    /* v8 ignore next -- the alternation captures exactly one quote style, so the empty fallback only narrows the array access */
    const id = (captured ?? '').trim()
    if (id === '' || seen.has(id)) return
    seen.add(id)
    const body = html.slice(start.index, starts[index + 1]?.index ?? html.length)
    const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(body)
    if (heading === null) {
      sections.push({ id, heading: '' })
      return
    }
    /* v8 ignore next -- a matched heading always captures its inner HTML; the fallback only narrows the array access */
    sections.push({ id, heading: plainText(heading[1] ?? '') })
  })
  return sections
}

/** One produced file paired with the label its list row shows. */
interface FileRow {
  readonly file: DocumentDeliverable
  /** The list label: the basename, plus the parent directory when another file shares it. */
  label: string
}

/**
 * Pair each produced file with its list label.
 * @param produced - the session's produced files, in display order.
 * @returns one row per produced file, in the same order.
 */
function fileRows(produced: readonly DocumentDeliverable[]): readonly FileRow[] {
  const rows: FileRow[] = produced.map(file => ({ file, label: pathBasename(file.path) }))
  const byName = new Map<string, FileRow[]>()
  for (const row of rows) {
    const name = pathBasename(row.file.path)
    const group = byName.get(name)
    if (group === undefined) byName.set(name, [row])
    else group.push(row)
  }
  for (const [name, group] of byName) {
    if (group.length === 1) continue
    for (const row of group) row.label = `${name} · ${parentDir(row.file.path)}`
  }
  return rows
}

/** Outcome of one desktop print-to-PDF request (mirror of the preload bridge). */
export interface DesktopPrintResult {
  /** Saved file path on success. */
  path?: string
  /** The user dismissed the save dialog. */
  cancelled?: true
  /** Print, raster, or save failure message. */
  error?: string
}

/** The desktop shell's `window.desktop` surface, when running under Electron. */
export interface DesktopPrintBridge {
  printHtmlToPdf(payload: { html: string; suggestedName?: string }): Promise<DesktopPrintResult>
}

/** One print request's settled outcome, reported beside the file it printed. */
type PrintOutcome =
  | { readonly path: string; readonly kind: 'saved'; readonly saved: string }
  | { readonly path: string; readonly kind: 'failed'; readonly message: string }

declare global {
  interface Window {
    /** Allow-listed Electron preload bridge; absent outside the desktop app. */
    desktop?: DesktopPrintBridge
  }
}

/**
 * Print one HTML document through the browser's print dialog (PDF save).
 * @param content - the complete standalone HTML document.
 * @returns false when the browser blocked the print window.
 */
function printHtmlDocument(content: string): boolean {
  const win = window.open('', '_blank')
  if (win === null) return false
  win.document.open()
  // document.write is the only way to print a complete standalone HTML
  // document from a popup window.
  win.document.write(content)
  win.document.close()
  win.focus()
  win.print()
  return true
}

/** The machine-check badge: the recorded outcome, or the visible degrade note when this console cannot read it. */
function CheckBadge({ checks, t }: { checks: DocumentDeliverable['checks']; t: StudioViewProps['t'] }): ReactNode {
  if (checks === undefined) return null
  const details = [
    ...checks.reason === undefined ? [] : [checks.reason],
    ...checks.findings.map(finding => finding.detail),
  ]
  const title = details.length === 0 ? undefined : details.join('\n')
  if (checks.status === 'checked') {
    return checks.findings.length === 0
      ? <span className={`${css.badge} ${css.gatePassed}`} title={title}>{t('studio.file.checkedPassed')}</span>
      : (
        <span className={`${css.badge} ${css.checkFindings}`} title={title}>
          {t('studio.file.checkedFindings', { count: checks.findings.length })}
        </span>
      )
  }
  // A status a newer harness records falls through to this visible degrade
  // note: the badge never claims a check that this console cannot read.
  return (
    <span className={`${css.badge} ${css.gateMissing}`} title={title}>
      {checks.status === 'unreadable' ? t('studio.file.checkedFailed') : t('studio.file.checkedSkipped')}
    </span>
  )
}

/**
 * One produced file's badges: the announced export format, the announced
 * quality-gate state (the model's own claim, so it never wears the success
 * color), and the machine-derived check outcome.
 *
 * A file whose recorded verdict was withdrawn — because the fold saw a later
 * rewrite, or because a freshness token moved under this console — shows the
 * changed badge instead of the verdict. Both are the same fact: the bytes now
 * on disk are unverified.
 */
function DeliverableBadges({ file, stale, documentSession, t }: {
  file: DocumentDeliverable
  stale: boolean
  documentSession: boolean
  t: StudioViewProps['t']
}): ReactNode {
  return (
    <>
      {file.format !== undefined && (
        <span className={css.badge}>{file.format}</span>
      )}
      {file.gate !== undefined
        ? (
          <span className={`${css.badge} ${css.gateClaim}`}>
            {gateClaimLabel(file.gate, t)}
          </span>
        )
        : documentSession && (
          <span className={`${css.badge} ${css.gateMissing}`}>{t('studio.file.gateMissing')}</span>
        )}
      {stale || file.checksWithdrawn === true
        ? <span className={`${css.badge} ${css.checkStale}`}>{t('studio.file.changed')}</span>
        : <CheckBadge checks={file.checks} t={t} />}
    </>
  )
}

/**
 * The claim badge's text: the declared P0/P1 item names when they fit, so the
 * badge itself never reduces a claim to a count the user cannot inspect.
 * @param gate - the declared gate state.
 * @param t - the dictionary seat.
 * @returns the badge text.
 */
function gateClaimLabel(gate: { readonly p0: readonly string[]; readonly p1: readonly string[] }, t: StudioViewProps['t']): string {
  const items = [...gate.p0, ...gate.p1]
  const compact = items.every(item => item.length <= 16) && items.length <= 3
  return compact
    ? t('studio.file.gateIds', { ids: items.join(' · ') })
    : t('studio.file.gateClaim', { p0: gate.p0.length, p1: gate.p1.length })
}

/** The model's gate claims, listed separately from the machine verdict. */
function GateClaim({ file, t }: { file: DocumentDeliverable | null; t: StudioViewProps['t'] }): ReactNode {
  if (file?.gate === undefined) return null
  return (
    <details className={css.claim}>
      <summary>{t('studio.claim.title')}</summary>
      <p className={css.note}>{t('studio.claim.p0')}</p>
      <ul className={css.claimList}>
        {file.gate.p0.map(item => <li key={item}>{item}</li>)}
      </ul>
      {file.gate.p1.length > 0 && (
        <>
          <p className={css.note}>{t('studio.claim.p1')}</p>
          <ul className={css.claimList}>
            {file.gate.p1.map(item => <li key={item}>{item}</li>)}
          </ul>
        </>
      )}
    </details>
  )
}

/**
 * Renders the session deliverable list and preview pane.
 * @param props - session runtime share, injected callbacks, locale share.
 * @returns the studio view.
 */
export function StudioView({
  useConversation,
  useSessions,
  sessionId,
  viewRequest,
  completeViewRequest,
  isLoopback,
  canOpenInSidebar,
  openFile,
  showInFolder,
  openInSidebar,
  readFileText,
  readFileTextComplete,
  statVersions,
  probeUnregistered,
  insertDraft,
  t,
}: StudioViewProps): ReactNode {
  const produced = useConversation(snapshot => snapshot.views.get(DOCUMENT_DELIVERABLES_TARGET)?.produced ?? EMPTY_PRODUCED)
  // The gate badge is document-mode vocabulary: another preset's session lists
  // its touched files here too, and those carry no gate to be missing.
  const documentSession = useSessions(snapshot =>
    snapshot.byId[sessionId]?.projectionValues?.agentPreset === DOCUMENT_PRESET_ID)
  // No reactive host-capability probe survives the runtime removal; the folder
  // action degrades to loopback-only.
  const canShowInFolder = isLoopback
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [content, setContent] = useState<{ text: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<ReadFailure | null>(null)
  const [printOutcome, setPrintOutcome] = useState<PrintOutcome | null>(null)
  const [actionFailure, setActionFailure] = useState<{ path: string; message: string } | null>(null)
  const [draftNotice, setDraftNotice] = useState<{ path: string; kind: 'revise' | 'section' } | null>(null)
  const [scan, setScan] = useState<ScanState>({ state: 'idle', paths: [] })
  const [scanNonce, setScanNonce] = useState(0)
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set())
  const [sectionId, setSectionId] = useState<string>('')
  // Freshness tokens captured the first time this console saw a checked entry:
  // a later token means the bytes moved under the recorded verdict.
  const baselines = useRef<Record<string, string>>({})

  // Keep the selection on a produced file: drop stale selections, adopt the
  // first produced file when the list first gains entries.
  useEffect(() => {
    if (selectedPath !== null && produced.some(file => file.path === selectedPath)) return
    setSelectedPath(produced[0]?.path ?? null)
  }, [produced, selectedPath])

  // Honor a one-shot focus request naming one produced file. The shell knows
  // no file identity, so the request carries the produced path.
  useEffect(() => {
    if (viewRequest === null || viewRequest.view !== DOCUMENT_DELIVERABLES_TARGET) return
    // Wait for the list rather than acknowledging a request this console cannot
    // resolve yet; the request survives until it can.
    if (produced.length === 0) return
    if (produced.some(file => file.path === viewRequest.focus)) setSelectedPath(viewRequest.focus)
    completeViewRequest()
  }, [viewRequest, produced, completeViewRequest])

  // Load the selected file's text on selection change; only previewable
  // kinds read bytes at all.
  useEffect(() => {
    if (selectedPath === null || !isTextPreviewable(selectedPath)) {
      setContent(null)
      setError(null)
      return
    }
    let cancelled = false
    setContent(null)
    setError(null)
    readFileText(selectedPath).then(
      (result) => {
        if (cancelled) return
        setContent({ text: result.content, truncated: result.truncated })
      },
      (reason: unknown) => {
        if (cancelled) return
        setError(reason instanceof WorkspaceReadError
          ? { code: reason.code, message: reason.message }
          : { code: undefined, message: reason instanceof Error ? reason.message : String(reason) })
      },
    )
    return () => { cancelled = true }
  }, [selectedPath, readFileText])

  // Compare each checked entry's current freshness token with the one captured
  // when this console first saw it. Runs when the produced list changes, never
  // on a timer: a moved token means the verdict describes bytes that are gone.
  useEffect(() => {
    const checked = produced.filter(file => file.checks !== undefined)
    if (checked.length === 0) {
      setStale(previous => previous.size === 0 ? previous : new Set())
      return
    }
    let cancelled = false
    statVersions(checked.map(file => file.path)).then(
      (current) => {
        if (cancelled) return
        const moved = new Set<string>()
        for (const file of checked) {
          const version = current[file.path]
          if (version === undefined) continue
          const baseline = baselines.current[file.path]
          if (baseline === undefined) {
            baselines.current[file.path] = version
            continue
          }
          if (baseline !== version) moved.add(file.path)
        }
        setStale(moved)
      },
      () => {
        // An unreadable stat leaves the verdict unmarked; the preview reports
        // the read failure when the user selects that file.
      },
    )
    return () => { cancelled = true }
  }, [produced, statVersions])

  // Probe the workspace once when the list is empty, and again only when the
  // user asks (the nonce): the empty state must separate "nothing produced"
  // from "produced but never registered". The probe state is not a dependency,
  // so writing it cannot cancel the request that produced it.
  useEffect(() => {
    if (produced.length > 0) return
    let cancelled = false
    setScan({ state: 'scanning', paths: [] })
    // The empty state probes with an empty known list: it only renders here
    // when the session listed nothing, so there is no produced file to exempt.
    probeUnregistered([]).then(
      (paths) => { if (!cancelled) setScan({ state: 'done', paths }) },
      (reason: unknown) => {
        if (!cancelled) {
          setScan({
            state: 'failed',
            paths: [],
            message: reason instanceof Error ? reason.message : String(reason),
          })
        }
      },
    )
    return () => { cancelled = true }
  }, [produced, scanNonce, probeUnregistered])

  const htmlPreview = useMemo(
    () => selectedPath !== null && isHtmlPath(selectedPath) ? content?.text ?? null : null,
    [selectedPath, content],
  )
  const textPreview = useMemo(
    () => selectedPath !== null && !isHtmlPath(selectedPath) ? content?.text ?? null : null,
    [selectedPath, content],
  )
  const selected = useMemo(
    () => produced.find(file => file.path === selectedPath) ?? null,
    [produced, selectedPath],
  )
  const rows = useMemo(() => fileRows(produced), [produced])
  const selectedName = selected === null ? '' : pathBasename(selected.path)
  const previewable = selectedPath !== null && isTextPreviewable(selectedPath)
  const sections = useMemo(
    () => selectedPath !== null && isHtmlPath(selectedPath) && content !== null
      ? parseDocumentSections(content.text)
      : [],
    [selectedPath, content],
  )
  // The HTML the print action exports: the previewed document while the frame
  // is showing, so the action never has to re-check a null it cannot see.
  const printable = selectedPath !== null && htmlPreview !== null
    ? { path: selectedPath, html: htmlPreview }
    : null
  const notice = draftNotice !== null && draftNotice.path === selectedPath ? draftNotice.kind : null

  // One preview pane per state; the hint covers only "nothing selected", so a
  // selected binary file says what to do with it instead of asking again.
  let preview: ReactNode
  if (selectedPath === null) {
    preview = <div className={css.note}>{t('studio.preview.hint')}</div>
  } else if (error !== null) {
    preview = <div className={css.error}>{readFailureText(error, t)}</div>
  } else if (htmlPreview !== null) {
    preview = <iframe className={css.frame} title={selectedName} sandbox="" srcDoc={htmlPreview} />
  } else if (textPreview !== null) {
    preview = (
      <div className={css.textPreview}>
        {textPreview}
        {content?.truncated === true && (
          <p className={css.note}>{t('studio.preview.truncated')}</p>
        )}
      </div>
    )
  } else if (!previewable) {
    preview = (
      <div className={css.sidebarOnly}>
        <p className={css.note}>{t('studio.preview.sidebarOnly')}</p>
        {canOpenInSidebar && (
          <button type="button" className={css.action} onClick={() => { openInSidebar(selectedPath) }}>
            {t('studio.action.previewSidebar')}
          </button>
        )}
      </div>
    )
  } else {
    preview = null
  }

  const onPrint = async (target: { readonly path: string; readonly html: string }): Promise<void> => {
    setPrintOutcome(null)
    // The preview read is the host's bounded window; re-read completely so the
    // PDF is not silently the cut head.
    let html = target.html
    if (content?.truncated === true) {
      try {
        const full = await readFileTextComplete(target.path)
        if (full.truncated) {
          setPrintOutcome({
            path: target.path,
            kind: 'failed',
            message: t('studio.print.tooLarge', { limit: fileSizeText(full.limitBytes) }),
          })
          return
        }
        html = full.content
      } catch (reason: unknown) {
        setPrintOutcome({
          path: target.path,
          kind: 'failed',
          message: reason instanceof WorkspaceReadError
            ? readFailureText(reason, t)
            : reason instanceof Error ? reason.message : String(reason),
        })
        return
      }
    }
    if (window.desktop?.printHtmlToPdf !== undefined) {
      const result = await window.desktop.printHtmlToPdf({
        html,
        suggestedName: pathBasename(target.path),
      })
      if (result.error !== undefined) {
        setPrintOutcome({ path: target.path, kind: 'failed', message: result.error })
      } else if (result.cancelled !== true && result.path !== undefined) {
        setPrintOutcome({ path: target.path, kind: 'saved', saved: result.path })
      }
      return
    }
    if (!printHtmlDocument(html)) {
      setPrintOutcome({ path: target.path, kind: 'failed', message: t('studio.print.blocked') })
    }
  }

  /** Run one file action, reporting a failure beside the action that failed. */
  const runAction = (path: string, action: () => Promise<void>, failed: (message: string) => string): void => {
    setActionFailure(null)
    action().catch((reason: unknown) => {
      setActionFailure({ path, message: failed(reason instanceof Error ? reason.message : String(reason)) })
    })
  }

  // The revision draft names the machine's findings, one line each. It goes to
  // the composer and is never sent: the user edits and submits it.
  const reviseDraft = (file: DocumentDeliverable): string => {
    const findings = file.checks?.findings ?? []
    if (findings.length === 0) return t('studio.revise.none')
    return [
      t('studio.revise.prefix'),
      ...findings.map(finding => t('studio.revise.item', { detail: finding.detail })
        + (finding.line === undefined ? '' : t('studio.revise.line', { line: finding.line }))),
    ].join('\n')
  }

  return (
    <div className={css.studio} data-session-id={sessionId}>
      {produced.length === 0
        ? (
          <div className={css.empty}>
            <p className={css.emptyText}>{t('studio.empty')}</p>
            {scan.state === 'scanning' && <p className={css.note}>{t('studio.empty.scanning')}</p>}
            {scan.state === 'failed' && (
              <p className={css.note}>{t('studio.empty.scanFailed', { message: scan.message })}</p>
            )}
            {scan.state === 'done' && scan.paths.length > 0 && (
              <div className={css.candidates}>
                <p className={css.note}>{t('studio.empty.unregistered', { count: scan.paths.length })}</p>
                <ul className={css.candidateList}>
                  {scan.paths.map(path => <li key={path} className={css.candidate}>{path}</li>)}
                </ul>
                <p className={css.note}>{t('studio.empty.unregisteredHint')}</p>
              </div>
            )}
            <button
              type="button"
              className={css.action}
              disabled={scan.state === 'scanning'}
              onClick={() => { setScanNonce(nonce => nonce + 1) }}
            >
              {t('studio.empty.scan')}
            </button>
          </div>
        )
        : (
          <>
            <div className={css.listHeader} data-document-deliverables-list>
              <div className={css.files}>
                {rows.map(({ file, label }) => (
                  <button
                    key={file.path}
                    type="button"
                    data-document-deliverable={file.path}
                    className={`${css.file}${file.path === selectedPath ? ` ${css.fileActive}` : ''}`}
                    title={file.path}
                    onClick={() => { setSelectedPath(file.path); setSectionId('') }}
                  >
                    <span className={css.fileName}>{label}</span>
                    <DeliverableBadges
                      file={file}
                      stale={stale.has(file.path)}
                      documentSession={documentSession}
                      t={t}
                    />
                  </button>
                ))}
              </div>
              <span className={css.count}>{t('studio.files', { count: produced.length })}</span>
            </div>
            <div className={css.preview}>
              <div className={css.previewBar}>
                <span className={css.previewName}>{selectedName === '' ? t('studio.preview') : selectedName}</span>
                {selected !== null && (
                  <span className={css.actions}>
                    <button
                      type="button"
                      className={css.action}
                      onClick={() => { runAction(selected.path, () => openFile(selected.path), message => t('studio.action.openFailed', { message })) }}
                    >
                      {t('studio.action.open')}
                    </button>
                    {canShowInFolder && (
                      <button
                        type="button"
                        className={css.action}
                        onClick={() => { runAction(selected.path, () => showInFolder(selected.path), message => t('studio.action.revealFailed', { message })) }}
                      >
                        {t('studio.action.folder')}
                      </button>
                    )}
                    {canOpenInSidebar && previewable && (
                      <button type="button" className={css.action} onClick={() => { openInSidebar(selected.path) }}>
                        {t('studio.action.previewSidebar')}
                      </button>
                    )}
                    {printable !== null && (
                      <button type="button" className={css.action} onClick={() => { void onPrint(printable) }}>
                        {t('studio.action.print')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={css.action}
                      onClick={() => {
                        setDraftNotice(insertDraft(reviseDraft(selected)) ? { path: selected.path, kind: 'revise' } : null)
                      }}
                    >
                      {t('studio.action.revise')}
                    </button>
                  </span>
                )}
              </div>
              {htmlPreview !== null && <p className={css.printNote}>{t('studio.print.note')}</p>}
              {actionFailure !== null && actionFailure.path === selectedPath && (
                <p className={css.error}>{actionFailure.message}</p>
              )}
              {printOutcome !== null && printOutcome.path === selectedPath && (
                <p className={css.note}>
                  {printOutcome.kind === 'saved'
                    ? t('studio.print.exported', { path: printOutcome.saved })
                    : t('studio.print.failed', { message: printOutcome.message })}
                </p>
              )}
              {notice === 'revise' && <p className={css.note}>{t('studio.revise.inserted')}</p>}
              {htmlPreview !== null && content?.truncated === true && (
                <p className={css.note}>{t('studio.preview.truncated')}</p>
              )}
              {sections.length > 0 && (
                <div className={css.sections}>
                  <label className={css.note} htmlFor={SECTION_SELECT_ID}>{t('studio.section.pick')}</label>
                  <select
                    id={SECTION_SELECT_ID}
                    className={css.select}
                    value={sectionId}
                    onChange={(event) => { setSectionId(event.currentTarget.value) }}
                  >
                    <option value="">{t('studio.section.pick')}</option>
                    {sections.map(section => (
                      <option key={section.id} value={section.id}>
                        {section.heading === '' ? section.id : `${section.id} · ${section.heading}`}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={css.action}
                    disabled={sectionId === ''}
                    onClick={() => {
                      const section = sections.find(entry => entry.id === sectionId)
                      if (section === undefined || selectedPath === null) return
                      const reference = t('studio.section.reference', { path: selectedPath, id: section.id })
                      const heading = section.heading === '' ? '' : `（${section.heading}）`
                      setDraftNotice(insertDraft(`${reference}${heading}\n\n${t('studio.section.instruction')}`)
                        ? { path: selectedPath, kind: 'section' }
                        : null)
                    }}
                  >
                    {t('studio.section.insert')}
                  </button>
                  {notice === 'section' && <span className={css.note}>{t('studio.section.inserted')}</span>}
                </div>
              )}
              <GateClaim file={selected} t={t} />
              {preview}
            </div>
          </>
        )}
    </div>
  )
}
