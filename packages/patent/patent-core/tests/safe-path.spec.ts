import { describe, expect, it } from 'vitest'
import { assertDeliverableName, assertPathSegment } from '@deepseek-ai/dsh-patent-core'

/** 记录错误消息的构造器：断言文案的同时避免每处重复拼装。 */
const messages: string[] = []

function collect(message: string): Error {
  messages.push(message)
  return new Error(message)
}

describe('assertPathSegment', () => {
  it('accepts Latin, Cyrillic-free Chinese, and circled-numeral case ids', () => {
    for (const ok of ['CN2024-0001', '中文案卷', '①张三_无效案', 'a.b_c-d']) {
      expect(() => { assertPathSegment(ok, 'caseId', collect) }).not.toThrow()
    }
  })

  it('rejects blanks, separators, NUL, and space-or-dot endings', () => {
    for (const bad of ['', '   ', 'a/b', 'a\\b', 'a\0b', 'a ', ' a', 'a.', '.. ', '..']) {
      expect(() => { assertPathSegment(bad, 'caseId', collect) }).toThrow(/caseId .* 不可用/)
    }
  })

  it('names the offending value in the message', () => {
    messages.length = 0
    expect(() => { assertPathSegment('../escape', 'caseId', collect) }).toThrow('"../escape"')
    expect(messages[0]).toContain('单段路径名')
  })
})

describe('assertDeliverableName', () => {
  it('accepts Chinese, circled numerals, and common Chinese punctuation', () => {
    for (const ok of [
      '②件_权利要求书与说明书_内部稿',
      '02_权利要求书（草案）·v1',
      '检索报告——第一稿',
      'fig-01.png',
    ]) {
      expect(() => { assertDeliverableName(ok, '输出文件名', collect) }).not.toThrow()
    }
  })

  it('rejects characters outside the allowlist', () => {
    for (const bad of ['a b', 'a#b', 'a*b', 'a:b', 'a?b', 'a|b', 'a<b']) {
      expect(() => { assertDeliverableName(bad, '输出文件名', collect) }).toThrow(/输出文件名 .* 不可用/)
    }
  })

  it('rejects the path-segment defects too: separators, dot-dot, blank, dot ending', () => {
    for (const bad of ['a/b', 'a\\b', '..', 'a..b', '.', 'a.', '', '   ', 'a\0b']) {
      expect(() => { assertDeliverableName(bad, '输出文件名', collect) }).toThrow(/输出文件名 .* 不可用/)
    }
  })

  it('rejects names longer than 120 characters', () => {
    expect(() => { assertDeliverableName('a'.repeat(120), '输出文件名', collect) }).not.toThrow()
    expect(() => { assertDeliverableName('a'.repeat(121), '输出文件名', collect) }).toThrow(/输出文件名 .* 不可用/)
  })
})
