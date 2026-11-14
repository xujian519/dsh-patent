import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { verifyCitation, loadLawBaselines } from '@deepseek-ai/dsh-patent-law'

import {
  checkAlignmentDocument,
  checkRuleProcedureAlignment,
  loadAlignmentDocument,
} from './verify-patent-rule-alignment.ts'

const ROOT = join(import.meta.dirname, '..')

describe('rule and procedure alignment', () => {
  it('accepts the shipped alignment', () => {
    expect(checkRuleProcedureAlignment()).toEqual([])
  })

  it('细则第41条是撤回专利申请，不是复审请求', () => {
    const baselines = loadLawBaselines()
    const withdrawal = verifyCitation(
      { kind: 'law-article', law: '专利法实施细则', article: 41, paragraph: 1, raw: '专利法实施细则第41条第1款' },
      baselines,
      { proposition: '申请人撤回专利申请的' },
    )
    const reexamination = verifyCitation(
      { kind: 'law-article', law: '专利法实施细则', article: 41, paragraph: 1, raw: '专利法实施细则第41条第1款' },
      baselines,
      { proposition: '可以自收到通知之日起三个月内向国务院专利行政部门请求复审' },
    )
    expect(withdrawal.decision).toBe('valid')
    expect(reexamination.decision).not.toBe('valid')
  })

  it('细则第7条是保密专利，期限引擎不把它当作期限', () => {
    const baselines = loadLawBaselines()
    const secrecy = verifyCitation(
      { kind: 'law-article', law: '专利法实施细则', article: 7, paragraph: 1, raw: '专利法实施细则第7条第1款' },
      baselines,
      { proposition: '涉及国防利益需要保密的，由国防专利机构受理并进行审查' },
    )
    expect(secrecy.decision).toBe('valid')
    const deadline = join(ROOT, 'packages/patent/patent-deadline/src')
    const hits = walk(deadline).filter(text => text.includes('实施细则第7条') || text.includes('细则第七条'))
    expect(hits).toEqual([])
  })

  it('细则第4条第1款和第2款的递交日由调用方给出', () => {
    const delivery = readFileSync(join(ROOT, 'packages/patent/patent-deadline/src/delivery.ts'), 'utf8')
    expect(delivery).toContain('细则第4条第1款、第2款的递交日不在本引擎推算')
    expect(delivery).toContain('第3款的送达对象（代理机构或联系人）不产生日期')
  })

  it('rejects a computation quote the cited paragraph does not contain', () => {
    const document = loadAlignmentDocument()
    const row = computation(document, 'postal-presumed-receipt')
    row['provision'] = { law: '专利法实施细则', article: 4, paragraph: 4, quote: '满三十日' }
    expect(checkAlignmentDocument(document).join('\n')).toMatch(/postal-presumed-receipt/)
  })

  it('rejects an inventory that drops a shipped template', () => {
    const document = loadAlignmentDocument()
    if (!isRecord(document) || !Array.isArray(document['templates'])) throw new Error('templates')
    document['templates'].pop()
    expect(checkAlignmentDocument(document).join('\n')).toMatch(/没有条文清单/)
  })
})

/**
 * @param document - the inventory document.
 * @param id - the computation id.
 * @returns the computation record.
 */
function computation(document: unknown, id: string): Record<string, unknown> {
  if (!isRecord(document) || !Array.isArray(document['computations'])) throw new Error('computations')
  for (const entry of document['computations']) {
    if (isRecord(entry) && entry['id'] === id) return entry
  }
  throw new Error(`missing computation ${id}`)
}

/**
 * @param value - a YAML value.
 * @returns whether the value is a string-keyed record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * @param dir - a source directory.
 * @returns the text of each TypeScript file under it.
 */
function walk(dir: string): string[] {
  const texts: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) texts.push(...walk(path))
    else if (entry.endsWith('.ts')) texts.push(readFileSync(path, 'utf8'))
  }
  return texts
}
