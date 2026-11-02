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
import { PreviewPane } from './PreviewPane.tsx'
import { isHtmlPath, isTextPreviewable } from './preview-kinds.ts'
import { readFailureText } from './read-failure.ts'
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
  /** Build the `file` resource address one produced path subscribes to. */
  resourceAddress: (path: string) => string
  /** Deployment cap on an inline HTML preview, in bytes. */
  htmlPreviewMaxBytes: number
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

/** The empty state's workspace probe; a failure carries the message it reports. */
type ScanState =
  | { readonly state: 'idle' | 'scanning'; readonly paths: readonly string[] }
  | { readonly state: 'done'; readonly paths: readonly string[] }
  | { readonly state: 'failed'; readonly paths: readonly string[]; readonly message: string }

/** Stable empty list so the selector never allocates per snapshot. */
const EMPTY_PRODUCED: readonly DocumentDeliverable[] = []

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
interface DesktopPrintResult {
  /** Saved file path on success. */
  path?: string
  /** The user dismissed the save dialog. */
  cancelled?: true
  /** Print, raster, or save failure message. */
  error?: string
}

/** The desktop shell's `window.desktop` surface, when running under Electron. */
interface DesktopPrintBridge {
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
  // oxlint-disable-next-line typescript/no-deprecated
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
  useResource,
  sessionId,
  viewRequest,
  completeViewRequest,
  isLoopback,
  canOpenInSidebar,
  openFile,
  showInFolder,
  openInSidebar,
  resourceAddress,
  htmlPreviewMaxBytes,
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
  const [follow, setFollow] = useState(true)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  const [printOutcome, setPrintOutcome] = useState<PrintOutcome | null>(null)
  const [actionFailure, setActionFailure] = useState<{ path: string; message: string } | null>(null)
  const [draftNotice, setDraftNotice] = useState<{ path: string } | null>(null)
  const [scan, setScan] = useState<ScanState>({ state: 'idle', paths: [] })
  const [scanNonce, setScanNonce] = useState(0)
  const [stale, setStale] = useState<ReadonlySet<string>>(new Set())
  // Freshness tokens captured the first time this console saw a checked entry:
  // a later token means the bytes moved under the recorded verdict.
  const baselines = useRef<Record<string, string>>({})
  // The produced-list length at the previous render: only a growth is a new
  // file, and only a new file is worth following. A rewrite reuses its row.
  const producedCount = useRef(0)

  // Keep the selection on a produced file: drop stale selections, adopt a
  // produced file when the list first gains entries, and follow the last new
  // one while following is on.
  useEffect(() => {
    const previous = producedCount.current
    producedCount.current = produced.length
    const selectedExists = selectedPath !== null && produced.some(file => file.path === selectedPath)
    if (selectedExists) {
      if (!follow || produced.length <= previous) return
      setSelectedPath(produced[produced.length - 1]?.path ?? selectedPath)
      return
    }
    const fallback = follow ? produced[produced.length - 1]?.path : produced[0]?.path
    setSelectedPath(fallback ?? null)
  }, [produced, follow, selectedPath])

  // Honor a one-shot focus request naming one produced file. The shell knows
  // no file identity, so the request carries the produced path.
  useEffect(() => {
    if (viewRequest === null || viewRequest.view !== DOCUMENT_DELIVERABLES_TARGET) return
    // Wait for the list rather than acknowledging a request this console cannot
    // resolve yet; the request survives until it can.
    if (produced.length === 0) return
    if (produced.some(file => file.path === viewRequest.focus)) {
      // A focus request is a deliberate jump to one file, like a manual pick.
      setFollow(false)
      setSelectedPath(viewRequest.focus)
    }
    completeViewRequest()
  }, [viewRequest, produced, completeViewRequest])

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

  const selected = useMemo(
    () => produced.find(file => file.path === selectedPath) ?? null,
    [produced, selectedPath],
  )
  const rows = useMemo(() => fileRows(produced), [produced])
  const selectedName = selected === null ? '' : pathBasename(selected.path)
  const previewable = selectedPath !== null && isTextPreviewable(selectedPath)
  const printable = selectedPath !== null && isHtmlPath(selectedPath) ? selectedPath : null
  const reviseNotice = draftNotice !== null && draftNotice.path === selectedPath
  const selectedAddress = useMemo(
    () => selectedPath === null ? null : resourceAddress(selectedPath),
    [selectedPath, resourceAddress],
  )

  const onPrint = async (path: string): Promise<void> => {
    setPrintOutcome(null)
    // The preview may have read a bounded form or skipped the body entirely;
    // read completely so the PDF is not silently the cut head.
    let html: string
    try {
      const full = await readFileTextComplete(path)
      if (full.truncated) {
        setPrintOutcome({
          path,
          kind: 'failed',
          message: t('studio.print.tooLarge', { limit: fileSizeText(full.limitBytes) }),
        })
        return
      }
      html = full.content
    } catch (reason: unknown) {
      const message = reason instanceof WorkspaceReadError
        ? readFailureText({ code: reason.code, message: reason.message }, t)
        : reason instanceof Error ? reason.message : String(reason)
      setPrintOutcome({ path, kind: 'failed', message })
      return
    }
    if (window.desktop?.printHtmlToPdf !== undefined) {
      const result = await window.desktop.printHtmlToPdf({
        html,
        suggestedName: pathBasename(path),
      })
      if (result.error !== undefined) {
        setPrintOutcome({ path, kind: 'failed', message: result.error })
      } else if (result.cancelled !== true && result.path !== undefined) {
        setPrintOutcome({ path, kind: 'saved', saved: result.path })
      }
      return
    }
    if (!printHtmlDocument(html)) {
      setPrintOutcome({ path, kind: 'failed', message: t('studio.print.blocked') })
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
                    onClick={() => { setFollow(false); setSelectedPath(file.path) }}
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
              <span className={css.listControls}>
                <button
                  type="button"
                  className={css.action}
                  aria-pressed={follow}
                  onClick={() => { setFollow(enabled => !enabled) }}
                >
                  {t('studio.follow')}
                </button>
                <span className={css.count}>{t('studio.files', { count: produced.length })}</span>
              </span>
            </div>
            <div className={css.preview}>
              <div className={css.previewBar}>
                <span className={css.previewName}>{selectedName === '' ? t('studio.preview') : selectedName}</span>
                {selected !== null && (
                  <span className={css.actions}>
                    {previewable && (
                      <>
                        <button
                          type="button"
                          className={css.action}
                          aria-pressed={autoRefresh}
                          onClick={() => { setAutoRefresh(enabled => !enabled) }}
                        >
                          {t('studio.preview.autoRefresh')}
                        </button>
                        <button
                          type="button"
                          className={css.action}
                          onClick={() => { setReloadToken(token => token + 1) }}
                        >
                          {t('studio.preview.reload')}
                        </button>
                      </>
                    )}
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
                      <button type="button" className={css.action} onClick={() => { void onPrint(selected.path) }}>
                        {t('studio.action.print')}
                      </button>
                    )}
                    <button
                      type="button"
                      className={css.action}
                      onClick={() => {
                        setDraftNotice(insertDraft(reviseDraft(selected)) ? { path: selected.path } : null)
                      }}
                    >
                      {t('studio.action.revise')}
                    </button>
                  </span>
                )}
              </div>
              {printable !== null && <p className={css.printNote}>{t('studio.print.note')}</p>}
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
              {reviseNotice && <p className={css.note}>{t('studio.revise.inserted')}</p>}
              <GateClaim file={selected} t={t} />
              {selectedPath === null || selectedAddress === null
                ? <div className={css.note}>{t('studio.preview.hint')}</div>
                : (
                  <PreviewPane
                    path={selectedPath}
                    address={selectedAddress}
                    autoRefresh={autoRefresh}
                    reloadToken={reloadToken}
                    readFileText={readFileText}
                    readFileTextComplete={readFileTextComplete}
                    htmlPreviewMaxBytes={htmlPreviewMaxBytes}
                    canOpenInSidebar={canOpenInSidebar}
                    openInSidebar={openInSidebar}
                    insertDraft={insertDraft}
                    useResource={useResource}
                    t={t}
                  />
                )}
            </div>
          </>
        )}
    </div>
  )
}
