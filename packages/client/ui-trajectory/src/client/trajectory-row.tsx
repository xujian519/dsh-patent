/**
 * One ledger row: its event column with the request boundary control, kind marker, turn rail, and
 * label, and its content column with the record's one-line presentation.
 */

import { memo } from 'react'
import type { CSSProperties } from 'react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { trajectoryRecordId } from './trajectory-record.ts'
import { trajectoryVirtualRecordKey } from './trajectory-virtual-rows.ts'
import {
  assistantToolCalls, requestIdentity, requestKey, sectionLabel, stateOf,
} from './trajectory-record-model.ts'
import { RecordListText, RecordPresentation } from './trajectory-record-presentation.tsx'
import { KIND_ICON, KIND_LABEL_KEY } from './trajectory-kind.tsx'
import type { SelectedRequest } from './trajectory-record-inspector.tsx'
import type { TrajectoryTranslate } from './locales.ts'
import type { TableRecord, TrajectoryRequestNumber } from './trajectory-types.ts'
import css from './TrajectoryTable.module.css'

type RequestBoundaryStyle = CSSProperties & {
  '--request-boundary-offset': string
}

/** Props for one ledger row. */
interface TrajectoryRowProps {
  /** Display record this row renders, including the fold summary that stands in for one. */
  record: TableRecord
  /** Logical position in the rendered record list, which ARIA row indexes are offset from. */
  position: number
  /** Whether this row holds the ledger's last request-only separator. */
  terminalRequestBoundary: boolean
  /** Whether the selected record is this row's record. */
  selected: boolean
  /** Whether the active turn or section covers this row. */
  sectionActive: boolean
  /** Timeline focus for this row within the active range, undefined without one. */
  timelineFocus: 'inside' | 'outside' | undefined
  /** ARIA row offset of the history-load row, which occupies row 1 when present. */
  historyRowOffset: number
  /** Whether the ledger virtualizes rows, which then carry their virtual position. */
  virtualizationEnabled: boolean
  /** Complete resident records, read for the initial-system marker and tool-call folding. */
  allRecords: readonly TableRecord[]
  /** First record index of each request group. */
  requestBoundaries: ReadonlyMap<string, number>
  /** Offset of a request-only separator within its run of separators. */
  requestBoundaryRuns: ReadonlyMap<number, number>
  /** Session-global request number per request-group key. */
  requestNumbers: ReadonlyMap<string, number>
  /** Session-global request numbers, read for a boundary's status and label. */
  sessionRequestNumbers: readonly TrajectoryRequestNumber[] | undefined
  /** Identity of the selected request, undefined when none is selected. */
  selectedRequestIdentity: string | undefined
  /** Turn ids whose rows after the first are folded into a summary. */
  collapsedTurns: ReadonlySet<number>
  /** Trajectory locale seat. */
  t: TrajectoryTranslate
  /** Select this row's record. */
  onSelectRecord: (index: number) => void
  /** Select this row's request boundary. */
  onSelectRequest: (request: SelectedRequest, tab?: 'overview' | 'timing') => void
  /** Toggle one turn between folded and expanded. */
  onToggleTurn: (turn: number) => void
  /** Toggle tool calls under one assistant record. */
  onToggleAssistant: (id: string) => void
}

/**
 * Render one ledger row. The memo boundary compares these props shallowly, so the ledger passes
 * primitives and identities it keeps across renders: a row that nothing selected and no fold or
 * search touched stays mounted while its parent re-renders.
 * @param props - The row's record, its ledger-derived markers, and the callbacks its controls fire.
 * @returns The row's event and content cells.
 */
export const TrajectoryRow = memo(function TrajectoryRow({
  record,
  position,
  terminalRequestBoundary,
  selected,
  sectionActive,
  timelineFocus,
  historyRowOffset,
  virtualizationEnabled,
  allRecords,
  requestBoundaries,
  requestBoundaryRuns,
  requestNumbers,
  sessionRequestNumbers,
  selectedRequestIdentity,
  collapsedTurns,
  t,
  onSelectRecord,
  onSelectRequest,
  onToggleTurn,
  onToggleAssistant,
}: TrajectoryRowProps) {
  return (
    <RecordPresentation cell={record.cell} t={t}>
      {({ displayText, listDisplayText, resultText, toolCallOnly, toolCallText }) => {
        const isCollapsedSummary = record.collapsedSummary !== undefined
        const isRequestOnly = record.cell.requestOnly === true
        const singleToolNotice = record.cell.kind === 'context'
          && record.cell.sourceBlocks?.length === 1
          && record.cell.sourceBlocks.every(block => block.type === 'tool-addition' || block.type === 'tool-removal')
        const isInitialSystem = record.cell.kind === 'system'
          && record.cell.index === allRecords[0]?.cell.index
        const key = requestKey(record.turn, record.group)
        const request = requestBoundaries.get(key) === record.cell.index
          && !isCollapsedSummary
          && (record.turn === null || !collapsedTurns.has(record.turn))
          ? requestNumbers.get(key)
          : undefined
        const requestInfo = request === undefined
          ? undefined
          : sessionRequestNumbers?.find(candidate => candidate.number === request)
        const requestStatus = requestInfo?.status
          ?? (record.cell.isError === true ? 'error' : undefined)
        const requestRunIndex = requestBoundaryRuns.get(record.cell.index) ?? 0
        const requestBoundaryStyle: RequestBoundaryStyle = {
          '--request-boundary-offset': `${requestRunIndex * 8}px`,
        }
        const requestLabel = request === undefined
          ? undefined
          : t(requestInfo?.purpose === 'compaction'
            ? 'request.labelCompaction'
            : 'request.label', { request })
        const requestSelected = requestInfo !== undefined
          && selectedRequestIdentity === requestIdentity(requestInfo)
        return (
          <tr
            tabIndex={isRequestOnly || singleToolNotice ? -1 : 0}
            aria-rowindex={position + 1 + historyRowOffset}
            aria-label={isCollapsedSummary
              ? t('request.collapsedSummary', {
                kind: t(record.collapsedSummaryKind === 'turn'
                  ? 'request.collapsedTurn'
                  : 'request.collapsedAssistant'),
                summary: record.collapsedSummary,
              })
              : isRequestOnly
                ? t('request.rowAriaCompaction', { request: request ?? '' })
                : t('request.rowAria', {
                  request: request === undefined ? '' : t('request.rowPrefix', { request }),
                  kind: t(KIND_LABEL_KEY[record.cell.kind]),
                  content: listDisplayText || t('request.noContent'),
                })}
            aria-selected={!isCollapsedSummary && !isRequestOnly && selected}
            data-kind={record.cell.kind}
            data-trajectory-row-key={trajectoryVirtualRecordKey(record)}
            data-virtual-position={virtualizationEnabled ? position : undefined}
            data-record-index={!isCollapsedSummary && !isRequestOnly
              ? record.cell.index
              : undefined}
            data-request-only={isRequestOnly || undefined}
            data-terminal-request-boundary={terminalRequestBoundary || undefined}
            data-group-start={record.groupStart || undefined}
            data-turn-start={record.turnStart || undefined}
            data-error={record.cell.isError || undefined}
            data-running={stateOf(record) === 'running' || undefined}
            data-turn-end={record.turnEnd || undefined}
            data-collapsed-summary={record.collapsedSummaryKind}
            data-selected={!isCollapsedSummary && selected || undefined}
            data-timeline-focus={timelineFocus}
            onClick={isRequestOnly || singleToolNotice
              ? undefined
              : isCollapsedSummary
                ? () => {
                  if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                    onToggleTurn(record.turn)
                  } else onToggleAssistant(trajectoryRecordId(record.cell))
                }
                : () => { onSelectRecord(record.cell.index) }}
            onDoubleClick={(event) => {
              if (isCollapsedSummary || isRequestOnly) return
              if (record.turn !== null && collapsedTurns.has(record.turn)) {
                event.preventDefault()
                onToggleTurn(record.turn)
                return
              }
              if (
                record.cell.kind === 'message'
                && assistantToolCalls(allRecords, record.cell.index).length > 0
              ) {
                event.preventDefault()
                onToggleAssistant(trajectoryRecordId(record.cell))
                return
              }
              if (!record.turnStart) return
              if (record.turn === null) return
              if (allRecords.filter(candidate =>
                candidate.turn === record.turn
                && candidate.cell.requestOnly !== true
                && candidate.cell.kind !== 'system').length <= 1) return
              event.preventDefault()
              onToggleTurn(record.turn)
            }}
            onKeyDown={(event) => {
              if (isRequestOnly) return
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              if (isCollapsedSummary) {
                if (record.collapsedSummaryKind === 'turn' && record.turn !== null) {
                  onToggleTurn(record.turn)
                } else onToggleAssistant(trajectoryRecordId(record.cell))
                return
              }
              onSelectRecord(record.cell.index)
            }}
          >
            <td className={css.event}>
              {request !== undefined && (
                <button
                  type="button"
                  className={requestSelected
                    ? `${css.requestBoundaryControl} ${css.requestBoundaryControlActive}`
                    : css.requestBoundaryControl}
                  aria-label={requestLabel}
                  aria-pressed={requestSelected}
                  data-label={requestLabel}
                  data-request-run-index={requestRunIndex}
                  data-request-status={requestStatus}
                  style={requestBoundaryStyle}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (requestInfo !== undefined) {
                      onSelectRequest({ identity: requestIdentity(requestInfo) })
                    }
                  }}
                  onDoubleClick={(event) => { event.stopPropagation() }}
                />
              )}
              {record.turn !== null
                && sectionActive
                && !isInitialSystem && (
                <span className={css.turnRail} aria-hidden="true" />
              )}
              {!isCollapsedSummary && selected && (
                <span className={css.selectionRail} aria-hidden="true" />
              )}
              {!isCollapsedSummary
                && !isRequestOnly
                && record.turnStart && (
                <span
                  className={sectionActive
                    ? `${css.turnLabel} ${css.turnLabelActive}`
                    : css.turnLabel}
                  aria-label={sectionLabel(record.turn, t)}
                >
                  {record.turn === null
                    ? sectionLabel(record.turn, t)
                    : (
                      <>
                        <span className={css.turnLabelFull} aria-hidden="true">
                          {sectionLabel(record.turn, t)}
                        </span>
                        <span className={css.turnLabelCompact} aria-hidden="true">
                          #{record.turn}
                        </span>
                      </>
                    )}
                </span>
              )}
              <div className={css.eventInner}>
                {!isCollapsedSummary && !isRequestOnly && (
                  <span
                    className={css.kindSlot}
                  >
                    <span
                      className={`${css.kindTag} ${
                        record.cell.kind === 'system'
                          ? css.systemNeutral
                          : record.cell.kind === 'context'
                            ? css.contextGreen
                            : record.cell.kind === 'compacted'
                              ? css.compacted
                              : record.cell.kind === 'tool'
                                ? css.toolAmber
                                : record.cell.kind === 'message'
                                  ? css.assistantVioletBright
                                  : record.cell.kind === 'subtool'
                                    ? css.subtoolAmber
                                    : css[record.cell.kind]
                      }`}
                      data-role-kind={record.cell.kind}
                    >
                      <Tooltip
                        label={t(KIND_LABEL_KEY[record.cell.kind])}
                        side="right"
                      >
                        <span className={css.kindTagIcon} aria-hidden="true">
                          {KIND_ICON[record.cell.kind]}
                        </span>
                      </Tooltip>
                      <span className={css.kindTagLabel}>
                        {t(KIND_LABEL_KEY[record.cell.kind])}
                      </span>
                    </span>
                  </span>
                )}
              </div>
            </td>
            <td className={css.content}>
              {isRequestOnly
                ? null
                : record.collapsedSummary !== undefined
                  ? (
                    <span className={css.collapsedTurnContent} title={record.collapsedSummary}>
                      <span className={css.collapsedTurnEllipsis}>…</span>
                      <span className={css.collapsedTurnText}>{record.collapsedSummary}</span>
                    </span>
                  )
                  : (
                    <span
                      className={resultText === undefined ? css.contentText : css.resultPreview}
                      title={resultText === undefined
                        ? listDisplayText
                        : `${listDisplayText} → ${resultText}`}
                    >
                      <span className={resultText === undefined ? undefined : css.resultRequest}>
                        <RecordListText
                          displayText={displayText}
                          toolCallOnly={toolCallOnly}
                          toolCallText={toolCallText}
                          t={t}
                        />
                      </span>
                      {resultText !== undefined && (
                        <span className={record.cell.isError ? `${css.inlineResult} ${css.error}` : css.inlineResult}>
                          <span className={css.arrow}>→</span>
                          <span className={resultText === t('record.noOutput')
                            ? `${css.inlineResultText} ${css.noOutputText}`
                            : css.inlineResultText}
                          >
                            {resultText}
                          </span>
                        </span>
                      )}
                    </span>
                  )}
            </td>
          </tr>
        )
      }}
    </RecordPresentation>
  )
})
