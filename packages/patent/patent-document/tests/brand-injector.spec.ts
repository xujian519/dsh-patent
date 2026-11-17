import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBrandStyle, loadBrandFromPath, mergeBrand } from '@deepseek-ai/dsh-patent-document'

describe('brandInjector', () => {
  it('builds CSS with quoted prose and unquoted colors', () => {
    const css = buildBrandStyle({ firm: 'Test Firm', accent: '#123456' })
    expect(css).toMatch(/--sati-doc-firm: "Test Firm";/)
    expect(css).toMatch(/--sati-doc-accent: #123456;/)
    expect(css).toContain(':root {')
    expect(css.trim().endsWith('}')).toBe(true)
  })

  it('merges explicit brand over config brand', () => {
    const brand = mergeBrand({ firm: 'Explicit' }, { firm: 'Config', accent: '#000' })
    expect(brand.firm).toBe('Explicit')
    expect(brand.accent).toBe('#000')
  })

  it('escapes destructive characters and quotes', () => {
    const css = buildBrandStyle({ accent: '#123; } body { display:none', firm: 'A"B' })
    expect((css.match(/\{/g) ?? []).length).toBe(1)
    expect((css.match(/\}/g) ?? []).length).toBe(1)
    expect(css).not.toMatch(/\{ body|\} body/)
    expect(css).toMatch(/--sati-doc-firm: "A\\"B";/)
  })

  it('escapes style-closing tags so a brand value cannot inject HTML', () => {
    const payload = 'x</style><script>alert(1)</script>'
    const quoted = buildBrandStyle({ firm: payload })
    expect(quoted).not.toContain('</style')
    expect(quoted).not.toContain('<script')
    expect(quoted).toContain('\\3C ')

    const unquoted = buildBrandStyle({ accent: payload })
    expect(unquoted).not.toContain('</style')
    expect(unquoted).not.toContain('<script')
    expect(unquoted).toContain('\\3C ')
  })

  it('skips unknown keys and blank values', () => {
    const css = buildBrandStyle({ notAKey: 'x', firm: '   ' })
    expect(css).not.toContain('notAKey')
    expect(css).not.toContain('--sati-doc-firm:')
  })

  it('loads documents.patent brand from a theme.json path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-brand-'))
    try {
      const path = join(dir, 'theme.json')
      writeFileSync(path, JSON.stringify({ documents: { patent: { firm: '事务所', accent: '#112233' } } }))
      expect(loadBrandFromPath(path)).toEqual({ firm: '事务所', accent: '#112233' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty brand only when no path is configured', () => {
    expect(loadBrandFromPath(undefined)).toEqual({})
  })

  it('fails loud for a missing file, corrupt JSON, and a malformed namespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-brand-'))
    try {
      expect(() => loadBrandFromPath(join(dir, 'missing.json'))).toThrow(/品牌配置不可读/)

      const corrupt = join(dir, 'corrupt.json')
      writeFileSync(corrupt, '{not json')
      expect(() => loadBrandFromPath(corrupt)).toThrow(/品牌配置不是合法 JSON/)

      const list = join(dir, 'list.json')
      writeFileSync(list, JSON.stringify([]))
      expect(() => loadBrandFromPath(list)).toThrow(/品牌配置顶层必须是对象/)

      const notObject = join(dir, 'not-object.json')
      writeFileSync(notObject, JSON.stringify({ documents: { patent: ['x'] } }))
      expect(() => loadBrandFromPath(notObject)).toThrow(/documents.patent 必须是对象/)

      const notString = join(dir, 'not-string.json')
      writeFileSync(notString, JSON.stringify({ documents: { patent: { firm: 1 } } }))
      expect(() => loadBrandFromPath(notString)).toThrow(/documents.patent.firm 必须是字符串/)

      const noPatent = join(dir, 'no-patent.json')
      writeFileSync(noPatent, JSON.stringify({ documents: { other: { firm: 'x' } } }))
      expect(loadBrandFromPath(noPatent)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('merges an explicit brand with no config source', () => {
    expect(mergeBrand({ firm: 'Explicit' })).toEqual({ firm: 'Explicit' })
  })
})
