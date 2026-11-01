/**
 * The trajectory ledger's record inspector: the side panel that renders one selected record or
 * one selected session request across that selection's detail tabs.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  CodeBlock,
  IconCheckOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCopyOutlineRegular,
  IconWrapLinesOutlineRegular,
  JsonTree,
  MarkdownText,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DetailTab,
  ParentRecords,
  RecordState,
  TableRecord,
  TrajectoryRequestNumber,
} from './trajectory-types.ts'
import { jsonTreeLabels, markdownLabels } from './trajectory-types.ts'
import type { TrajectoryTranslate } from './locales.ts'
import { formatElapsedSeconds, trajectoryRecordId } from './trajectory-record.ts'
import { type CodeProgram, codeProgram } from './code-program.ts'
import {
  requestErrorMessage,
  requestIdentity,
  requestKey,
  sectionLabel,
  stateOf,
  statusLabel,
} from './trajectory-record-model.ts'
import {
  MessageSource,
  isMarkdownRecord,
  messageSourceLabel,
  parentRecords,
} from './trajectory-record-presentation.tsx'
import { RecordPayload, RecordSchema, RequestOptions, parseJsonContainer } from './trajectory-record-payload.tsx'
import { RecordTiming, RequestTiming, formatDurationMs } from './trajectory-timing.tsx'
import { RequestUsagePanel, TokenRows, UsageRows } from './trajectory-usage-panel.tsx'
import { MarkdownRecordContent } from './trajectory-markdown-content.tsx'
import { SystemPromptDiff, ToolCatalog } from './trajectory-prompt-diff.tsx'
import { detailTabs, requestDetailTabs } from './trajectory-detail-tabs.ts'
import type { WatchToolResult } from './watch-tool-result.ts'
import type { DetailTabItem } from './trajectory-detail-tabs.ts'
import { KIND_LABEL_KEY } from './trajectory-kind.tsx'
import type { DetailsResizeHandlers } from './trajectory-resize-handle.ts'
import css from './TrajectoryTable.module.css'

/** Identity of one session request a boundary selected, discriminated by purpose. */
export interface SelectedRequest {
  identity: string
}

/** Props for the trajectory record inspector. */
interface RecordInspectorProps {
  /** Observe the selected result while the Result tab is open. */
  watchToolResult?: WatchToolResult | undefined
  /** Trajectory locale seat. */
  t: TrajectoryTranslate
  /** Slot-backed durable image renderer shared with the Chat gallery. */
  renderSlot: PropsRenderSlots<'conversation.trajectory.images'>['renderSlot']
  /** Session-bound loader for durable message image attachments. */
  loadImage: MessageImageLoader
  /** Ledger records before fold and search projection, read for request and hierarchy lookup. */
  allRecords: readonly TableRecord[]
  /** Apply the streaming overlay to a template record. */
  currentRecord: (record: TableRecord) => TableRecord
  /** Session-global request number per request group key. */
  requestNumbers: ReadonlyMap<string, number>
  /** Numbered requests in session order, as the ledger host supplied them. */
  sessionRequestNumbers: readonly TrajectoryRequestNumber[] | undefined
  /** Record selected in the ledger, or absent when none is. */
  selected: TableRecord | undefined
  /** Request selected through a request boundary, or absent when none is. */
  selectedRequest: SelectedRequest | null
  /** Tab the detail panel is showing. */
  activeTab: DetailTab
  /** Wrapping control shared by all JSON inspectors. */
  stringWrapping?: JsonTreeProps['stringWrapping']
  /** Wrapping default captured when the current tab was activated. */
  codeWrappingOnOpen: boolean
  /** Whether long thinking blocks render expanded. */
  thinkingExpanded: boolean
  /** Inspector width in pixels, or null while it follows the split default. */
  detailsWidth: number | null
  /** Separator handlers from `useResizeHandle`. */
  resizeHandlers: DetailsResizeHandlers
  /** Bring one tab to the front of the tab history and select it. */
  onActivateTab: (tab: DetailTab) => void
  /** Close the inspector, dropping the record and request selections. */
  onClearSelection: () => void
  /** Open one record's summary, expanding the folds that hide it. */
  onOpenRecordSummary: (record: TableRecord) => void
  /** Open the summary of the record owning one call id. */
  onOpenCallSummary: (callId: string) => void
  /** Open a request's overview, or one of its panels. */
  onSelectRequest: (request: SelectedRequest, tab?: 'overview' | 'timing') => void
  /** Persist the thinking-block expansion choice. */
  onThinkingExpandedChange: (expanded: boolean) => void
}

function OverviewSection({
  label,
  onOpen,
  actions,
  children,
}: {
  label: string
  onOpen: () => void
  actions?: ReactNode
  children: ReactNode
}) {
  const previewRef = useRef<HTMLDivElement>(null)
  const [hasMore, setHasMore] = useState(false)
  const measureOverflow = useCallback((preview: HTMLElement) => {
    setHasMore(preview.scrollHeight - preview.clientHeight - preview.scrollTop > 1)
  }, [])

  useLayoutEffect(() => {
    const preview = previewRef.current as HTMLDivElement
    const measure = () => { measureOverflow(preview) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(preview)
    for (const child of preview.children) observer.observe(child)
    return () => { observer.disconnect() }
  }, [children, measureOverflow])

  return (
    <section className={css.overviewSection}>
      <h3 className={css.overviewHeading}>
        <button
          type="button"
          className={css.overviewTitle}
          onClick={onOpen}
        >
          <span>{label}</span>
          <IconChevronRightOutlineRegular className={css.overviewTitleIcon} size={12} />
        </button>
        {actions}
      </h3>
      <div
        ref={previewRef}
        className={`${css.overviewPreview} ${css.summaryScrollRegion}`}
        data-summary-scroll-region=""
        data-scroll-more={hasMore || undefined}
        onScroll={(event) => { measureOverflow(event.currentTarget) }}
      >
        {children}
      </div>
    </section>
  )
}

/**
 * Copy one inspector payload with transient success/failure feedback.
 * @param props - The exact text to copy, its idle label, and the locale seat.
 * @returns The copy button.
 */
function InspectorCopyButton({ text, label, t }: {
  text: string
  label: string
  t: TrajectoryTranslate
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => { setState('idle') }, 1_500)
    return () => { clearTimeout(timer) }
  }, [state])
  const title = state === 'idle' ? label : t(state === 'copied' ? 'copied' : 'copy.failed')
  return (
    <button
      type="button"
      className={css.programAction}
      data-state={state}
      aria-label={title}
      title={title}
      onClick={() => { void writeClipboard(text).then((ok) => { setState(ok ? 'copied' : 'failed') }) }}
    >
      {state === 'copied' ? <IconCheckOutlineRegular size={12} /> : <IconCopyOutlineRegular size={12} />}
    </button>
  )
}

/**
 * Render one recorded program's source, with its original arguments and the shared wrap control.
 * @param props - The resolved program, the wrapping preference captured on open, and the locale seat.
 * @returns The source panel, standalone or as an overview section.
 */
function ProgramInput({ program, initialWrapped, stringWrapping, onOpen, t }: {
  program: CodeProgram
  initialWrapped: boolean
  stringWrapping: JsonTreeProps['stringWrapping']
  onOpen?: () => void
  t: TrajectoryTranslate
}) {
  const contentsId = useId()
  const [wrapped, setWrapped] = useState(initialWrapped)
  const [showJson, setShowJson] = useState(false)
  const actions = (
    <span className={css.programActions}>
      {!showJson && program.language !== undefined && (
        <span className={css.programLanguage}>{program.language}</span>
      )}
      {!showJson && (
        <button
          type="button"
          className={css.programAction}
          aria-label={t('record.wrapLines')}
          title={t('record.wrapLines')}
          aria-pressed={wrapped}
          aria-controls={contentsId}
          onClick={() => {
            const next = !wrapped
            setWrapped(next)
            stringWrapping?.setDefault(next)
          }}
        >
          <IconWrapLinesOutlineRegular size={12} />
        </button>
      )}
      {onOpen === undefined && (
        <button
          type="button"
          className={css.programAction}
          aria-label={t('code.originalJson')}
          title={t('code.originalJson')}
          aria-pressed={showJson}
          aria-controls={contentsId}
          onClick={() => { setShowJson(value => !value) }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"
            stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 2H5a2 2 0 0 0-2 2v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a2 2 0 0 0 2 2h1" />
            <path d="M10 2h1a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a2 2 0 0 1-2 2h-1" />
          </svg>
        </button>
      )}
      <InspectorCopyButton
        text={showJson ? program.rawInput : program.source}
        label={t(showJson ? 'copy.json' : 'code.copySource')}
        t={t}
      />
    </span>
  )
  const body = (
    <div id={contentsId} className={css.programContent} data-wrap={wrapped}>
      {showJson
        ? <JsonTree data={program.arguments} label={t('record.parametersJson')}
          labels={jsonTreeLabels(t)} stringWrapping={stringWrapping} />
        : <CodeBlock code={program.source} lang={program.language} lineNumbers showHeader={false}
          className={css.programSource} copyLabel={t('code.copySource')} copiedLabel={t('copied')} />}
    </div>
  )
  return onOpen === undefined
    ? (
      <section className={css.programPanel}>
        <header className={css.overviewHeading}>
          <span>{t('code.source')}</span>
          {actions}
        </header>
        {body}
      </section>
    )
    : <OverviewSection label={t('code.source')} onOpen={onOpen} actions={actions}>{body}</OverviewSection>
}

/**
 * Render one recorded program's captured output, verbatim or as a JSON tree.
 * @param props - The selected record, the wrapping control, and the locale seat.
 * @returns The output panel, standalone or as an overview section.
 */
function ProgramOutput({ record, stringWrapping, onOpen, t }: {
  record: TableRecord
  stringWrapping: JsonTreeProps['stringWrapping']
  onOpen?: () => void
  t: TrajectoryTranslate
}) {
  const output = record.cell.outputDetail
  const json = output === undefined || record.cell.isError === true ? undefined : parseJsonContainer(output)
  const actions = output === undefined ? undefined : (
    <span className={css.programActions}>
      <InspectorCopyButton text={output} label={t('code.copyOutput')} t={t} />
    </span>
  )
  const body = (
    <div className={css.programContent}>
      {output === undefined || output === ''
        ? <p className={css.noPayload}>{t(stateOf(record) === 'running' ? 'code.running' : 'record.noOutput')}</p>
        : json !== undefined
          ? <JsonTree data={json} label={t('record.outputJson')} labels={jsonTreeLabels(t)}
            stringWrapping={stringWrapping} collapsedStringLines={onOpen === undefined ? 12 : 3} />
          : <pre className={`${css.programOutput} ${record.cell.isError === true ? css.programError : ''}`}>{output}</pre>}
    </div>
  )
  return onOpen === undefined
    ? body
    : <OverviewSection label={t('code.output')} onOpen={onOpen} actions={actions}>{body}</OverviewSection>
}

/**
 * Render the inspector panel for the selected record or session request. Renders nothing while
 * neither selection resolves to a record the panel can show.
 * @param props - The current selection, the ledger records it was drawn from, and the callbacks
 * the panel navigates with.
 * @returns The inspector aside, or null without a showable selection.
 */
export function RecordInspector({
  watchToolResult,
  t,
  renderSlot,
  loadImage,
  allRecords,
  currentRecord,
  requestNumbers,
  sessionRequestNumbers,
  selected,
  selectedRequest,
  activeTab,
  stringWrapping,
  codeWrappingOnOpen,
  thinkingExpanded,
  detailsWidth,
  resizeHandlers,
  onActivateTab,
  onClearSelection,
  onOpenRecordSummary,
  onOpenCallSummary,
  onSelectRequest,
  onThinkingExpandedChange,
}: RecordInspectorProps) {
  const selectedPrompt = selected?.cell.kind === 'system'
    ? selected.cell.promptDetail
    : undefined
  const selectedPreviousPrompt = selected?.cell.kind === 'system'
    ? selected.cell.previousPromptDetail
    : undefined
  const selectedSystemPrompt = selectedPrompt?.system ?? selected?.cell.systemPromptDetail
  const promptSelected = selectedSystemPrompt !== undefined
  const selectedState = selected === undefined ? undefined : stateOf(selected)
  const selectedProgram = selected === undefined ? undefined : codeProgram(selected.cell)
  const resultSeq = activeTab === 'output' ? selected?.cell.resultSeq : undefined
  const [liveResult, setLiveResult] = useState<{ seq: number; owner: WatchToolResult; value: JsonValue | undefined }>()
  useEffect(() => {
    setLiveResult(undefined)
    if (resultSeq === undefined || watchToolResult === undefined) return
    let active = true
    const dispose = watchToolResult(resultSeq, (value) => {
      if (active) setLiveResult({ seq: resultSeq, owner: watchToolResult, value })
    })
    return () => { active = false; dispose() }
  }, [resultSeq, watchToolResult])
  const resultValue = liveResult?.seq === resultSeq && liveResult?.owner === watchToolResult ? liveResult?.value : undefined
  const selectedRequestInfo = selectedRequest === null
    ? undefined
    : sessionRequestNumbers?.find(request =>
      requestIdentity(request) === selectedRequest.identity)
  const selectedRequestRecordTemplates = useMemo(() => selectedRequestInfo === undefined
    ? []
    : allRecords.filter(record =>
      record.turn === selectedRequestInfo.turn
        && record.group === selectedRequestInfo.group,
    ), [allRecords, selectedRequestInfo])
  const selectedRequestRecords = selectedRequestRecordTemplates.map(currentRecord)
  const selectedRequestAssistant = selectedRequestRecords.find(
    record => record.cell.kind === 'message' && record.cell.requestOnly !== true,
  )
  const selectedRequestAnchor = selectedRequestAssistant ?? selectedRequestRecords[0]
  const selectedRequestNumber = selectedRequestInfo?.number
  const selectedRequestState: RecordState | undefined = selectedRequestInfo === undefined
    ? undefined
    : selectedRequestInfo.status
      ?? (selectedRequestAssistant?.cell.assistantMetrics?.completedTime === null
        ? 'running'
        : selectedRequestAssistant === undefined
          && selectedRequestRecords.some(record => stateOf(record) === 'running')
          ? 'running'
          : 'complete')
  const selectedRequestToolCalls = selectedRequestRecords.filter(
    record => record.cell.kind === 'tool',
  ).length
  const selectedRequestSubtoolCalls = selectedRequestRecords.filter(
    record => record.cell.kind === 'subtool',
  ).length
  const selectedRequestResultTemplate = selectedRequestInfo?.resultSeq === undefined
    ? selectedRequestAssistant
    : allRecords.find(record => record.cell.sourceSeq === selectedRequestInfo.resultSeq)
  const selectedRequestResult = selectedRequestResultTemplate === undefined
    ? undefined
    : currentRecord(selectedRequestResultTemplate)
  const selectedRequestUsage = selectedRequestInfo?.usage ?? (
    selectedRequestAssistant === undefined
      ? undefined
      : {
        ...(selectedRequestAssistant.cell.input === undefined
          ? {}
          : { input: selectedRequestAssistant.cell.input }),
        ...(selectedRequestAssistant.cell.cacheRead === undefined
          ? {}
          : { cacheRead: selectedRequestAssistant.cell.cacheRead }),
        ...(selectedRequestAssistant.cell.cacheWrite === undefined
          ? {}
          : { cacheWrite: selectedRequestAssistant.cell.cacheWrite }),
        ...(selectedRequestAssistant.cell.output === undefined
          ? {}
          : { output: selectedRequestAssistant.cell.output }),
        ...(selectedRequestAssistant.cell.think === undefined
          ? {}
          : { reasoning: selectedRequestAssistant.cell.think }),
      }
  )
  const selectedRequestCumulativeUsage =
    selectedRequestInfo?.cumulativeUsage ?? selectedRequestUsage
  const selectedRequestOptions = selectedRequestInfo?.requestConfig
  const selectedTabs: readonly DetailTabItem[] = selectedRequestInfo !== undefined
    ? requestDetailTabs(selectedRequestOptions !== undefined)
    : selected === undefined ? [] : detailTabs(selected)
  const selectedParents: ParentRecords = selected === undefined
    ? {}
    : parentRecords(allRecords, selected)
  const selectedParentMessage = selectedParents.message
  const selectedParentTool = selectedParents.tool
  const selectedAssistantRequest = selected?.cell.kind === 'message'
    ? requestNumbers.get(requestKey(selected.turn, selected.group))
    : undefined
  const selectedAssistantRequestInfo = selectedAssistantRequest === undefined
    ? undefined
    : sessionRequestNumbers?.find(request => request.number === selectedAssistantRequest)
  const selectedAssistantRequestTarget: SelectedRequest | undefined =
    selectedAssistantRequestInfo === undefined
      ? undefined
      : { identity: requestIdentity(selectedAssistantRequestInfo) }
  const hasSelectedHierarchy = selectedAssistantRequestTarget !== undefined
    || selectedParents.message !== undefined
    || selectedParents.tool !== undefined

  if (!(selectedRequestInfo !== undefined
    || promptSelected
    || (selected !== undefined && selectedState !== undefined))) return null

  return (
    <aside
      className={css.details}
      aria-label={t('details.event')}
      style={detailsWidth === null ? undefined : { width: detailsWidth }}
    >
      <div
        className={css.detailsResizeHandle}
        role="separator"
        aria-label={t('details.resize')}
        aria-controls="trajectory-detail-panel"
        aria-orientation="vertical"
        tabIndex={0}
        title={t('details.resizeTitle')}
        {...resizeHandlers}
      />
      <div className={css.detailsHeader}>
        <div className={css.detailsTitle}>
          {selectedRequestInfo !== undefined
            ? (
              <>
                <span className={css.requestDetailsDot} aria-hidden="true" />
                <span className={css.requestDetailsName}>
                  {t('request.label', { request: selectedRequestNumber ?? '—' })}
                </span>
                <span className={css.detailsLocation}>
                  {selectedRequestInfo.purpose === 'compaction'
                    ? t('request.compaction', { section: sectionLabel(selectedRequestInfo.turn, t) })
                    : sectionLabel(selectedRequestInfo.turn, t)}
                </span>
              </>
            )
            : promptSelected
              ? (
                <>
                  <span className={`${css.kindTag} ${css.systemNeutral}`}>{t('kind.system')}</span>
                  <span className={css.detailsLocation}>{selected?.cell.text}</span>
                </>
              )
              : selected !== undefined && (
                <>
                  <span className={`${css.kindTag} ${
                    selected.cell.kind === 'context'
                      ? css.contextGreen
                      : selected.cell.kind === 'compacted'
                        ? css.compacted
                        : selected.cell.kind === 'tool'
                          ? css.toolAmber
                          : selected.cell.kind === 'message'
                            ? css.assistantVioletBright
                            : selected.cell.kind === 'subtool'
                              ? css.subtoolAmber
                              : css[selected.cell.kind]
                  }`}
                  >
                    {t(KIND_LABEL_KEY[selected.cell.kind])}
                  </span>
                  <span className={css.detailsLocation}>
                    {selected.cell.kind === 'compacted'
                      ? sectionLabel(selected.turn, t)
                      : `${sectionLabel(selected.turn, t)} · ${selected.group}`}
                  </span>
                </>
              )}
        </div>
        <button
          type="button"
          className={css.close}
          aria-label={t('details.close')}
          onClick={onClearSelection}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div className={css.detailTabs} role="tablist" aria-label={t('details.event')}>
        {selectedTabs.map(tab => (
          <button
            key={tab.id}
            id={`trajectory-detail-${tab.id}`}
            type="button"
            role="tab"
            aria-controls="trajectory-detail-panel"
            aria-selected={activeTab === tab.id}
            className={activeTab === tab.id ? `${css.detailTab} ${css.detailTabActive}` : css.detailTab}
            onClick={() => { onActivateTab(tab.id) }}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      <div
        id="trajectory-detail-panel"
        className={activeTab === 'overview'
          ? `${css.detailBody} ${css.detailBodySummary}`
          : selectedProgram !== undefined && activeTab === 'input'
            ? `${css.detailBody} ${css.detailBodyProgram}`
            : css.detailBody}
        role="tabpanel"
        aria-labelledby={`trajectory-detail-${activeTab}`}
      >
        {selectedRequestInfo !== undefined
          && selectedRequestState !== undefined
          && activeTab === 'overview' && (
          <>
            <dl
              className={`${css.overview} ${css.summaryScrollRegion}`}
              data-summary-scroll-region=""
            >
              <div>
                <dt>{t('details.status')}</dt>
                <dd className={selectedRequestState === 'error' ? css.error : undefined}>
                  {statusLabel(selectedRequestState, t)}
                </dd>
              </div>
              {selectedRequestInfo.purpose === 'compaction' && (
                <div>
                  <dt>{t('details.purpose')}</dt>
                  <dd>{t('request.compactionPurpose')}</dd>
                </div>
              )}
              {(selectedRequestInfo.provider
                ?? selectedRequestInfo.requestConfig?.provider) !== undefined && (
                <div>
                  <dt>{t('details.provider')}</dt>
                  <dd>
                    {selectedRequestInfo.provider
                      ?? selectedRequestInfo.requestConfig?.provider}
                  </dd>
                </div>
              )}
              {(selectedRequestInfo.model
                ?? selectedRequestInfo.requestConfig?.model) !== undefined && (
                <div>
                  <dt>{t('details.model')}</dt>
                  <dd>
                    {selectedRequestInfo.model
                      ?? selectedRequestInfo.requestConfig?.model}
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('details.toolCalls')}</dt>
                <dd>{selectedRequestToolCalls}</dd>
              </div>
              {selectedRequestSubtoolCalls > 0 && (
                <div>
                  <dt>{t('details.subtoolCalls')}</dt>
                  <dd>{selectedRequestSubtoolCalls}</dd>
                </div>
              )}
              {selectedRequestInfo.error !== undefined && (
                <div>
                  <dt>{t(selectedRequestState !== 'error' && selectedRequestInfo.retry !== undefined
                    ? 'details.lastAttemptError'
                    : 'details.error')}</dt>
                  <dd className={selectedRequestState === 'error' ? css.error : undefined}>
                    {requestErrorMessage(selectedRequestInfo, t)}
                  </dd>
                </div>
              )}
              {selectedRequestInfo.retry !== undefined && (
                <div>
                  <dt>{t('details.retry')}</dt>
                  <dd>
                    {selectedRequestInfo.maxRetries === undefined
                      ? selectedRequestInfo.retry
                      : t('request.retryProgress', {
                        retry: selectedRequestInfo.retry,
                        maximum: selectedRequestInfo.maxRetries,
                      })}
                  </dd>
                </div>
              )}
              {selectedRequestInfo.retryDelayMs !== undefined && (
                <div>
                  <dt>{t('details.retryDelay')}</dt>
                  <dd>{formatDurationMs(selectedRequestInfo.retryDelayMs, t)}</dd>
                </div>
              )}
              {selectedRequestResult !== undefined && (
                <div>
                  <dt>{t('details.result')}</dt>
                  <dd className={css.overviewParentLinks}>
                    <button
                      type="button"
                      className={css.overviewHierarchyNavLink}
                      onClick={() => {
                        onOpenRecordSummary(selectedRequestResult)
                      }}
                    >
                      <span>
                        {selectedRequestInfo.purpose === 'compaction'
                          ? t('details.compacted')
                          : t('details.assistantMessage')}
                      </span>
                      <IconChevronRightOutlineRegular
                        className={css.overviewHierarchyJumpIconTight}
                        size={11}
                      />
                    </button>
                  </dd>
                </div>
              )}
            </dl>
            <div className={css.overviewSections}>
              {selectedRequestOptions !== undefined && (
                <OverviewSection label={t('tab.options')} onOpen={() => { onActivateTab('options') }}>
                  <RequestOptions options={selectedRequestOptions} preview stringWrapping={stringWrapping} t={t} />
                </OverviewSection>
              )}
              <OverviewSection label={t('tab.usage')} onOpen={() => { onActivateTab('usage') }}>
                <UsageRows usage={selectedRequestUsage} t={t} />
              </OverviewSection>
              <OverviewSection label={t('tab.timing')} onOpen={() => { onActivateTab('timing') }}>
                <RequestTiming
                  assistant={selectedRequestAssistant}
                  anchor={selectedRequestAnchor}
                  request={selectedRequestInfo}
                  preview
                  t={t}
                />
              </OverviewSection>
            </div>
          </>
        )}
        {selectedRequestInfo !== undefined && activeTab === 'options' && (
          <RequestOptions options={selectedRequestOptions} stringWrapping={stringWrapping} t={t} />
        )}
        {selectedRequestInfo !== undefined && activeTab === 'usage' && (
          <RequestUsagePanel
            usage={selectedRequestUsage}
            cumulative={selectedRequestCumulativeUsage}
            t={t}
          />
        )}
        {selectedRequestInfo !== undefined && activeTab === 'timing' && (
          <RequestTiming
            assistant={selectedRequestAssistant}
            anchor={selectedRequestAnchor}
            request={selectedRequestInfo}
            t={t}
          />
        )}
        {selectedPrompt !== undefined
          && selectedPreviousPrompt !== undefined
          && activeTab === 'diff' && (
          <SystemPromptDiff
            before={selectedPreviousPrompt}
            after={selectedPrompt}
            t={t}
          />
        )}
        {promptSelected && activeTab === 'system-prompt' && (
          selectedSystemPrompt === ''
            ? <p className={css.noPayload}>{t('record.systemPromptMissing')}</p>
            : (
              <div className={`${css.markdownPayload} ${css.systemPrompt}`}>
                <MarkdownText text={selectedSystemPrompt} labels={markdownLabels(t)} />
              </div>
            )
        )}
        {selectedPrompt !== undefined && activeTab === 'tools' && (
          <ToolCatalog tools={selectedPrompt.tools} stringWrapping={stringWrapping} t={t} />
        )}
        {!promptSelected
          && selected?.cell.kind === 'compacted'
          && selectedState !== undefined
          && activeTab === 'overview' && (
          <>
            <dl
              className={`${css.overview} ${css.summaryScrollRegion}`}
              data-summary-scroll-region=""
            >
              <div>
                <dt>{t('details.status')}</dt>
                <dd className={selectedState === 'error' ? css.error : undefined}>
                  {statusLabel(selectedState, t)}
                </dd>
              </div>
              <div>
                <dt>{t('timing.duration')}</dt>
                <dd>{formatElapsedSeconds(selected.cell.timeSeconds, t)}</dd>
              </div>
              <div>
                <dt>{t('usage.tokens')}</dt>
                <dd>—</dd>
              </div>
            </dl>
            {selected.cell.outputDetail !== undefined && (
              <div
                className={`${css.compactedSummary} ${css.summaryScrollRegion}`}
                data-summary-scroll-region=""
              >
                <MarkdownRecordContent
                  record={selected}
                  renderSlot={renderSlot} loadImage={loadImage}
                  rendered
                  thinkingExpanded={thinkingExpanded}
                  onThinkingExpandedChange={onThinkingExpandedChange}
                  onOpenCall={onOpenCallSummary}
                  t={t}
                />
              </div>
            )}
          </>
        )}
        {!promptSelected
          && selected !== undefined
          && selected.cell.kind !== 'compacted'
          && selectedState !== undefined
          && activeTab === 'overview' && (
          <>
            {selectedProgram !== undefined && selectedProgram.description !== '' && (
              <p className={css.programDescription}>{selectedProgram.description}</p>
            )}
            <dl
              className={`${css.overview} ${css.summaryScrollRegion}`}
              data-summary-scroll-region=""
            >
              {selected.cell.messageSource !== undefined && (
                <div>
                  <dt>{t('details.source')}</dt>
                  <dd className={css.overviewParentLinks}>
                    <button
                      type="button"
                      className={css.overviewHierarchyNavLink}
                      onClick={() => { onActivateTab('source') }}
                    >
                      <span>{messageSourceLabel(selected.cell.messageSource, t)}</span>
                      <IconChevronRightOutlineRegular
                        className={css.overviewHierarchyJumpIconTight}
                        size={11}
                      />
                    </button>
                  </dd>
                </div>
              )}
              {hasSelectedHierarchy && (
                <div>
                  <dt>
                    {selectedAssistantRequestTarget !== undefined
                      ? t('details.source')
                      : t('details.hierarchy')}
                  </dt>
                  <dd className={css.overviewParentLinks}>
                    {selectedAssistantRequestTarget !== undefined && (
                      <button
                        type="button"
                        className={css.overviewHierarchyNavLink}
                        onClick={() => {
                          onSelectRequest(selectedAssistantRequestTarget)
                        }}
                      >
                        <span>{t('request.label', { request: selectedAssistantRequest ?? '—' })}</span>
                        <IconChevronRightOutlineRegular
                          className={css.overviewHierarchyJumpIconTight}
                          size={11}
                        />
                      </button>
                    )}
                    {selectedParentMessage !== undefined && (
                      <button
                        type="button"
                        className={css.overviewHierarchyNavLink}
                        onClick={() => { onOpenRecordSummary(selectedParentMessage) }}
                      >
                        <span>{t('details.assistantMessage')}</span>
                        <IconChevronRightOutlineRegular
                          className={css.overviewHierarchyJumpIconTight}
                          size={11}
                        />
                      </button>
                    )}
                    {selectedParentTool !== undefined && (
                      <button
                        type="button"
                        className={css.overviewHierarchyNavLink}
                        onClick={() => { onOpenRecordSummary(selectedParentTool) }}
                      >
                        <span>{t('details.toolCall')}</span>
                        <IconChevronRightOutlineRegular
                          className={css.overviewHierarchyJumpIconTight}
                          size={11}
                        />
                      </button>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt>{t('details.status')}</dt>
                <dd className={selectedState === 'error' ? css.error : undefined}>
                  {statusLabel(selectedState, t)}
                </dd>
              </div>
              {selected.cell.kind === 'message' && (
                <TokenRows cell={selected.cell} t={t} />
              )}
              {(selected.cell.kind === 'user' || selected.cell.kind === 'context') && (
                <div>
                  <dt>{t('timing.duration')}</dt>
                  <dd>{formatElapsedSeconds(selected.cell.timeSeconds, t)}</dd>
                </div>
              )}
            </dl>
            <div className={css.overviewSections}>
              {selectedProgram !== undefined
                ? (
                  <>
                    <ProgramInput
                      key={`preview:${trajectoryRecordId(selected.cell)}`}
                      program={selectedProgram}
                      initialWrapped={codeWrappingOnOpen}
                      stringWrapping={stringWrapping}
                      onOpen={() => { onActivateTab('input') }}
                      t={t}
                    />
                    <ProgramOutput
                      record={selected}
                      stringWrapping={stringWrapping}
                      onOpen={() => { onActivateTab('output') }}
                      t={t}
                    />
                  </>
                )
                : isMarkdownRecord(selected)
                  ? (
                    <>
                      <OverviewSection label={t('tab.preview')} onOpen={() => { onActivateTab('rendered') }}>
                        <MarkdownRecordContent
                          record={selected}
                          renderSlot={renderSlot} loadImage={loadImage}
                          rendered
                          preview
                          thinkingExpanded={thinkingExpanded}
                          onThinkingExpandedChange={onThinkingExpandedChange}
                          onOpenCall={onOpenCallSummary}
                          t={t}
                        />
                      </OverviewSection>
                    </>
                  )
                  : (
                    <>
                      {selected.cell.inputDetail && (
                        <OverviewSection label={t('tab.payload')} onOpen={() => { onActivateTab('input') }}>
                          <RecordPayload record={selected} direction="input" preview renderSlot={renderSlot} loadImage={loadImage} stringWrapping={stringWrapping} t={t} />
                        </OverviewSection>
                      )}
                      {selected.cell.outputDetail && (
                        <OverviewSection label={t('tab.result')} onOpen={() => { onActivateTab('output') }}>
                          <RecordPayload record={selected} direction="output" preview renderSlot={renderSlot} loadImage={loadImage} stringWrapping={stringWrapping} t={t} />
                        </OverviewSection>
                      )}
                      <OverviewSection label={t('tab.schema')} onOpen={() => { onActivateTab('schema') }}>
                        <RecordSchema record={selected} preview stringWrapping={stringWrapping} t={t} />
                      </OverviewSection>
                    </>
                  )}
              {selectedAssistantRequestTarget !== undefined && (
                <OverviewSection
                  label={t('timing.request')}
                  onOpen={() => {
                    onSelectRequest(selectedAssistantRequestTarget, 'timing')
                  }}
                >
                  <RecordTiming record={selected} preview t={t} />
                </OverviewSection>
              )}
              {(selected.cell.kind === 'tool' || selected.cell.kind === 'subtool') && (
                <OverviewSection label={t('tab.timing')} onOpen={() => { onActivateTab('timing') }}>
                  <RecordTiming record={selected} preview t={t} />
                </OverviewSection>
              )}
            </div>
          </>
        )}
        {!promptSelected && selected !== undefined && activeTab === 'rendered' && (
          <MarkdownRecordContent
            record={selected}
            renderSlot={renderSlot} loadImage={loadImage}
            rendered
            thinkingExpanded={thinkingExpanded}
            onThinkingExpandedChange={onThinkingExpandedChange}
            onOpenCall={onOpenCallSummary}
            t={t}
          />
        )}
        {!promptSelected && selected !== undefined && activeTab === 'raw' && (
          <MarkdownRecordContent
            record={selected}
            renderSlot={renderSlot} loadImage={loadImage}
            rendered={false}
            thinkingExpanded={thinkingExpanded}
            onThinkingExpandedChange={onThinkingExpandedChange}
            onOpenCall={onOpenCallSummary}
            t={t}
          />
        )}
        {!promptSelected && selected !== undefined && activeTab === 'source' && (
          <MessageSource record={selected} stringWrapping={stringWrapping} t={t} />
        )}
        {!promptSelected && selected !== undefined && activeTab === 'input' && (
          selectedProgram === undefined
            ? <RecordPayload record={selected} direction="input" renderSlot={renderSlot} loadImage={loadImage} stringWrapping={stringWrapping} t={t} />
            : (
              <ProgramInput
                key={`input:${trajectoryRecordId(selected.cell)}`}
                program={selectedProgram}
                initialWrapped={codeWrappingOnOpen}
                stringWrapping={stringWrapping}
                t={t}
              />
            )
        )}
        {!promptSelected && selected !== undefined && activeTab === 'output' && (
          selected.cell.kind === 'tool' || selected.cell.kind === 'subtool'
            ? <div className={css.resultSections}>
              <section className={css.resultSection} aria-label={t('record.rawResult')}>
                <header className={css.overviewHeading}>
                  <h3 className={css.resultTitle}>{t('record.rawResult')}</h3>
                </header>
                {resultValue === undefined
                  ? <p className={css.noPayload}>{t(stateOf(selected) === 'running' ? 'code.running' : 'record.rawResultUnavailable')}</p>
                  : resultValue !== null && typeof resultValue === 'object'
                    ? <JsonTree data={resultValue} label={t('record.resultJson')}
                      labels={jsonTreeLabels(t)} stringWrapping={stringWrapping}
                      collapsedStringLines={12} className={css.jsonPayload} />
                    : <pre className={css.programOutput}>{JSON.stringify(resultValue)}</pre>}
              </section>
              <section className={css.resultSection} aria-label={t('record.renderedResult')}>
                <header className={css.overviewHeading}>
                  <h3 className={css.resultTitle}>{t('record.renderedResult')}</h3>
                </header>
                {selectedProgram === undefined
                  ? <RecordPayload record={selected} direction="output" renderSlot={renderSlot} loadImage={loadImage} stringWrapping={stringWrapping} t={t} />
                  : <ProgramOutput record={selected} stringWrapping={stringWrapping} t={t} />}
              </section>
            </div>
            : <RecordPayload record={selected} direction="output" renderSlot={renderSlot} loadImage={loadImage} stringWrapping={stringWrapping} t={t} />
        )}
        {!promptSelected && selected !== undefined && activeTab === 'schema' && (
          <RecordSchema record={selected} stringWrapping={stringWrapping} t={t} />
        )}
        {!promptSelected && selected !== undefined && activeTab === 'timing' && (
          <RecordTiming record={selected} t={t} />
        )}
      </div>
    </aside>
  )
}
