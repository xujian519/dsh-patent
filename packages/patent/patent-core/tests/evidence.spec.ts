import { expect, it } from 'vitest'
import { contentHash, createSpan } from '@deepseek-ai/dsh-patent-core'
import { ClaimBinding } from '../src/evidence/claimBinding.ts'
import { ConflictDetector } from '../src/evidence/conflict.ts'
import { EvidenceExtension } from '../src/evidence/index.ts'
import { Ledger } from '../src/evidence/receipt.ts'
import { isLocatable } from '../src/evidence/span.ts'
import { receiptFromToolExecution } from '../src/evidence/protocol.ts'
import type { EvidenceSpan } from '../src/evidence/span.ts'

// ---------------------------------------------------------------------------
// EvidenceSpan 工厂与可定位性
// ---------------------------------------------------------------------------

it('createSpan：缺省生成 id，四元组定位信息可校验', () => {
  const span = createSpan({
    docVersion: 'v1.0',
    pageRange: '第3页第15-20行',
    charRange: '1200-1250',
    contentHash: 'abc123',
    snippet: '原文摘录',
    direction: 'supporting',
  })
  expect(span.id).toMatch(/^span-/)
  expect(span.direction).toBe('supporting')
  expect(isLocatable(span)).toBe(true)
})

it('isLocatable：无任何定位信息时为 false', () => {
  const span = createSpan({ snippet: '只有摘录', direction: 'neutral' })
  expect(isLocatable(span)).toBe(false)
})

// ---------------------------------------------------------------------------
// Receipt 与 Ledger
// ---------------------------------------------------------------------------

it('receiptFromToolExecution：提取 path 与写分类', () => {
  const r = receiptFromToolExecution({
    toolCallId: 'call-1',
    turnId: 'turn-1',
    toolName: 'write_file',
    args: { path: '/tmp/a.md', content: 'x' },
    success: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    resultText: '已写入',
  })
  expect(r.path).toBe('/tmp/a.md')
  expect(r.write).toBe(true)
  expect(r.toolName).toBe('write_file')
  expect(r.success).toBe(true)
})

it('receiptFromToolExecution：读工具标记 write=false，结果超长截断', () => {
  const r = receiptFromToolExecution({
    toolCallId: 'call-2',
    turnId: 'turn-1',
    toolName: 'read_file',
    args: { path: '/tmp/b.md' },
    success: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    resultText: 'x'.repeat(5000),
  })
  expect(r.write).toBe(false)
  expect((r.resultText?.length ?? 0) <= 2000).toBeTruthy()
})

it('Ledger：按 turn 重置，按工具检索', () => {
  const real = new Ledger()
  real.record(
    receiptFromToolExecution({
      toolCallId: 'a',
      turnId: 't1',
      toolName: 'read_file',
      args: {},
      success: true,
      startedAt: 'x',
    }),
  )
  real.record(
    receiptFromToolExecution({
      toolCallId: 'b',
      turnId: 't1',
      toolName: 'write_file',
      args: { path: '/p' },
      success: true,
      startedAt: 'x',
    }),
  )
  expect(real.size()).toBe(2)
  expect(real.byTool('read_file').length).toBe(1)
  real.reset()
  expect(real.size()).toBe(0)
})

// ---------------------------------------------------------------------------
// ClaimBinding：无证据支持结论
// ---------------------------------------------------------------------------

it('ClaimBinding：unbackedClaims 列出无证据结论，空集合返回空数组', () => {
  const binding = new ClaimBinding()
  binding.bind('claim-1', 'span-1')
  expect(binding.unbackedClaims(['claim-1', 'claim-2'])).toEqual(['claim-2'])
  expect(binding.unbackedClaims([])).toEqual([])
  // 解绑后变回无证据
  binding.unbind('claim-1', 'span-1')
  expect(binding.unbackedClaims(['claim-1'])).toEqual(['claim-1'])
})

// ---------------------------------------------------------------------------
// ConflictDetector：两类冲突
// ---------------------------------------------------------------------------

it('ConflictDetector：同一结论同时有支持+矛盾证据 → claim 冲突', () => {
  const detector = new ConflictDetector()
  const spansById = new Map<string, EvidenceSpan>([
    ['s1', createSpan({ id: 's1', direction: 'supporting', sourceUri: 'file:///a' })],
    ['s2', createSpan({ id: 's2', direction: 'contradicting', sourceUri: 'file:///b' })],
  ])
  const spansByClaim = new Map([['claim-1', ['s1', 's2']]])
  const conflicts = detector.detect({ claimIds: ['claim-1'], spansByClaim, spansById })
  expect(conflicts.length).toBe(1)
  expect(conflicts[0]?.type).toBe('claim')
  expect(conflicts[0]?.subject).toBe('claim-1')
})

it('ConflictDetector：同源证据方向矛盾 → source 冲突', () => {
  const detector = new ConflictDetector()
  const spansById = new Map<string, EvidenceSpan>([
    ['s1', createSpan({ id: 's1', direction: 'supporting', sourceUri: 'file:///same' })],
    ['s2', createSpan({ id: 's2', direction: 'contradicting', sourceUri: 'file:///same' })],
  ])
  const conflicts = detector.detect({ claimIds: ['c1'], spansByClaim: new Map(), spansById })
  const sourceConflicts = conflicts.filter(c => c.type === 'source')
  expect(sourceConflicts.length).toBe(1)
  expect(sourceConflicts[0]?.subject).toBe('file:///same')
})

it('ConflictDetector：无矛盾时不报冲突', () => {
  const detector = new ConflictDetector()
  const spansById = new Map<string, EvidenceSpan>([
    ['s1', createSpan({ id: 's1', direction: 'supporting', sourceUri: 'file:///a' })],
    ['s2', createSpan({ id: 's2', direction: 'supporting', sourceUri: 'file:///b' })],
  ])
  const spansByClaim = new Map([['c1', ['s1', 's2']]])
  expect(detector.detect({ claimIds: ['c1'], spansByClaim, spansById })).toEqual([])
})

// ---------------------------------------------------------------------------
// EvidenceExtension：端到端闭环
// ---------------------------------------------------------------------------

it('EvidenceExtension：Receipt 入账 → 提升证据 → 绑定 → 无证据/冲突查询', () => {
  const ext = new EvidenceExtension()
  ext.startTurn()

  // 工具自动收集
  ext.recordReceipt({
    toolCallId: 'call-1',
    turnId: 'turn-1',
    toolName: 'read_file',
    args: { path: '/tmp/a.md' },
    success: true,
    startedAt: '2026-01-01T00:00:00.000Z',
    resultText: '对比文件 D1 公开了特征 X',
    write: false,
    path: '/tmp/a.md',
  })
  expect(ext.ledger.size()).toBe(1)

  // Receipt 提升为证据（sourceUri/contentHash 自动生成）
  const receipt = ext.ledger.list()[0]!
  const span = ext.spanFromReceipt(receipt, 'supporting', 'D1 公开了特征 X')
  expect(span.sourceUri).toBe('file:///tmp/a.md')
  expect(span.contentHash).toBeTruthy()
  expect(ext.getSpan(span.id)).toBe(span)

  // 绑定结论
  ext.bind('conclusion-1', span.id)
  expect(ext.unbackedClaims(['conclusion-1', 'conclusion-2'])).toEqual(['conclusion-2'])
  expect(ext.unbackedNotice(['conclusion-1', 'conclusion-2']) ?? '').toMatch(/conclusion-2/)
  expect(ext.unbackedNotice(['conclusion-1'])).toBeUndefined()

  // 冲突检测（加入矛盾证据）
  const contradicting = ext.spanFromReceipt(
    { ...receipt, toolCallId: 'call-2', resultText: 'D1 未公开特征 X' },
    'contradicting',
  )
  ext.bind('conclusion-1', contradicting.id)
  const conflicts = ext.detectConflicts(['conclusion-1'])
  expect(conflicts.some(c => c.type === 'claim' && c.subject === 'conclusion-1')).toBe(true)

  // startTurn 重置账本（跨 turn 不泄漏），证据/绑定保留
  ext.startTurn()
  expect(ext.ledger.size()).toBe(0)
  expect(ext.getSpan(span.id)?.id).toBe(span.id)
})

it('contentHash 为带前缀的 SHA-256，稳定且区分内容', () => {
  expect(contentHash('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(contentHash('abc')).toBe(contentHash('abc'))
  expect(contentHash('abc')).not.toBe(contentHash('abd'))
  expect(contentHash('x')).toMatch(/^sha256:[0-9a-f]{64}$/)
})
