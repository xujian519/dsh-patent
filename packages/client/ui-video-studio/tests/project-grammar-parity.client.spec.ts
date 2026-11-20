/** Host and Studio parity for project grammar, store vocabulary, task states, and committed spend. */
import { describe, expect, it } from 'vitest'
import { committedBudgetCny, projectSchema } from '@deepseek-ai/dsh-video-mode/src/project.ts'
import { BUDGET_LEDGER_FILE, TASK_JOURNAL_FILE } from '@deepseek-ai/dsh-video-mode/src/store.ts'
import type { MediaTaskStatus, VideoProject, VideoShot } from '@deepseek-ai/dsh-video-mode/src/types.ts'
import {
  LEDGER_FILE,
  PENDING_STATUSES,
  SHOT_STATUSES,
  StudioReadError,
  TASKS_FILE,
  parseLedgerTotal,
  parsePendingTasks,
  parseProjectDocument,
  spentCnyOf,
} from '../src/client/project-reads.ts'

const VALID_PROJECT = {
  schemaVersion: 1,
  id: 'episode-01',
  title: 'Episode One',
  aspect: '9:16',
  targetSeconds: 30,
  budgetCny: 10,
  shots: [
    {
      id: 'shot-02', index: 2, prompt: 'Second shot', durationSec: 4, status: 'ready',
      clipPath: 'shots/shot-02.mp4', provider: 'minimax', model: 'MiniMax-H3', costCny: 2,
    },
    { id: 'shot-01', index: 1, prompt: 'First shot', durationSec: 3, status: 'draft', costCny: 1.25 },
  ],
  renders: [{ id: 'render-1', path: 'out/episode-01.mp4', durationSec: 7, costCny: 3.25, createdAt: '2026-10-01T10:00:00.000Z' }],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
} as const satisfies VideoProject

function withShot(fields: Record<string, unknown>): unknown {
  return { ...VALID_PROJECT, shots: [{ ...VALID_PROJECT.shots[0], ...fields }, VALID_PROJECT.shots[1]] }
}

function withRender(fields: Record<string, unknown>): unknown {
  return { ...VALID_PROJECT, renders: [{ ...VALID_PROJECT.renders[0], ...fields }] }
}

const PROJECT_CASES: readonly { readonly name: string; readonly value: unknown; readonly accepted: boolean }[] = [
  { name: 'valid project', value: VALID_PROJECT, accepted: true },
  { name: 'invalid aspect', value: { ...VALID_PROJECT, aspect: '4:3' }, accepted: false },
  { name: 'zero shot index', value: withShot({ index: 0 }), accepted: false },
  { name: 'shot duration above 60', value: withShot({ durationSec: 61 }), accepted: false },
  { name: 'target above 3600', value: { ...VALID_PROJECT, targetSeconds: 3601 }, accepted: false },
  { name: 'invalid project id', value: { ...VALID_PROJECT, id: 'Episode-01' }, accepted: false },
  { name: 'unknown project field', value: { ...VALID_PROJECT, unexpected: true }, accepted: false },
  { name: 'unknown shot field', value: withShot({ unexpected: true }), accepted: false },
  { name: 'unknown render field', value: withRender({ unexpected: true }), accepted: false },
  { name: 'invalid shot status', value: withShot({ status: 'succeeded' }), accepted: false },
  { name: 'wrong schema version', value: { ...VALID_PROJECT, schemaVersion: 2 }, accepted: false },
  { name: 'empty title', value: { ...VALID_PROJECT, title: '' }, accepted: false },
  { name: 'empty shot prompt', value: withShot({ prompt: '' }), accepted: false },
  { name: 'empty project creation time', value: { ...VALID_PROJECT, createdAt: '' }, accepted: false },
  { name: 'empty project update time', value: { ...VALID_PROJECT, updatedAt: '' }, accepted: false },
  { name: 'empty optional shot path', value: withShot({ keyframePath: '' }), accepted: false },
  { name: 'negative shot cost', value: withShot({ costCny: -1 }), accepted: false },
  { name: 'zero optional render duration', value: withRender({ durationSec: 0 }), accepted: false },
  { name: 'negative render cost', value: withRender({ costCny: -1 }), accepted: false },
  { name: 'empty render creation time', value: withRender({ createdAt: '' }), accepted: false },
]

describe('Host project grammar parity', () => {
  it.each(PROJECT_CASES)('$name', ({ value, accepted }) => {
    const host = projectSchema.safeParse(value)
    let clientAccepted = false
    try {
      parseProjectDocument(value)
      clientAccepted = true
    } catch (error) {
      expect(error).toBeInstanceOf(StudioReadError)
    }
    expect(host.success).toBe(accepted)
    expect(clientAccepted).toBe(host.success)
  })
})

// These tables are exhaustive at compile time against the Host vocabulary in types.ts:14 and types.ts:287.
const HOST_SHOT_STATUS_TABLE = {
  draft: true, ready: true, generating: true, failed: true,
} satisfies Readonly<Record<VideoShot['status'], true>>
const HOST_TASK_STATUS_TABLE = {
  queued: true, submitted: true, running: true, succeeded: true, failed: true, cancelled: true,
} satisfies Readonly<Record<MediaTaskStatus, true>>

describe('Host store vocabulary parity', () => {
  it('uses the Host file names and status tables', () => {
    expect(TASKS_FILE).toBe(TASK_JOURNAL_FILE)
    expect(LEDGER_FILE).toBe(BUDGET_LEDGER_FILE)
    expect(SHOT_STATUSES).toEqual(Object.keys(HOST_SHOT_STATUS_TABLE))
    // Host store.ts:72 journals only the first three states from the six-state MediaTaskStatus union.
    expect(PENDING_STATUSES).toEqual(Object.keys(HOST_TASK_STATUS_TABLE).slice(0, 3))
    expect(Object.keys(HOST_TASK_STATUS_TABLE).slice(3)).toEqual(['succeeded', 'failed', 'cancelled'])
  })

  it('keeps pending journal states and filters every terminal Host state', () => {
    const tasks = Object.keys(HOST_TASK_STATUS_TABLE).map((status, index) => ({
      task: { id: `task-${index}`, provider: 'minimax', model: 'MiniMax-H3', kind: 'video', status },
      submittedAt: index,
      outputPath: `shots/${status}.mp4`,
    }))
    expect(parsePendingTasks({ schemaVersion: 1, tasks }).map(task => task.status)).toEqual(PENDING_STATUSES)
  })
})

describe('Host committed spend parity', () => {
  it('takes the same maximum as both Host budget checks', () => {
    const host = projectSchema.parse(VALID_PROJECT)
    const client = parseProjectDocument(VALID_PROJECT)
    // Host tools/deliver.ts:108 and tools/media.ts:186 both call project.ts:384 committedBudgetCny.
    expect(spentCnyOf(client.shots, 4.25)).toBe(committedBudgetCny(host, 4.25))
    expect(spentCnyOf(client.shots, 0.5)).toBe(committedBudgetCny(host, 0.5))
  })

  it('retains the Studio display exception for schema-valid fractional fen', () => {
    const fractional = { ...VALID_PROJECT, shots: [{ ...VALID_PROJECT.shots[0], costCny: 0.001 }] }
    const host = projectSchema.parse(fractional)
    const client = parseProjectDocument(fractional)
    // Host budget arithmetic keeps raw numbers; the Studio rounds its display totals to fen.
    expect(committedBudgetCny(host, 0)).toBe(0.001)
    expect(spentCnyOf(client.shots, 0)).toBe(0)
  })

  it('deduplicates ledger charges by task id', () => {
    expect(parseLedgerTotal({ entries: [
      { taskId: 'task-a', costCny: 0.1 },
      { taskId: 'task-a', costCny: 0.2 },
      { taskId: 'task-b', costCny: 0.2 },
    ] })).toBe(0.3)
  })
})
