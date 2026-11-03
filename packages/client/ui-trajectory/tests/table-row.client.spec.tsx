// @vitest-environment jsdom
/**
 * The ledger's row boundary: a re-render that changes no row input leaves the mounted rows alone,
 * and a selection re-renders only the rows whose own inputs changed. `RecordPresentation` counts
 * row renders because the row is its only consumer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { TrajectoryTable } from '../src/client/TrajectoryTable.tsx'
import * as presentation from '../src/client/trajectory-record-presentation.tsx'
import type { TrajectoryCellProps } from '../src/client/trajectory-record.ts'
import type { TrajectoryTurnModel } from '../src/client/layout.ts'
import { t } from './locale.client.ts'

vi.mock('../src/client/trajectory-record-presentation.tsx', async (importOriginal) => {
  const original = await importOriginal<typeof presentation>()
  return { ...original, RecordPresentation: vi.fn(original.RecordPresentation) }
})

afterEach(() => {
  cleanup()
  vi.mocked(presentation.RecordPresentation).mockClear()
})

const EMPTY_TURNS: ReadonlySet<number> = new Set()
const EMPTY_ASSISTANTS: ReadonlySet<string> = new Set()
const NOOP = () => {}
const ROW_COUNT = 6

const renderSlot: PropsRenderSlots<'conversation.trajectory.images'>['renderSlot'] = () => null
const loadImage: MessageImageLoader = async () => 'blob:table-row'

function messageCell(index: number): TrajectoryCellProps {
  return {
    index,
    kind: 'message',
    text: `reply ${index}`,
    outputDetail: `reply ${index}`,
    timeSeconds: 1,
  }
}

function toolCell(index: number): TrajectoryCellProps {
  return {
    index,
    kind: 'tool',
    text: 'bash · {"command":"pwd"}',
    inputDetail: '{"command":"pwd"}',
    timeSeconds: 0.5,
  }
}

const TURNS: readonly TrajectoryTurnModel[] = [1, 2, 3].map(turn => ({
  turn,
  groups: [{
    title: `Step ${turn}`,
    cells: [messageCell(turn * 2 - 1), toolCell(turn * 2)],
  }],
}))

function table(props: Partial<ComponentProps<typeof TrajectoryTable>> = {}) {
  return (
    <TrajectoryTable
      t={t}
      renderSlot={renderSlot}
      loadImage={loadImage}
      turns={TURNS}
      collapsedTurns={EMPTY_TURNS}
      onToggleTurn={NOOP}
      collapsedAssistants={EMPTY_ASSISTANTS}
      onToggleAssistant={NOOP}
      collapsedTools={new Set<string>()}
      onToggleTool={NOOP}
      {...props}
    />
  )
}

function rowRenders(): number {
  return vi.mocked(presentation.RecordPresentation).mock.calls.length
}

function mountedRows(): number {
  return document.querySelectorAll('tr[data-trajectory-row-key]').length
}

describe('Trajectory table row boundary', () => {
  it('leaves every mounted row alone when a re-render changes no row input', () => {
    const { rerender } = render(table())
    expect(mountedRows()).toBe(ROW_COUNT)
    expect(rowRenders()).toBe(ROW_COUNT)

    rerender(table({ historyLoading: true }))

    expect(document.body.textContent).toContain(t('history.loadingTrajectory'))
    expect(rowRenders()).toBe(ROW_COUNT)
    expect(mountedRows()).toBe(ROW_COUNT)
  })

  it('re-renders only the rows whose own inputs changed after a selection', () => {
    render(table())
    const before = rowRenders()
    const target = document.querySelector('tr[data-record-index="3"]')
    expect(target).not.toBeNull()
    fireEvent.click(target!)

    // The selected row and the rest of its turn: every other turn keeps its false section state.
    expect(rowRenders() - before).toBe(2)
  })
})
