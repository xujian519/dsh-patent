/** Turn-aware trajectory event ledger with a local record inspector. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonTreeProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TrajectoryCellProps } from './trajectory-record.ts'
import { trajectoryRecordId } from './trajectory-record.ts'
import {
  groupTrajectoryVirtualRows, trajectoryVirtualRecordKey,
} from './trajectory-virtual-rows.ts'
import type { TrajectoryVirtualRow } from './trajectory-virtual-rows.ts'
import type { TrajectoryTurnModel } from './layout.ts'
import type { TrajectoryTranslate } from './locales.ts'
import css from './TrajectoryTable.module.css'

import { collapseAssistantRecords, collapseTurnRecords, filterRecords, flattenRecords, indexRequestBoundaries, indexRequestBoundaryRuns, indexRequestNumbers, requestIdentity, requestKey } from './trajectory-record-model.ts'
import { TrajectoryRow } from './trajectory-row.tsx'
import { RecordInspector } from './trajectory-record-inspector.tsx'
import type { WatchToolResult } from './watch-tool-result.ts'
import { detailTabs } from './trajectory-detail-tabs.ts'
import { useResizeHandle } from './trajectory-resize-handle.ts'
import type { SelectedRequest } from './trajectory-record-inspector.tsx'
import type { DetailTab, TableRecord, TrajectoryRequestNumber } from './trajectory-types.ts'

export type { TrajectoryRequestNumber, TrajectoryUsage } from './trajectory-types.ts'

const BOTTOM_FOLLOW_THRESHOLD_PX = 2

const OLDER_LOAD_THRESHOLD_PX = 48

const HISTORY_LOAD_ROW_HEIGHT_PX = 30

const VIRTUALIZATION_THRESHOLD = 100

const VIRTUAL_OVERSCAN_ROWS = 12

const VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600

interface VirtualRowStructure {
  height: number
  key: string
}

function useStableVirtualRowStructure(
  rows: readonly TrajectoryVirtualRow<TableRecord>[],
): readonly VirtualRowStructure[] {
  const cache = useRef<{
    rows: readonly TrajectoryVirtualRow<TableRecord>[]
    structure: readonly VirtualRowStructure[]
  }>({ rows: [], structure: [] })
  if (cache.current.rows === rows) return cache.current.structure
  const structure = cache.current.structure.length === rows.length
    && rows.every((row, index) => {
      const previous = cache.current.structure[index]
      return previous?.key === row.key && previous.height === row.height
    })
    ? cache.current.structure
    : rows.map(row => ({ key: row.key, height: row.height }))
  cache.current = { rows, structure }
  return structure
}

type TrajectorySplitStyle = CSSProperties & {
  '--trajectory-tool-request-width': string
}

type VirtualSpacerStyle = CSSProperties & {
  '--trajectory-virtual-spacer-height': string
}

interface OlderLoadAnchor {
  readonly historyStartSeq: number | undefined
  readonly scrollHeight: number
  readonly scrollTop: number
}

/** Props for the trajectory ledger. */
interface TrajectoryTableProps {
  /** Observe the selected result while the Result tab is open. */
  watchToolResult?: WatchToolResult | undefined
  /** Wrapping control shared by all JSON inspectors. */
  stringWrapping?: JsonTreeProps['stringWrapping']
  /** Trajectory locale seat. */
  t: TrajectoryTranslate
  /** Slot-backed durable image renderer shared with the Chat gallery. */
  renderSlot: PropsRenderSlots<'conversation.trajectory.images'>['renderSlot']
  /** Session-bound loader for durable message image attachments. */
  loadImage: MessageImageLoader
  /** Session-global request numbers for the request groups visible in this context. */
  requestNumbers?: readonly TrajectoryRequestNumber[]
  /** Grouped records in display order. */
  turns: readonly TrajectoryTurnModel[]
  /** In-flight cells whose content replaces the matching structural record index. */
  streamingCells?: readonly TrajectoryCellProps[]
  /** Record indexes emphasized by the active timeline focus. */
  timelineFocusIndexes?: ReadonlySet<number> | null
  /** Record indexes retained by the active live search, or null without a query. */
  searchMatchIndexes?: ReadonlySet<number> | null
  /** Report the record currently selected in the local inspector. */
  onSelectedIndexChange?: (index: number | null) => void
  /** Report a direct user selection from a ledger row. */
  onRecordSelect?: (index: number) => void
  /** One externally requested record selection; a new object repeats the request. */
  recordSelection?: { readonly index: number } | null
  /** One externally requested record focus without changing inspector selection. */
  recordFocus?: { readonly index: number } | null
  /** Whether the initial history tail is still loading. */
  historyLoading?: boolean
  /** Whether one older history page request is pending anywhere. */
  olderHistoryLoading?: boolean
  /** First loaded raw event, used to preserve scroll position after prepending a page. */
  historyStartSeq?: number | undefined
  /** Whether one older history page can be requested. */
  hasOlderRecords?: boolean
  /** Load one older history page. */
  onLoadOlder?: () => Promise<boolean>
  /** Clear selection state owned by the ledger host. */
  onClearSelection?: () => void
  /** Turn ids whose rows after the first are folded into a summary. */
  collapsedTurns: ReadonlySet<number>
  /** Toggle one turn between folded and expanded. */
  onToggleTurn: (turn: number) => void
  /** Stable Assistant record ids whose tool calls are folded. */
  collapsedAssistants: ReadonlySet<string>
  /** Toggle tool calls under one assistant record. */
  onToggleAssistant: (id: string) => void
  /** One-shot cross-view inspect: open and scroll to this call's record. */
  inspectCallId?: string | null
  /** Acknowledge a consumed (or unresolvable) inspect request. */
  onInspectApplied?: (() => void) | undefined
}

/**
 * Render trajectory events as a dense ledger with turn and step separators.
 * Clicking ledger whitespace clears the active record or request selection.
 * @param props - Grouped trajectory data and whole-ledger fold state.
 * @returns The ledger and an optional local record inspector.
 */
export function TrajectoryTable({
  watchToolResult,
  t,
  stringWrapping,
  renderSlot,
  loadImage,
  requestNumbers: sessionRequestNumbers,
  turns,
  streamingCells = [],
  timelineFocusIndexes = null,
  searchMatchIndexes = null,
  onSelectedIndexChange,
  onRecordSelect,
  recordSelection = null,
  recordFocus = null,
  historyLoading = false,
  olderHistoryLoading = false,
  historyStartSeq,
  hasOlderRecords = false,
  onLoadOlder,
  onClearSelection,
  collapsedTurns,
  onToggleTurn,
  collapsedAssistants,
  onToggleAssistant,
  inspectCallId = null,
  onInspectApplied,
}: TrajectoryTableProps) {
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [selectedRequest, setSelectedRequest] = useState<SelectedRequest | null>(null)
  const [activeTab, setActiveTab] = useState<DetailTab>('overview')
  const [codeWrappingOnOpen, setCodeWrappingOnOpen] = useState(false)
  const [thinkingDisclosure, setThinkingDisclosure] = useState<{ recordId: string; expanded: boolean }>()
  const appliedRecordSelection = useRef<TrajectoryTableProps['recordSelection']>(null)
  const appliedRecordFocus = useRef<TrajectoryTableProps['recordFocus']>(null)
  const tabHistory = useRef<Set<DetailTab>>(new Set(['overview']))
  const rootRef = useRef<HTMLDivElement>(null)
  const tablePaneRef = useRef<HTMLDivElement>(null)
  const followsTableTail = useRef(false)
  const tableScrollInitialized = useRef(false)
  const [tableScrollReady, setTableScrollReady] = useState(false)
  const pendingScrollRecordId = useRef<string | null>(null)
  const loadingOlder = useRef(false)
  const [olderLoading, setOlderLoading] = useState(false)
  const olderLoadAnchor = useRef<OlderLoadAnchor | null>(null)
  const { detailsWidth, toolRequestOffset, handlers: resizeHandlers } = useResizeHandle()
  const allRecords = useMemo(() => flattenRecords(turns), [turns])
  const streamingCellsByIndex = useMemo(
    () => new Map(streamingCells.map(cell => [cell.index, cell])),
    [streamingCells],
  )
  const currentRecord = useCallback((record: TableRecord): TableRecord => {
    const cell = streamingCellsByIndex.get(record.cell.index)
    return cell === undefined ? record : { ...record, cell }
  }, [streamingCellsByIndex])
  const selectedTemplate = useMemo(() => selectedRecordId === null
    ? undefined
    : allRecords.find(record => trajectoryRecordId(record.cell) === selectedRecordId),
  [allRecords, selectedRecordId])
  const selected = selectedTemplate === undefined
    ? undefined
    : currentRecord(selectedTemplate)
  const thinkingExpanded = thinkingDisclosure?.recordId === selectedRecordId
    ? thinkingDisclosure.expanded
    : selected?.cell.kind === 'message'
      && Boolean(selected.cell.thinkingDetail?.trim())
  const setThinkingExpanded = (expanded: boolean) => {
    if (selectedRecordId !== null) {
      setThinkingDisclosure({ recordId: selectedRecordId, expanded })
    }
  }
  const selectedIndex = selected?.cell.index ?? null
  useEffect(() => {
    onSelectedIndexChange?.(selectedIndex)
  }, [onSelectedIndexChange, selectedIndex])
  const requestGroups = useMemo(() => new Set(
    (sessionRequestNumbers ?? []).map(request => requestKey(request.turn, request.group)),
  ), [sessionRequestNumbers])
  const requestBoundaries = useMemo(
    () => indexRequestBoundaries(allRecords, requestGroups),
    [allRecords, requestGroups],
  )
  const requestNumbers = useMemo(
    () => indexRequestNumbers(sessionRequestNumbers),
    [sessionRequestNumbers],
  )
  const records = useMemo(() => {
    if (searchMatchIndexes !== null) return filterRecords(allRecords, searchMatchIndexes)
    const turnRecords = collapsedTurns.size === 0
      ? allRecords
      : collapseTurnRecords(allRecords, collapsedTurns, requestGroups, t)
    return collapsedAssistants.size === 0
      ? turnRecords
      : collapseAssistantRecords(turnRecords, collapsedAssistants, t)
  }, [allRecords, collapsedAssistants, collapsedTurns, requestGroups, searchMatchIndexes, t])
  const projectedVirtualRows = useMemo(
    () => groupTrajectoryVirtualRows(records),
    [records],
  )
  const virtualRowStructure = useStableVirtualRowStructure(projectedVirtualRows)
  const virtualizationEnabled = hasOlderRecords
    || records.length > VIRTUALIZATION_THRESHOLD
  const virtualScrollMargin = hasOlderRecords ? HISTORY_LOAD_ROW_HEIGHT_PX : 0
  const estimateVirtualRowSize = useCallback(
    (index: number) => virtualRowStructure[index]?.height ?? 30,
    [virtualRowStructure],
  )
  const getVirtualRowKey = useCallback(
    (index: number) => virtualRowStructure[index]?.key ?? index,
    [virtualRowStructure],
  )
  const getTableScrollElement = useCallback(() => tablePaneRef.current, [])
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: virtualizationEnabled ? virtualRowStructure.length : 0,
    enabled: virtualizationEnabled,
    estimateSize: estimateVirtualRowSize,
    getItemKey: getVirtualRowKey,
    getScrollElement: getTableScrollElement,
    initialRect: { width: 0, height: VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX },
    anchorTo: 'end',
    overscan: VIRTUAL_OVERSCAN_ROWS,
    scrollMargin: virtualScrollMargin,
    scrollEndThreshold: BOTTOM_FOLLOW_THRESHOLD_PX,
    followOnAppend: 'auto',
  })
  const virtualIndexByRecordId = useMemo(() => {
    const indexes = new Map<string, number>()
    for (const [virtualIndex, row] of projectedVirtualRows.entries()) {
      for (const entry of row.entries) {
        if (entry.record.collapsedSummary === undefined) {
          indexes.set(trajectoryRecordId(entry.record.cell), virtualIndex)
        }
      }
    }
    return indexes
  }, [projectedVirtualRows])
  const virtualItems = virtualizationEnabled ? rowVirtualizer.getVirtualItems() : []
  const virtualTop = Math.max(0, (virtualItems[0]?.start ?? 0) - virtualScrollMargin)
  const virtualBottom = virtualItems.length === 0
    ? 0
    : Math.max(
      0,
      rowVirtualizer.getTotalSize()
        + virtualScrollMargin
        - (virtualItems.at(-1)?.end ?? 0),
    )
  const renderedRecords = virtualizationEnabled
    ? virtualItems.flatMap((item) => {
      const row = projectedVirtualRows[item.index]
      if (row === undefined) return []
      return row.entries.map((entry, entryIndex) => ({
        record: currentRecord(entry.record),
        position: entry.logicalIndex,
        terminalRequestBoundary:
          entry.record.cell.requestOnly === true
          && row.entries.at(-1)?.record.cell.requestOnly === true
          && entryIndex === row.entries.length - 1,
      }))
    })
    : records.map((record, position) => ({
      record: currentRecord(record),
      position,
      terminalRequestBoundary:
        record.cell.requestOnly === true && position === records.length - 1,
    }))
  const requestBoundaryRuns = useMemo(
    () => indexRequestBoundaryRuns(records, requestGroups),
    [records, requestGroups],
  )
  const selectedRequestInfo = selectedRequest === null
    ? undefined
    : sessionRequestNumbers?.find(request =>
      requestIdentity(request) === selectedRequest.identity)
  const activeTurn = selectedRequestInfo === undefined ? selected?.turn : selectedRequestInfo.turn
  const activeSection = selectedRequestInfo === undefined
    ? selected?.section
    : allRecords.find(record =>
      record.turn === selectedRequestInfo.turn
        && record.group === selectedRequestInfo.group)?.section
  const splitStyle: TrajectorySplitStyle | undefined = toolRequestOffset === null
    ? undefined
    : {
      '--trajectory-tool-request-width': `calc(58cqw - ${toolRequestOffset}px)`,
    }

  const activateTab = useCallback((tab: DetailTab) => {
    setCodeWrappingOnOpen(stringWrapping?.getDefault() ?? false)
    tabHistory.current.delete(tab)
    tabHistory.current.add(tab)
    setActiveTab(tab)
  }, [stringWrapping])

  const clearInspectorSelection = () => {
    setSelectedRecordId(null)
    setSelectedRequest(null)
  }

  const clearAllSelections = () => {
    clearInspectorSelection()
    onClearSelection?.()
  }

  const selectRecord = useCallback((index: number) => {
    setCodeWrappingOnOpen(stringWrapping?.getDefault() ?? false)
    const record = allRecords.find(candidate => candidate.cell.index === index)
    onRecordSelect?.(index)
    setSelectedRequest(null)
    setSelectedRecordId(record === undefined ? null : trajectoryRecordId(record.cell))
    if (record === undefined) return
    const tabs = detailTabs(record)
    const available = new Set(tabs.map(tab => tab.id))
    const recent = [...tabHistory.current].reverse().find(tab => available.has(tab))
    setActiveTab(recent ?? tabs[0]?.id ?? 'overview')
  }, [allRecords, onRecordSelect, stringWrapping])
  useEffect(() => {
    if (
      recordSelection === null
      || appliedRecordSelection.current === recordSelection
    ) return
    appliedRecordSelection.current = recordSelection
    selectRecord(recordSelection.index)
    const record = allRecords.find(candidate => candidate.cell.index === recordSelection.index)
    pendingScrollRecordId.current = record === undefined
      ? null
      : trajectoryRecordId(record.cell)
  }, [allRecords, recordSelection, selectRecord])
  useEffect(() => {
    if (recordFocus === null || appliedRecordFocus.current === recordFocus) return
    appliedRecordFocus.current = recordFocus
    const record = allRecords.find(candidate => candidate.cell.index === recordFocus.index)
    pendingScrollRecordId.current = record === undefined
      ? null
      : trajectoryRecordId(record.cell)
  }, [allRecords, recordFocus])

  const selectRequest = useCallback((
    request: SelectedRequest,
    tab: 'overview' | 'timing' = 'overview',
  ) => {
    setSelectedRecordId(null)
    setSelectedRequest(request)
    activateTab(tab)
  }, [activateTab])

  const openRecordSummary = (target: TableRecord) => {
    const targetAt = allRecords.findIndex(record => record.cell.index === target.cell.index)
    if (target.turn !== null && collapsedTurns.has(target.turn)) onToggleTurn(target.turn)
    if (target.cell.kind === 'tool' || target.cell.kind === 'subtool') {
      for (let i = targetAt - 1; i >= 0; i--) {
        const candidate = allRecords[i]
        if (candidate === undefined || candidate.turn !== target.turn) break
        if (candidate.cell.kind !== 'message') continue
        const assistantId = trajectoryRecordId(candidate.cell)
        if (collapsedAssistants.has(assistantId)) onToggleAssistant(assistantId)
        break
      }
    }
    setSelectedRequest(null)
    setSelectedRecordId(trajectoryRecordId(target.cell))
    activateTab('overview')
  }

  const openCallSummary = (callId: string) => {
    const target = allRecords.find(record => record.cell.callId === callId)
    if (target !== undefined) openRecordSummary(target)
  }

  // Cross-view inspect handoff: resolve the requested call to its record,
  // open its summary, and remember the row to scroll once the un-collapsed
  // ledger has rendered. Not-found leaves the request pending (`turns` in the
  // deps retries as history pages in); the ack clears the store field.
  const openRecordSummaryRef = useRef(openRecordSummary)
  openRecordSummaryRef.current = openRecordSummary
  useEffect(() => {
    if (inspectCallId === null) return
    const target = flattenRecords(turns).find(record => record.cell.callId === inspectCallId)
    if (target === undefined) return
    openRecordSummaryRef.current(target)
    pendingScrollRecordId.current = trajectoryRecordId(target.cell)
    onInspectApplied?.()
  }, [inspectCallId, turns, onInspectApplied])
  useEffect(() => {
    const id = pendingScrollRecordId.current
    if (id === null) return
    const position = records.findIndex(record =>
      trajectoryRecordId(record.cell) === id && record.collapsedSummary === undefined)
    if (position === -1) return
    if (virtualizationEnabled) {
      const virtualIndex = virtualIndexByRecordId.get(id)
      if (virtualIndex === undefined) return
      pendingScrollRecordId.current = null
      followsTableTail.current = false
      rowVirtualizer.scrollToIndex(virtualIndex, { behavior: 'smooth', align: 'center' })
      return
    }
    pendingScrollRecordId.current = null
    followsTableTail.current = false
    const recordIndex = records[position]?.cell.index
    const row = recordIndex === undefined
      ? null
      : rootRef.current?.querySelector<HTMLElement>(`tr[data-record-index="${recordIndex}"]`)
    /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
    if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [records, rowVirtualizer, virtualIndexByRecordId, virtualizationEnabled])
  useEffect(() => {
    if (timelineFocusIndexes === null || timelineFocusIndexes.size === 0) return
    const focusedPositions = records.flatMap((record, position) =>
      record.collapsedSummary === undefined
      && record.cell.requestOnly !== true
      && timelineFocusIndexes.has(record.cell.index)
        ? [position]
        : [])
    const first = focusedPositions.at(0)
    const last = focusedPositions.at(-1)
    if (first === undefined || last === undefined) return
    if (!virtualizationEnabled) {
      const ledger = rootRef.current
      if (ledger === null) return
      const focusedRows = [
        ...ledger.querySelectorAll<HTMLElement>('tr[data-timeline-focus="inside"]'),
      ]
      const firstRow = focusedRows.at(0)
      const lastRow = focusedRows.at(-1)
      if (firstRow === undefined || lastRow === undefined) return
      const focusHeight =
        lastRow.getBoundingClientRect().bottom - firstRow.getBoundingClientRect().top
      const target = focusHeight > ledger.clientHeight
        ? firstRow
        : focusedRows[Math.floor((focusedRows.length - 1) / 2)]
      /* v8 ignore next -- jsdom lacks scrollIntoView; browsers always have it. */
      if (target !== undefined && typeof target.scrollIntoView === 'function') {
        followsTableTail.current = false
        target.scrollIntoView({
          behavior: 'smooth',
          block: focusHeight > ledger.clientHeight ? 'start' : 'center',
        })
      }
      return
    }
    const focusedVirtualIndexes = [...new Set(focusedPositions.flatMap((position) => {
      const record = records[position]
      if (record === undefined) return []
      const virtualIndex = virtualIndexByRecordId.get(trajectoryRecordId(record.cell))
      return virtualIndex === undefined ? [] : [virtualIndex]
    }))].sort((left, right) => left - right)
    const firstVirtual = focusedVirtualIndexes.at(0)
    const lastVirtual = focusedVirtualIndexes.at(-1)
    if (firstVirtual === undefined || lastVirtual === undefined) return
    const paneHeight = tablePaneRef.current?.clientHeight ?? 0
    const focusHeight = projectedVirtualRows
      .slice(firstVirtual, lastVirtual + 1)
      .reduce((height, row) => height + row.height, 0)
    followsTableTail.current = false
    rowVirtualizer.scrollToIndex(
      focusHeight > paneHeight
        ? firstVirtual
        : focusedVirtualIndexes[Math.floor((focusedVirtualIndexes.length - 1) / 2)]
          ?? firstVirtual,
      {
        behavior: 'smooth',
        align: focusHeight > paneHeight ? 'start' : 'center',
      },
    )
  }, [
    projectedVirtualRows,
    records,
    rowVirtualizer,
    timelineFocusIndexes,
    virtualIndexByRecordId,
    virtualizationEnabled,
  ])
  const requestOlder = useCallback((pane: HTMLDivElement, requireTop: boolean) => {
    if (
      !hasOlderRecords
      || onLoadOlder === undefined
      || loadingOlder.current
      || olderHistoryLoading
      || (requireTop && pane.scrollTop > OLDER_LOAD_THRESHOLD_PX)
    ) return
    loadingOlder.current = true
    setOlderLoading(true)
    olderLoadAnchor.current = {
      historyStartSeq,
      scrollHeight: pane.scrollHeight,
      scrollTop: pane.scrollTop,
    }
    void onLoadOlder().then((advanced) => {
      if (!advanced) olderLoadAnchor.current = null
    }).finally(() => {
      loadingOlder.current = false
      setOlderLoading(false)
    })
  }, [hasOlderRecords, historyStartSeq, olderHistoryLoading, onLoadOlder])
  useLayoutEffect(() => {
    const pane = tablePaneRef.current
    if (pane === null) return
    const anchor = olderLoadAnchor.current
    if (anchor !== null && anchor.historyStartSeq !== historyStartSeq) {
      if (!virtualizationEnabled) {
        pane.scrollTop = anchor.scrollTop + pane.scrollHeight - anchor.scrollHeight
      }
      olderLoadAnchor.current = null
      followsTableTail.current = false
      return
    }
    if (!tableScrollInitialized.current) {
      if (historyLoading) return
      tableScrollInitialized.current = true
      followsTableTail.current = true
      if (virtualizationEnabled) rowVirtualizer.scrollToEnd({ behavior: 'auto' })
      else pane.scrollTop = pane.scrollHeight
      setTableScrollReady(true)
      return
    }
    if (!followsTableTail.current) return
    if (!virtualizationEnabled) pane.scrollTop = pane.scrollHeight
  }, [
    historyLoading,
    historyStartSeq,
    rowVirtualizer,
    virtualRowStructure,
    virtualizationEnabled,
  ])

  const olderBusy = olderHistoryLoading || olderLoading
  const showInitialLoading = historyLoading || !tableScrollReady
  const historyRowOffset = hasOlderRecords ? 1 : 0

  return (
    <div ref={rootRef} className={css.split} style={splitStyle}>
      <div
        ref={tablePaneRef}
        className={css.tablePane}
        data-trajectory-scroll=""
        onScroll={(event) => {
          const pane = event.currentTarget
          followsTableTail.current =
            pane.scrollHeight - pane.clientHeight - pane.scrollTop
              <= BOTTOM_FOLLOW_THRESHOLD_PX
          requestOlder(pane, true)
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) clearAllSelections()
        }}
      >
        {showInitialLoading && (
          <div className={css.historyLoading} role="status" aria-live="polite">
            <span className={css.historyLoadingBar}>
              <StateDot state="ongoing" />
              {t('history.loadingTrajectory')}
            </span>
          </div>
        )}
        <table
          className={css.table}
          data-scroll-ready={tableScrollReady || undefined}
          aria-rowcount={records.length + historyRowOffset}
        >
          <colgroup>
            <col className={css.eventColumn} />
            <col className={css.contentColumn} />
          </colgroup>
          <tbody>
            {hasOlderRecords && (
              <tr
                className={css.historyLoadRow}
                data-history-load=""
                aria-rowindex={1}
              >
                <td colSpan={2}>
                  <button
                    type="button"
                    className={css.historyLoadButton}
                    disabled={olderBusy || onLoadOlder === undefined}
                    aria-label={olderBusy
                      ? t('history.loadingEarlierAria')
                      : t('history.loadEarlier')}
                    onClick={() => {
                      const pane = tablePaneRef.current
                      if (pane !== null) requestOlder(pane, false)
                    }}
                  >
                    {olderBusy && (
                      <StateDot state="ongoing" />
                    )}
                    <span aria-hidden="true">
                      {olderBusy ? t('history.loadingEarlier') : t('history.loadEarlier')}
                    </span>
                    <span className={css.visuallyHidden} role="status" aria-live="polite">
                      {olderBusy ? t('history.loadingEarlier') : ''}
                    </span>
                  </button>
                </td>
              </tr>
            )}
            {virtualTop > 0 && (
              <tr className={css.virtualSpacer} data-virtual-spacer="top" aria-hidden="true">
                <td
                  colSpan={2}
                  style={{
                    '--trajectory-virtual-spacer-height': `${virtualTop}px`,
                  } as VirtualSpacerStyle}
                />
              </tr>
            )}
            {renderedRecords.map(({ record, position, terminalRequestBoundary }) => {
              const isCollapsedSummary = record.collapsedSummary !== undefined
              const timelineFocus = isCollapsedSummary || timelineFocusIndexes === null
                ? undefined
                : timelineFocusIndexes.has(record.cell.index) ? 'inside' : 'outside'
              return (
                <TrajectoryRow
                  key={trajectoryVirtualRecordKey(record)}
                  record={record}
                  position={position}
                  terminalRequestBoundary={terminalRequestBoundary}
                  selected={selectedIndex === record.cell.index}
                  sectionActive={record.turn === null
                    ? activeSection === record.section
                    : activeTurn === record.turn}
                  timelineFocus={timelineFocus}
                  historyRowOffset={historyRowOffset}
                  virtualizationEnabled={virtualizationEnabled}
                  allRecords={allRecords}
                  requestBoundaries={requestBoundaries}
                  requestBoundaryRuns={requestBoundaryRuns}
                  requestNumbers={requestNumbers}
                  sessionRequestNumbers={sessionRequestNumbers}
                  selectedRequestIdentity={selectedRequest?.identity}
                  collapsedTurns={collapsedTurns}
                  t={t}
                  onSelectRecord={selectRecord}
                  onSelectRequest={selectRequest}
                  onToggleTurn={onToggleTurn}
                  onToggleAssistant={onToggleAssistant}
                />
              )
            })}
            {virtualBottom > 0 && (
              <tr className={css.virtualSpacer} data-virtual-spacer="bottom" aria-hidden="true">
                <td
                  colSpan={2}
                  style={{
                    '--trajectory-virtual-spacer-height': `${virtualBottom}px`,
                  } as VirtualSpacerStyle}
                />
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <RecordInspector
        watchToolResult={watchToolResult}
        t={t}
        renderSlot={renderSlot}
        loadImage={loadImage}
        allRecords={allRecords}
        currentRecord={currentRecord}
        requestNumbers={requestNumbers}
        sessionRequestNumbers={sessionRequestNumbers}
        selected={selected}
        selectedRequest={selectedRequest}
        activeTab={activeTab}
        stringWrapping={stringWrapping}
        codeWrappingOnOpen={codeWrappingOnOpen}
        thinkingExpanded={thinkingExpanded}
        detailsWidth={detailsWidth}
        resizeHandlers={resizeHandlers}
        onActivateTab={activateTab}
        onClearSelection={clearInspectorSelection}
        onOpenRecordSummary={openRecordSummary}
        onOpenCallSummary={openCallSummary}
        onSelectRequest={selectRequest}
        onThinkingExpandedChange={setThinkingExpanded}
      />
    </div>
  )
}
