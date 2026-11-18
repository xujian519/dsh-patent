/**
 * document-deliverables derivation and session-fold view target: the
 * turn-scoped produced-file definition, its publication, and the session-wide
 * builder that folds every turn in the window.
 */
import { describe, expect, it } from 'vitest'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ConversationMatch, ConversationNodeDefinition, ConversationStartMatch, TurnLocation,
  ConversationTimelineSnapshot, ConversationViewDefinition, ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  DOCUMENT_DELIVER_TOOL, documentDeliverablesDefinition, documentDeliverablesViewDefinition,
  parseCheckReports, parseDeliverRegistration, parseRegistrationFacts,
  type DocumentDeliverablesSnapshot, type DocumentTurnDeliverables,
} from '../src/client/document-deliverables.ts'

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] { return [documentDeliverablesDefinition] }
  fallbackEntry(): ConversationNodeDefinition | undefined { return undefined }
}

interface TimelineSnapshot { readonly timeline: ConversationTimelineSnapshot }

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] { return [timelineViewDefinition] }
  fallbackEntry(): ConversationViewDefinition | undefined { return undefined }
}

const timelineViewDefinition: ConversationViewDefinition<ConversationViewNode, TimelineSnapshot> = {
  target: 'test',
  create: () => {
    let current: TimelineSnapshot = { timeline: { turnOrder: [], turns: new Map() } }
    return {
      empty: current,
      replace: ({ timeline }) => (current = { timeline }),
      apply: ({ timeline }) => (current = { timeline }),
    }
  },
}

function at(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      seq, time: seq * 1_000, type, data,
      ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
    } as SessionEvent,
  }
}

function matched(input: SessionLiveEventEntry, role: 'start'): ConversationStartMatch
function matched(input: SessionLiveEventEntry, role: 'update'): ConversationMatch
function matched(input: SessionLiveEventEntry, role: ConversationMatch['role']): ConversationMatch {
  return { event: input.event, role, location: { kind: 'unresolved' } }
}

function call(seq: number, callId: string, name: string, args: Readonly<Record<string, unknown>>, turn = 1): SessionLiveEventEntry {
  return rawCall(seq, callId, name, JSON.stringify(args), turn)
}

function rawCall(seq: number, callId: string, name: string, argsRaw: string, turn = 1): SessionLiveEventEntry {
  return at(seq, 'tool/call', { turn, step: 1, callId, name, arguments: argsRaw })
}

function result(seq: number, callId: string, isError = false, turn = 1, meta?: unknown): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    turn, step: 1,
    message: { source: { kind: 'tool', callId }, content: [], isError },
    ...meta === undefined ? {} : { meta },
  })
}

function assembler(entries: readonly SessionLiveEventEntry[]): ConversationNodeAssembler {
  const views = new TestViewDefinitions()
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), views)
  // Snapshot building is lazy: activate every view before the first flush.
  for (const view of views.entries()) value.retainTarget(view.target)
  value.replaceWindow(entries, false)
  value.flush()
  return value
}

function turnDataOf(value: ConversationNodeAssembler, turn = 1): Readonly<DocumentTurnDeliverables> | undefined {
  const snapshot = value.snapshot('test') as TimelineSnapshot
  return snapshot.timeline.turns.get(turn)?.data.get('documentDeliverables')
}

function timelineOf(value: ConversationNodeAssembler): ConversationTimelineSnapshot {
  return (value.snapshot('test') as TimelineSnapshot).timeline
}

describe('documentDeliverables turn data', () => {
  it('folds successful mutation calls; reads, failures, and orphan results contribute nothing', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', 'write', { file_path: 'out/index.html', content: '<html></html>' }),
      result(3, 'write'),
      call(4, 'style', 'write', { file_path: 'out/app.css', content: 'body {}' }),
      result(5, 'style'),
      call(6, 'notes', 'edit', { file_path: 'notes.md', old_string: 'a', new_string: 'b' }),
      result(7, 'notes'),
      call(8, 'read', 'read', { file_path: 'input.txt' }),
      result(9, 'read'),
      call(10, 'failed', 'write', { file_path: 'broken.txt', content: 'x' }),
      result(11, 'failed', true),
      result(12, 'orphan'),
    ])

    expect(turnDataOf(value)?.produced).toEqual([
      { seq: 3, path: 'out/index.html' },
      { seq: 5, path: 'out/app.css' },
      { seq: 7, path: 'notes.md' },
    ])
  })

  it('ignores orphan results and non-append replacement results', () => {
    const replacement = result(11, 'repl')
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', 'write', { file_path: 'out/index.html', content: 'x' }),
      result(3, 'write'),
      // A result whose call never entered this window: no call, nothing produced.
      result(9, 'ghost'),
      // A result without the append surface is not accepted by the definition.
      {
        ...replacement,
        event: {
          ...replacement.event,
          surfaceOp: { op: 'replace', start: 1, end: 1 },
        } as SessionEvent,
      },
    ])

    expect(turnDataOf(value)?.produced).toEqual([{ seq: 3, path: 'out/index.html' }])
  })

  it('keeps turn data append-only; the session fold deduplicates paths', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write1', 'write', { file_path: 'out/index.html', content: '1' }),
      result(3, 'write1'),
      call(4, 'write2', 'write', { file_path: 'out/index.html', content: '2' }),
      result(5, 'write2'),
    ])

    // The turn accumulator appends every successful mutation (same vocabulary
    // as ui-deliverables); the fold in the session view target dedupes.
    expect(turnDataOf(value)?.produced).toEqual([
      { seq: 3, path: 'out/index.html' },
      { seq: 5, path: 'out/index.html' },
    ])
    const timeline = timelineOf(value)
    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline })
    expect(fold.produced).toEqual([{ seq: 3, path: 'out/index.html' }])
  })

  it('publishes only at turn scope', () => {
    const match = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const start = documentDeliverablesDefinition.start?.({} as never, match, {} as never)
    const state = start === undefined ? undefined : { ...start, produced: [{ seq: 3, path: 'a.html' }] }
    const turn = documentDeliverablesDefinition.buildLocationData?.({ state } as never, 'turn', null)
    const step = documentDeliverablesDefinition.buildLocationData?.({ state } as never, 'step', null)
    expect(turn).toEqual({ kind: 'turn', turn: 1, key: 'documentDeliverables', value: { produced: [{ seq: 3, path: 'a.html' }] } })
    expect(step).toBeNull()
  })

  it('rejects a start without a turn/start event', () => {
    const wrong = matched(at(1, 'user', { message: { role: 'user', content: [] } }), 'start')
    expect(() => documentDeliverablesDefinition.start?.({} as never, wrong, {} as never)).toThrow(/start requires turn\/start/)
  })
})

describe('documentDeliverables session view target', () => {
  function fold(timeline: ConversationTimelineSnapshot): DocumentDeliverablesSnapshot {
    const builder = documentDeliverablesViewDefinition.create()
    return builder.replace({ nodes: [], timeline })
  }

  it('folds every turn in the window, first-seen order, deduplicating across turns', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', 'write', { file_path: 'out/index.html', content: '1' }),
      result(3, 'write'),
      at(4, 'turn/start', { turn: 2 }),
      call(5, 'edit', 'edit', { file_path: 'out/index.html', old_string: '1', new_string: '2' }),
      result(6, 'edit'),
      call(7, 'deck', 'write', { file_path: 'deck.html', content: 'x' }),
      result(8, 'deck'),
    ])

    expect(fold(timelineOf(value))).toEqual({
      produced: [
        { seq: 3, path: 'out/index.html' },
        { seq: 8, path: 'deck.html' },
      ],
    })
  })

  it('returns the stable empty snapshot for an empty window and skips turns without data', () => {
    const value = assembler([at(1, 'turn/start', { turn: 1 }), at(1, 'user', { message: { role: 'user', content: [] } })])
    expect(fold(timelineOf(value))).toEqual({ produced: [] })
    expect(documentDeliverablesViewDefinition.create().empty).toEqual({ produced: [] })
  })

  it('apply recomputes the same fold as replace', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', 'write', { file_path: 'a.html', content: 'x' }),
      result(3, 'write'),
    ])
    const builder = documentDeliverablesViewDefinition.create()
    const timeline = timelineOf(value)
    expect(builder.apply({ upserts: [], timeline })).toEqual(builder.replace({ nodes: [], timeline }))
  })
})

describe('document_deliver registrations', () => {
  function deliver(
    seq: number, callId: string, argumentsJson: string, turn = 1,
  ): SessionLiveEventEntry {
    return rawCall(seq, callId, 'document_deliver', argumentsJson, turn)
  }

  it('folds a successful registration with format, gate, and brief reference', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg', JSON.stringify({
        files: [{ path: 'out/report.docx', format: 'docx' }, { path: 'out/report.html', format: 'html' }],
        gate: { p0: ['命名规范', '自包含'], p1: ['可访问性'] },
        brief_ref: 'brief.md',
      })),
      result(3, 'reg'),
    ])

    expect(turnDataOf(value)?.produced).toEqual([
      {
        seq: 3, path: 'out/report.docx', format: 'docx',
        gate: { p0: ['命名规范', '自包含'], p1: ['可访问性'] }, briefRef: 'brief.md',
      },
      {
        seq: 3, path: 'out/report.html', format: 'html',
        gate: { p0: ['命名规范', '自包含'], p1: ['可访问性'] }, briefRef: 'brief.md',
      },
    ])
  })

  it('folds without p1/briefRef when the registration omits them', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg', JSON.stringify({
        files: [{ path: 'deck.html', format: 'html' }],
        gate: { p0: ['命名规范'] },
      })),
      result(3, 'reg'),
    ])
    expect(turnDataOf(value)?.produced).toEqual([
      { seq: 3, path: 'deck.html', format: 'html', gate: { p0: ['命名规范'], p1: [] } },
    ])
  })

  it('does not fold failed registrations or malformed registration arguments', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'failed-reg', JSON.stringify({
        files: [{ path: 'a.docx', format: 'docx' }], gate: { p0: ['x'] },
      })),
      result(3, 'failed-reg', true),
      deliver(4, 'not-json', 'not-json'),
      result(5, 'not-json'),
      deliver(6, 'bad-files', JSON.stringify({ files: 'nope', gate: { p0: ['x'] } })),
      result(7, 'bad-files'),
      deliver(8, 'bad-file-shape', JSON.stringify({
        files: [{ path: 1, format: 'html' }], gate: { p0: ['x'] },
      })),
      result(9, 'bad-file-shape'),
      deliver(10, 'bad-gate', JSON.stringify({
        files: [{ path: 'a.html', format: 'html' }],
        gate: { p0: ['x'], p1: [2] },
      })),
      result(11, 'bad-gate'),
    ])

    expect(turnDataOf(value)?.produced).toEqual([])
  })

  it('upgrades a mutation-derived entry in the session fold when a later registration covers the same path', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', 'write', { file_path: 'out/report.html', content: 'x' }),
      result(3, 'write'),
      at(4, 'turn/start', { turn: 2 }),
      deliver(5, 'reg', JSON.stringify({
        files: [{ path: 'out/report.html', format: 'html' }],
        gate: { p0: ['命名规范'] },
      }), 2),
      result(6, 'reg', false, 2),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([
      { seq: 3, path: 'out/report.html', format: 'html', gate: { p0: ['命名规范'], p1: [] } },
    ])
  })

  it('attaches the machine checks each registration result recorded', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg', JSON.stringify({
        files: [{ path: 'out/report.md', format: 'markdown' }, { path: 'out/deck.pdf', format: 'pdf' }],
        gate: { p0: ['命名规范'] },
        char_budget: 500,
      })),
      result(3, 'reg', false, 1, {
        checks: [
          {
            path: 'out/report.md',
            format: 'markdown',
            status: 'checked',
            findings: [{ check: 'empty_section', level: 'warn', detail: '第 5 行的标题 "空节" 下没有任何内容', line: 5 }],
          },
          { path: 'out/deck.pdf', format: 'pdf', status: 'unchecked', reason: 'pdf 格式没有文本读取器', findings: [] },
        ],
      }),
    ])

    expect(turnDataOf(value)?.produced).toEqual([
      {
        seq: 3, path: 'out/report.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] },
        checks: {
          status: 'checked',
          findings: [{ check: 'empty_section', level: 'warn', detail: '第 5 行的标题 "空节" 下没有任何内容', line: 5 }],
        },
      },
      {
        seq: 3, path: 'out/deck.pdf', format: 'pdf', gate: { p0: ['命名规范'], p1: [] },
        checks: { status: 'unchecked', reason: 'pdf 格式没有文本读取器', findings: [] },
      },
    ])
  })

  it('drops a recorded verdict once a later mutation rewrites the file', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg', JSON.stringify({
        files: [{ path: 'out/report.md', format: 'markdown' }],
        gate: { p0: ['命名规范'] },
      })),
      result(3, 'reg', false, 1, {
        checks: [{ path: 'out/report.md', format: 'markdown', status: 'checked', findings: [] }],
      }),
      // 改写该文件：登记的核验结论属于旧字节，不再成立；格式与质量门声明仍保留。
      at(4, 'tool/call', { turn: 1, callId: 'w1', name: 'write', arguments: JSON.stringify({ file_path: 'out/report.md', content: 'x' }) }),
      result(5, 'w1', false, 1),
    ])

    expect(turnDataOf(value)?.produced).toEqual([
      { seq: 3, path: 'out/report.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] }, checks: { status: 'checked', findings: [] } },
      { seq: 5, path: 'out/report.md' },
    ])
    // 折叠后同一路径只留一条：旧核验结论被抹掉，格式与质量门声明保留；
    // 抹掉这件事本身记在 checksWithdrawn 上，重放时仍然显示"未重新核验"。
    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([
      {
        seq: 3, path: 'out/report.md', format: 'markdown',
        gate: { p0: ['命名规范'], p1: [] }, checksWithdrawn: true,
      },
    ])
  })

  it('drops a recorded verdict when a later registration carries no check report', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg-1', JSON.stringify({
        files: [{ path: 'out/report.md', format: 'markdown' }],
        gate: { p0: ['命名规范'] },
      })),
      result(3, 'reg-1', false, 1, {
        checks: [{ path: 'out/report.md', format: 'markdown', status: 'checked', findings: [] }],
      }),
      // 第二次登记声明了质量门，但没有可读的核验结论：声明续上了，核验没续上。
      deliver(4, 'reg-2', JSON.stringify({
        files: [{ path: 'out/report.md', format: 'markdown' }],
        gate: { p0: ['命名规范', '自包含'] },
      })),
      result(5, 'reg-2'),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([
      {
        seq: 3, path: 'out/report.md', format: 'markdown',
        gate: { p0: ['命名规范', '自包含'], p1: [] }, checksWithdrawn: true,
      },
    ])
  })

  it('attaches no checks for a registration whose result carried none or an unreadable payload', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'no-meta', JSON.stringify({ files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['x'] } })),
      result(3, 'no-meta'),
      deliver(4, 'not-a-record', JSON.stringify({ files: [{ path: 'b.html', format: 'html' }], gate: { p0: ['x'] } })),
      result(5, 'not-a-record', false, 1, { checks: 'nope' }),
      deliver(6, 'bad-status', JSON.stringify({ files: [{ path: 'c.html', format: 'html' }], gate: { p0: ['x'] } })),
      result(7, 'bad-status', false, 1, { checks: [{ path: 'c.html', format: 'html', status: 'unknown', findings: [] }] }),
      deliver(8, 'bad-finding', JSON.stringify({ files: [{ path: 'd.html', format: 'html' }], gate: { p0: ['x'] } })),
      result(9, 'bad-finding', false, 1, {
        checks: [{ path: 'd.html', format: 'html', status: 'checked', findings: [{ check: 1, level: 'warn', detail: 'x' }] }],
      }),
    ])

    expect(turnDataOf(value)?.produced).toEqual([
      { seq: 3, path: 'a.html', format: 'html', gate: { p0: ['x'], p1: [] } },
      { seq: 5, path: 'b.html', format: 'html', gate: { p0: ['x'], p1: [] } },
      { seq: 7, path: 'c.html', format: 'html', gate: { p0: ['x'], p1: [] } },
      { seq: 9, path: 'd.html', format: 'html', gate: { p0: ['x'], p1: [] } },
    ])
  })

  it('rejects a check report that is not an object, and one whose line is not a whole number', () => {    expect(parseCheckReports({ checks: ['nope'] })).toBeUndefined()
    expect(parseCheckReports({ checks: [{ path: 'a.html', status: 'checked', findings: [{ check: 'x', level: 'warn', detail: 'd', line: 1.5 }] }] })).toBeUndefined()
    expect(parseCheckReports({
      checks: [{ path: 'a.html', status: 'checked', findings: [], reason: 7 }],
    })).toBeUndefined()
    expect(parseCheckReports(undefined)).toBeUndefined()
    expect([...(parseCheckReports({
      checks: [{ path: 'a.html', format: 'html', status: 'checked', findings: [] }],
    }) ?? new Map()).keys()]).toEqual(['a.html'])
  })
})

describe('registration facts and refused registrations', () => {
  /** A `document_deliver` call declaring one file under one P0 item. */
  function deliver(seq: number, callId: string, path = 'out/a.md', turn = 1): SessionLiveEventEntry {
    return rawCall(seq, callId, DOCUMENT_DELIVER_TOOL, JSON.stringify({
      files: [{ path, format: 'markdown' }], gate: { p0: ['命名规范'] },
    }), turn)
  }

  /** A failed `tool/result` carrying the given error and message content. */
  function failed(
    seq: number, callId: string, error?: unknown, content: readonly unknown[] = [], turn = 1,
  ): SessionLiveEventEntry {
    return at(seq, 'tool/result', {
      turn,
      step: 1,
      message: { source: { kind: 'tool', callId }, content, isError: true },
      ...error === undefined ? {} : { error },
    })
  }

  function foldOf(entries: readonly SessionLiveEventEntry[]): DocumentDeliverablesSnapshot {
    return documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(assembler(entries)) })
  }

  it('reads each registration fact on its own, ignoring an unreadable one', () => {
    expect(parseRegistrationFacts(undefined)).toEqual({})
    expect(parseRegistrationFacts('nope')).toEqual({})
    // A blank style names no style; a non-string one is not read as text.
    expect(parseRegistrationFacts({ style: '   ' })).toEqual({})
    expect(parseRegistrationFacts({ style: 7 })).toEqual({})
    expect(parseRegistrationFacts({ style: 'assistant-neutral' })).toEqual({ style: 'assistant-neutral' })
    // Warnings survive only as a non-empty list of strings.
    expect(parseRegistrationFacts({ warnings: [] })).toEqual({})
    expect(parseRegistrationFacts({ warnings: 'nope' })).toEqual({})
    expect(parseRegistrationFacts({ warnings: ['a', 7] })).toEqual({})
    expect(parseRegistrationFacts({ style: 'assistant-neutral', warnings: ['a'] }))
      .toEqual({ style: 'assistant-neutral', warnings: ['a'] })
  })

  it('attaches the style and the declaration warnings the registration recorded', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg'),
      result(3, 'reg', false, 1, {
        style: 'assistant-neutral',
        warnings: ['P0 项 "自查" 不是已知的质量门 id'],
      }),
    ])

    expect(turnDataOf(value)?.produced).toEqual([{
      seq: 3, path: 'out/a.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] },
      verifiedStyle: 'assistant-neutral',
      registrationWarnings: ['P0 项 "自查" 不是已知的质量门 id'],
    }])
  })

  it('replaces both facts with the newest registration\'s, dropping the ones it omits', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg-1'),
      result(3, 'reg-1', false, 1, { style: 'assistant-neutral', warnings: ['第一条'] }),
      at(4, 'turn/start', { turn: 2 }),
      deliver(5, 'reg-2', 'out/a.md', 2),
      result(6, 'reg-2', false, 2, { style: 'legal-formal' }),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3, path: 'out/a.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] },
      verifiedStyle: 'legal-formal',
    }])
  })

  it('adopts the warnings a later registration adds to an earlier one', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg-1'),
      result(3, 'reg-1', false, 1, { style: 'assistant-neutral' }),
      at(4, 'turn/start', { turn: 2 }),
      deliver(5, 'reg-2', 'out/a.md', 2),
      result(6, 'reg-2', false, 2, { warnings: ['第二条'] }),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3, path: 'out/a.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] },
      registrationWarnings: ['第二条'],
    }])
  })

  it('reports a refusal with the reason the result recorded, for every named file', () => {
    const entries = [
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg'),
      failed(3, 'reg', { name: 'HarnessError', code: 'document-deliver/blocked', reason: ' P0 门未通过 ' }),
    ]

    const rejection = { seq: 3, paths: ['out/a.md'], message: 'P0 门未通过' }
    expect(turnDataOf(assembler(entries))).toEqual({ produced: [], rejected: rejection })
    expect(foldOf(entries)).toEqual({ produced: [], rejection })
  })

  it('falls back to the result text when the failure recorded no usable reason', () => {
    for (const error of [undefined, { reason: '   ' }]) {
      const value = assembler([
        at(1, 'turn/start', { turn: 1 }),
        deliver(2, 'reg'),
        failed(3, 'reg', error, [{ type: 'text', text: '  第一行\n第二行  ' }, { type: 'image' }]),
      ])
      expect(turnDataOf(value)?.rejected?.message).toBe('第一行\n第二行')
    }
  })

  it('ignores a failure that names no file, and one whose result carries no text', () => {
    const mutation = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'w', 'write', { file_path: 'out/a.md', content: 'x' }),
      failed(3, 'w', { reason: '磁盘已满' }),
    ])
    expect(turnDataOf(mutation)?.rejected).toBeUndefined()

    // A registration result with neither a reason nor text blocks records no
    // refusal, because there would be nothing to show.
    const silent = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'reg'),
      failed(3, 'reg', undefined, [{ type: 'text', text: '   ' }]),
    ])
    expect(turnDataOf(silent)?.rejected).toBeUndefined()
  })

  it('settles a refusal once a later registration in the turn is accepted', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'bad'),
      failed(3, 'bad', { reason: 'P0 门未通过' }),
      deliver(4, 'good'),
      result(5, 'good'),
    ])

    expect(turnDataOf(value)?.rejected).toBeUndefined()
    expect(turnDataOf(value)?.produced).toEqual([{
      seq: 5, path: 'out/a.md', format: 'markdown', gate: { p0: ['命名规范'], p1: [] },
    }])
  })

  it('settles a refusal with an accepted registration that declares no file', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'bad'),
      failed(3, 'bad', { reason: 'P0 门未通过' }),
      rawCall(4, 'empty', DOCUMENT_DELIVER_TOOL, JSON.stringify({ files: [], gate: { p0: [] } })),
      result(5, 'empty'),
    ])

    expect(turnDataOf(value)).toEqual({ produced: [] })
  })

  it('keeps a refusal in the turn after a later mutation settles', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'bad'),
      failed(3, 'bad', { reason: 'P0 门未通过' }),
      call(4, 'w', 'write', { file_path: 'out/a.md', content: 'x' }),
      result(5, 'w'),
    ])

    expect(turnDataOf(value)).toEqual({
      produced: [{ seq: 5, path: 'out/a.md' }],
      rejected: { seq: 3, paths: ['out/a.md'], message: 'P0 门未通过' },
    })
  })

  it('keeps a refusal standing across turns until a registration is accepted', () => {
    const refused = [
      at(1, 'turn/start', { turn: 1 }),
      deliver(2, 'bad'),
      failed(3, 'bad', { reason: 'P0 门未通过' }),
    ]
    expect(foldOf(refused).rejection?.message).toBe('P0 门未通过')

    // A turn that only rewrote a file neither repeats nor settles the refusal.
    const rewritten = foldOf([
      ...refused,
      at(4, 'turn/start', { turn: 2 }),
      call(5, 'w', 'write', { file_path: 'out/a.md', content: 'x' }, 2),
      result(6, 'w', false, 2),
    ])
    expect(rewritten.rejection?.message).toBe('P0 门未通过')
    expect(rewritten.produced).toEqual([{ seq: 6, path: 'out/a.md' }])

    const settled = foldOf([
      ...refused,
      at(4, 'turn/start', { turn: 2 }),
      deliver(5, 'good', 'out/a.md', 2),
      result(6, 'good', false, 2),
    ])
    expect(settled.rejection).toBeUndefined()
  })
})

describe('canonical deliverable identity', () => {
  const ABS = '/ws/out/report.html'

  /** A `write` call whose result records the Host's canonical absolute path. */
  function write(seq: number, callId: string, declared: string, turn = 1): SessionLiveEventEntry {
    return call(seq, callId, 'write', { file_path: declared, content: 'x' }, turn)
  }

  function resolvedResult(seq: number, callId: string, identity?: string, turn = 1): SessionLiveEventEntry {
    return result(seq, callId, false, turn, identity === undefined ? undefined : { path: identity })
  }

  function deliverRegistration(
    seq: number, callId: string, files: Array<{ path: string; format: string }>, turn = 1,
  ): SessionLiveEventEntry {
    return rawCall(seq, callId, 'document_deliver', JSON.stringify({
      files, gate: { p0: ['命名规范'] },
    }), turn)
  }

  it('joins a relative write and an absolute registration of the same file into one row', () => {
    // The measured reproduction from issue #504: one file, two spellings.
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', 'out/report.html'),
      resolvedResult(3, 'w1', ABS),
      deliverRegistration(4, 'reg', [{ path: ABS, format: 'html' }]),
      result(5, 'reg', false, 1, {
        checks: [{ path: ABS, identity: ABS, format: 'html', status: 'checked', findings: [] }],
      }),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toHaveLength(1)
    expect(fold.produced).toEqual([{
      seq: 3,
      // The first-seen spelling stays the display copy.
      path: 'out/report.html',
      identity: ABS,
      format: 'html',
      gate: { p0: ['命名规范'], p1: [] },
      checks: { status: 'checked', findings: [], identity: ABS },
    }])
  })

  it('joins an absolute write and a relative registration of the same file into one row', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', ABS),
      resolvedResult(3, 'w1', ABS),
      deliverRegistration(4, 'reg', [{ path: 'out/report.html', format: 'html' }]),
      result(5, 'reg', false, 1, {
        checks: [{ path: 'out/report.html', identity: ABS, format: 'html', status: 'checked', findings: [] }],
      }),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toHaveLength(1)
    expect(fold.produced[0]?.identity).toBe(ABS)
    expect(fold.produced[0]?.checks?.status).toBe('checked')
  })

  it('attaches a check report to a registration whose declared spelling differs from the report key', () => {
    // `parseCheckReports` keys by the declared path; `identity` carries the join,
    // so a registration that declared one spelling still gets its verdict.
    const reports = parseCheckReports({
      checks: [{ path: 'out/report.html', identity: ABS, format: 'html', status: 'checked', findings: [] }],
    })
    expect(reports?.get('out/report.html')?.identity).toBe(ABS)
    expect(reports?.get('out/report.html')?.status).toBe('checked')
  })

  it('withdraws the verdict and records the withdrawal when the rewrite carries the other spelling', () => {
    // The stale-verdict requirement: the rewrite arrives as a relative path
    // after an absolute registration. Same identity, so the earlier verdict is
    // withdrawn and the withdrawal replays as "file changed, not re-checked".
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliverRegistration(2, 'reg', [{ path: ABS, format: 'html' }]),
      result(3, 'reg', false, 1, {
        checks: [{ path: ABS, identity: ABS, format: 'html', status: 'checked', findings: [] }],
      }),
      write(4, 'w1', 'out/report.html'),
      resolvedResult(5, 'w1', ABS),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3,
      path: ABS,
      identity: ABS,
      format: 'html',
      gate: { p0: ['命名规范'], p1: [] },
      checksWithdrawn: true,
    }])
    expect(fold.produced[0]?.checks).toBeUndefined()
  })

  it('keeps two genuinely different files apart', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', 'out/report.html'),
      resolvedResult(3, 'w1', '/ws/out/report.html'),
      write(4, 'w2', 'out/summary.html'),
      resolvedResult(5, 'w2', '/ws/out/summary.html'),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced.map(entry => entry.identity)).toEqual(['/ws/out/report.html', '/ws/out/summary.html'])
  })

  it('joins an unresolved registration to an already-identified write of the same spelling', () => {
    // Degrade path while the Host half is not yet in the log: the mutation
    // records a canonical target but the registration result carries no
    // identity. The fold must still join them by declared spelling rather than
    // splitting one file into two rows.
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', ABS),
      resolvedResult(3, 'w1', ABS),
      deliverRegistration(4, 'reg', [{ path: ABS, format: 'html' }]),
      result(5, 'reg'),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3,
      path: ABS,
      identity: ABS,
      format: 'html',
      gate: { p0: ['命名规范'], p1: [] },
    }])
  })

  it('joins a relative write to a relative registration while the Host records no identity', () => {
    // The pre-#504 log this fix must not regress: the mutation resolved a
    // canonical target, the registration result recorded none, and both
    // declared the same relative spelling. Before identity existed these joined
    // by spelling, and they must still join.
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', 'out/report.html'),
      resolvedResult(3, 'w1', ABS),
      deliverRegistration(4, 'reg', [{ path: 'out/report.html', format: 'html' }]),
      result(5, 'reg'),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3,
      path: 'out/report.html',
      identity: ABS,
      format: 'html',
      gate: { p0: ['命名规范'], p1: [] },
    }])
  })

  it('keeps a legacy registration that recorded no identity as one row', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      deliverRegistration(2, 'reg', [{ path: 'out/report.html', format: 'html' }]),
      result(3, 'reg'),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3, path: 'out/report.html', format: 'html', gate: { p0: ['命名规范'], p1: [] },
    }])
  })

  it('joins a third spelling of the same file after a merge introduced the identity', () => {
    // The registration (turn 1) contributes the identity the earlier relative
    // write lacked. A later mutation spelled the third way must still reach the
    // same row instead of starting a duplicate.
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', 'out/report.html'),
      result(3, 'w1'),
      at(4, 'turn/start', { turn: 2 }),
      deliverRegistration(5, 'reg', [{ path: 'out/report.html', format: 'html' }], 2),
      result(6, 'reg', false, 2, {
        checks: [{ path: 'out/report.html', identity: ABS, format: 'html', status: 'checked', findings: [] }],
      }),
      at(7, 'turn/start', { turn: 3 }),
      write(8, 'w2', './out/report.html', 3),
      resolvedResult(9, 'w2', ABS, 3),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toHaveLength(1)
    expect(fold.produced[0]?.identity).toBe(ABS)
    // The third entry rewrote the file, so the turn-2 verdict is withdrawn.
    expect(fold.produced[0]?.checksWithdrawn).toBe(true)
  })

  it('degrades to the declared spelling for a mutation result with no resolvable identity', () => {
    // A legacy result (no meta) and a relative meta.path both leave the entry
    // keyed by its own spelling, exactly as before the identity existed.
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', 'out/report.html'),
      result(3, 'w1'),
      write(4, 'w2', 'out/summary.html'),
      result(5, 'w2', false, 1, { path: 'out/summary.html' }),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([
      { seq: 3, path: 'out/report.html' },
      { seq: 5, path: 'out/summary.html' },
    ])
  })

  it('keeps a legacy argument path that is already absolute', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      write(2, 'w1', ABS),
      result(3, 'w1'),
    ])

    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{ seq: 3, path: ABS, identity: ABS }])
  })

  it('rejects a check payload whose identity is present but not a non-blank string', () => {
    // A half-read record yields no badge at all rather than a badge keyed on a
    // path the Host did not actually resolve.
    for (const identity of ['', '   ', 7, null, {}]) {
      expect(parseCheckReports({
        checks: [{ path: ABS, identity, format: 'html', status: 'checked', findings: [] }],
      })).toBeUndefined()
    }
  })

  it('accepts a check payload with no identity at all (results recorded before it existed)', () => {
    const reports = parseCheckReports({
      checks: [{ path: ABS, format: 'html', status: 'checked', findings: [] }],
    })
    expect(reports?.get(ABS)).toEqual({ status: 'checked', findings: [] })
  })
})

describe('payload rejection and mutation-argument derivation', () => {
  /** Paths the turn publishes for a sequence of calls and their results. */
  function producedPaths(entries: readonly SessionLiveEventEntry[]): readonly string[] {
    const value = assembler([at(1, 'turn/start', { turn: 1 }), ...entries])
    return (turnDataOf(value)?.produced ?? []).map(entry => entry.path)
  }

  /** A turn whose window published no document-deliverable data at all. */
  function emptyTurn(turn: number): TurnLocation {
    return {
      turn,
      start: undefined,
      end: undefined,
      status: 'unknown',
      steps: [],
      data: {
        get: () => undefined,
        source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }),
      },
    }
  }

  it('rejects a registration payload that is not an object with files and a gate', () => {
    const parse = (payload: unknown): unknown =>
      parseDeliverRegistration(DOCUMENT_DELIVER_TOOL, JSON.stringify(payload))
    // A payload that is not an object at all, and one that is null.
    expect(parse('text')).toBeUndefined()
    expect(parse(null)).toBeUndefined()
    // `files` must be an array of objects carrying a string path and format.
    expect(parse({ files: 'nope', gate: { p0: ['x'] } })).toBeUndefined()
    expect(parse({ files: [null], gate: { p0: ['x'] } })).toBeUndefined()
    expect(parse({ files: [7], gate: { p0: ['x'] } })).toBeUndefined()
    // The gate is required, and P0 must be a string list.
    expect(parse({ files: [{ path: 'a.html', format: 'html' }] })).toBeUndefined()
    expect(parse({ files: [{ path: 'a.html', format: 'html' }], gate: null })).toBeUndefined()
    expect(parse({ files: [{ path: 'a.html', format: 'html' }], gate: { p0: 'x' } })).toBeUndefined()
    expect(parse({ files: [{ path: 'a.html', format: 'html' }], gate: { p0: [1] } })).toBeUndefined()
    expect(parse({ files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['x'], p1: 'y' } })).toBeUndefined()
  })

  it('rejects a check report whose entry or finding is malformed', () => {
    // A report entry without a path, or with findings that are not a list.
    expect(parseCheckReports({ checks: [{ status: 'checked', findings: [] }] })).toBeUndefined()
    expect(parseCheckReports({ checks: [{ path: 'a.html', status: 'checked', findings: 'nope' }] })).toBeUndefined()
    // A finding that is not an object rejects the whole payload.
    expect(parseCheckReports({ checks: [{ path: 'a.html', status: 'checked', findings: [null] }] })).toBeUndefined()
    // A finding with no line is valid and records no position.
    expect(parseCheckReports({
      checks: [{ path: 'a.html', status: 'checked', findings: [{ check: 'x', level: 'warn', detail: 'd' }] }],
    })).toEqual(new Map([['a.html', { status: 'checked', findings: [{ check: 'x', level: 'warn', detail: 'd' }] }]]))
  })

  it('derives a mutation path only from a complete first-party mutation call', () => {
    expect(producedPaths([
      // `write` without string content is not a settled write.
      call(2, 'w1', 'write', { file_path: 'a.html' }),
      result(3, 'w1'),
      call(4, 'w2', 'write', { file_path: 'b.html', content: 'x' }),
      result(5, 'w2'),
      // An `edit` must replace a non-empty old string with a different one.
      call(6, 'e1', 'edit', { file_path: 'c.md', old_string: '', new_string: 'x' }),
      result(7, 'e1'),
      call(8, 'e2', 'edit', { file_path: 'd.md', old_string: 'a', new_string: 'b', replace_all: true }),
      result(9, 'e2'),
      call(10, 'e3', 'edit', { file_path: 'e.md', old_string: 'a', new_string: 'a' }),
      result(11, 'e3'),
      call(12, 'e4', 'edit', { file_path: 'f.md', old_string: 'a', new_string: 'b', replace_all: 'yes' }),
      result(13, 'e4'),
      // Arguments that do not parse to a record, and a tool that is no mutation.
      rawCall(14, 'raw', 'write', 'null'),
      result(15, 'raw'),
      call(16, 'read', 'read', { file_path: 'g.md' }),
      result(17, 'read'),
    ])).toEqual(['b.html', 'd.md'])
  })

  it('derives a path from a complete editor mutation command only', () => {
    expect(producedPaths([
      call(2, 'c1', 'str_replace_editor', { command: 'create', path: 'a.html', file_text: '<p>x</p>' }),
      result(3, 'c1'),
      // `create` without file text declares no content.
      call(4, 'c2', 'str_replace_editor', { command: 'create', path: 'b.html' }),
      result(5, 'c2'),
      // `str_replace` needs a non-empty old string; the new string is optional.
      call(6, 's1', 'str_replace_editor', { command: 'str_replace', path: 'c.md', old_str: 'a' }),
      result(7, 's1'),
      call(8, 's2', 'str_replace_editor', { command: 'str_replace', path: 'd.md', old_str: '', new_str: 'x' }),
      result(9, 's2'),
      call(10, 's3', 'str_replace_editor', { command: 'str_replace', path: 'e.md', old_str: 'a', new_str: 1 }),
      result(11, 's3'),
      // `insert` needs a whole, non-negative line and the inserted text.
      call(12, 'i1', 'str_replace_editor', { command: 'insert', path: 'f.md', insert_line: 0, new_str: 'x' }),
      result(13, 'i1'),
      call(14, 'i2', 'str_replace_editor', { command: 'insert', path: 'g.md', insert_line: -1, new_str: 'x' }),
      result(15, 'i2'),
      call(16, 'i3', 'str_replace_editor', { command: 'insert', path: 'h.md', insert_line: 1.5, new_str: 'x' }),
      result(17, 'i3'),
      call(18, 'i4', 'str_replace_editor', { command: 'insert', path: 'i.md', insert_line: 1 }),
      result(19, 'i4'),
      // A non-mutating command, and a blank path, contribute nothing.
      call(20, 'v1', 'str_replace_editor', { command: 'view', path: 'j.md' }),
      result(21, 'v1'),
      call(22, 'v2', 'str_replace_editor', { command: 'create', path: '   ', file_text: 'x' }),
      result(23, 'v2'),
    ])).toEqual(['a.html', 'c.md', 'f.md'])
  })

  it('ignores an update match that is neither a tool call nor a tool result', () => {
    const state = { turn: 1, calls: new Map(), produced: [] }
    const match = matched(at(1, 'turn/start', { turn: 1 }), 'update')
    expect(documentDeliverablesDefinition.update({ state } as never, match)).toBe(state)
  })

  it('keeps a registration brief reference through a later rewrite', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      rawCall(2, 'reg', DOCUMENT_DELIVER_TOOL, JSON.stringify({
        files: [{ path: 'out/report.html', format: 'html' }], gate: { p0: ['x'] }, brief_ref: 'brief.md',
      })),
      result(3, 'reg'),
      call(4, 'w', 'write', { file_path: 'out/report.html', content: 'x' }),
      result(5, 'w'),
    ])
    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3, path: 'out/report.html', format: 'html', gate: { p0: ['x'], p1: [] }, briefRef: 'brief.md',
    }])
  })

  it('adopts a brief reference a later registration adds to an earlier rewrite', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'w', 'write', { file_path: 'out/report.html', content: 'x' }),
      result(3, 'w'),
      at(4, 'turn/start', { turn: 2 }),
      rawCall(5, 'reg', DOCUMENT_DELIVER_TOOL, JSON.stringify({
        files: [{ path: 'out/report.html', format: 'html' }], gate: { p0: ['x'] }, brief_ref: 'brief.md',
      }), 2),
      result(6, 'reg', false, 2),
    ])
    const fold = documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline: timelineOf(value) })
    expect(fold.produced).toEqual([{
      seq: 3, path: 'out/report.html', format: 'html', gate: { p0: ['x'], p1: [] }, briefRef: 'brief.md',
    }])
  })

  it('skips a turn whose window published no document-deliverable data', () => {
    const timeline: ConversationTimelineSnapshot = {
      turnOrder: [1],
      turns: new Map([[1, emptyTurn(1)]]),
    }
    expect(documentDeliverablesViewDefinition.create().replace({ nodes: [], timeline })).toEqual({ produced: [] })
  })
})
