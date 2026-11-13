// 上游来源：Mady 项目 `domains/doctmpl/vars_test.go`（`TestVarSchema_Validate`、
// `TestVarSchema_ApplyDefaults`、`TestVarSchema_Names`、`TestExtractPlaceholders`、
// `TestValidatedResolve`）。`ValidatedResolve` 的残余占位符与警告口径与上游一致。

import { describe, expect, it } from 'vitest'
import type { DocTemplate, VarDefinition } from '../src/types.ts'
import { createVarSchema, extractPlaceholders, substitutePlaceholders, validatedResolve, VarSchema } from '../src/vars.ts'

/** Build one variable definition. */
function definition(name: string, extra: Partial<VarDefinition> = {}): VarDefinition {
  return { name, type: 'string', required: false, description: '', ...extra }
}

/** Build a template over a body and a variable schema. */
function templateOf(body: string, definitions: readonly VarDefinition[] = []): DocTemplate {
  return {
    name: 't',
    title: '',
    category: '',
    description: '',
    domain: '',
    version: '',
    language: '',
    styleName: '',
    useWhen: '',
    supportedFormats: ['markdown'],
    varSchema: createVarSchema(definitions),
    filePath: 't.md',
    body,
  }
}

describe('VarSchema', () => {
  const schema = createVarSchema([
    definition('a', { required: true }),
    definition('b'),
    definition('n', { type: 'number' }),
    definition('flag', { type: 'bool' }),
    definition('long', { type: 'multiline' }),
  ])

  it('reports every declared name and the required subset', () => {
    expect(schema.names()).toEqual(['a', 'b', 'n', 'flag', 'long'])
    expect(schema.requiredNames()).toEqual(['a'])
  })

  it('looks a definition up by name', () => {
    expect(schema.get('n')).toEqual(definition('n', { type: 'number' }))
    expect(schema.get('missing')).toBeUndefined()
  })

  it('keeps the last definition of a duplicated name', () => {
    const duplicated = createVarSchema([definition('a'), definition('a', { required: true })])
    expect(duplicated.names()).toEqual(['a', 'a'])
    expect(duplicated.get('a')?.required).toBe(true)
  })

  it('reports a missing required variable and skips its type check', () => {
    expect(schema.validate({})).toEqual([{ variable: 'a', code: 'missing_required', message: '必填变量未提供' }])
    expect(schema.validate({ a: '   ' })).toEqual([{ variable: 'a', code: 'missing_required', message: '必填变量未提供' }])
    expect(schema.validate({ a: 'x' })).toEqual([])
  })

  it('accepts a supplied number and bool in their declared forms', () => {
    expect(schema.validate({ a: 'x', n: ' 12.5 ', flag: 'TRUE' })).toEqual([])
    expect(schema.validate({ a: 'x', n: '1e3' })).toEqual([])
  })

  it('reports a value of the wrong type', () => {
    expect(schema.validate({ a: 'x', n: 'abc' })).toEqual([
      { variable: 'n', code: 'invalid_type', message: '期望 number 类型，实际值: "abc"' },
    ])
    expect(schema.validate({ a: 'x', flag: 'yes' })).toEqual([
      { variable: 'flag', code: 'invalid_type', message: '期望 bool 类型 (true/false)，实际值: "yes"' },
    ])
  })

  it('ignores the empty value of an optional variable', () => {
    expect(schema.validate({ a: 'x', n: '', flag: '' })).toEqual([])
  })

  it('applies the declared defaults without modifying the input', () => {
    const defaults = createVarSchema([definition('a', { default: 'A' }), definition('b'), definition('c', { default: '' })])
    const given = { b: 'B' }
    expect(defaults.applyDefaults(given)).toEqual({ b: 'B', a: 'A' })
    expect(given).toEqual({ b: 'B' })
    expect(defaults.applyDefaults({ a: 'given', b: 'B' })).toEqual({ a: 'given', b: 'B' })
  })

  it('reports no issue for an empty schema', () => {
    const empty = createVarSchema([])
    expect(empty.names()).toEqual([])
    expect(empty.validate({ anything: 'x' })).toEqual([])
    expect(empty.applyDefaults({ anything: 'x' })).toEqual({ anything: 'x' })
  })

  it('is constructible directly', () => {
    expect(new VarSchema([definition('a')]).names()).toEqual(['a'])
  })
})

describe('extractPlaceholders', () => {
  it('returns each distinct placeholder once, in first-occurrence order', () => {
    expect(extractPlaceholders('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
    expect(extractPlaceholders('no placeholders')).toEqual([])
  })

  it('reads a placeholder with no name characters as no placeholder', () => {
    expect(extractPlaceholders('{{}}')).toEqual([])
  })

  it('reports non-ASCII and hyphenated placeholders, which a variable can fill', () => {
    expect(extractPlaceholders('{{机构名称}}')).toEqual(['机构名称'])
    expect(extractPlaceholders('{{doc-no}}')).toEqual(['doc-no'])
  })

  it('reports the trimmed name, so the residual name is the variable to supply', () => {
    expect(extractPlaceholders('{{ not_a_placeholder }}')).toEqual(['not_a_placeholder'])
  })
})

describe('substitutePlaceholders', () => {
  it('replaces only the supplied placeholders', () => {
    expect(substitutePlaceholders('{{a}}/{{b}}', { a: '1' })).toBe('1/{{b}}')
    expect(substitutePlaceholders('{{a}}', { a: '' })).toBe('')
    expect(substitutePlaceholders('{{a}}', { b: '2' })).toBe('{{a}}')
  })

  it('does not expand a placeholder that a supplied value introduces', () => {
    expect(substitutePlaceholders('{{a}}', { a: '见 {{b}}', b: '秘密' })).toBe('见 {{b}}')
  })

  it('fills a CJK name and a padded name, which the quality gate blocks until filled', () => {
    // 门禁按共享的 {{…}} 形式判残余；替换若只认 \w，这两种就永远填不掉（能力死锁）。
    expect(substitutePlaceholders('{{客户名称}} 与 {{ case_id }}', { 客户名称: '示例公司', case_id: 'C-1' }))
      .toBe('示例公司 与 C-1')
  })
})

describe('validatedResolve', () => {
  const template = templateOf('# {{title}}\n\n{{body}}\n\n{{missing_required}}\n', [
    definition('title', { required: true }),
    definition('body', { required: true, default: '默认正文' }),
  ])

  it('reports the resolved body, the warnings, and the residual placeholders', () => {
    const result = validatedResolve(template, { title: '标题', body: '正文' })
    expect(result.output).toBe('# 标题\n\n正文\n\n{{missing_required}}\n')
    expect(result.warnings).toEqual([])
    expect(result.residual).toEqual(['missing_required'])
  })

  it('leaves no residual once a CJK and a padded placeholder are given values', () => {
    const result = validatedResolve(templateOf('{{客户名称}}\n\n{{ case_id }}\n', []), { 客户名称: '示例公司', case_id: 'C-1' })
    expect(result.residual).toEqual([])
  })

  it('warns about a required variable the call omitted even when the schema declares a default', () => {
    // Upstream validates before it applies defaults, so a required variable with a
    // default still warns while the resolved body carries that default.
    const result = validatedResolve(template, { title: '标题' })
    expect(result.warnings).toEqual([{ variable: 'body', code: 'missing_required', message: '必填变量未提供' }])
    expect(result.output).toContain('默认正文')
  })

  it('warns about a missing required variable and still resolves the body', () => {
    const result = validatedResolve(template, { body: '正文' })
    expect(result.warnings).toEqual([{ variable: 'title', code: 'missing_required', message: '必填变量未提供' }])
    expect(result.output).toContain('# {{title}}')
    expect(result.residual).toEqual(['title', 'missing_required'])
  })

  it('substitutes every supplied value into a body with no placeholder left', () => {
    const result = validatedResolve(templateOf('{{a}}{{a}}', [definition('a', { required: true })]), { a: 'x' })
    expect(result).toEqual({ output: 'xx', warnings: [], residual: [] })
  })
})
