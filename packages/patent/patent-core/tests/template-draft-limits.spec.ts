/**
 * 槽位配额（P0-04）：超限在校验阶段失败，而不是渲染成成品。
 *
 * 三条纪律在此钉住：字符口径是「去掉空白后的码点」（差一个空格不该算超限）；
 * 边界值（正好等于上限）必须通过——配额是筛失控草案的网，不是紧箍咒；
 * 违规文案必须同时给出槽位、实测值、上限与需删减量，否则模型只能靠猜。
 */
import { describe, expect, it } from 'vitest'
import { validateTemplateDraft, type TemplateDraftSchema } from '@deepseek-ai/dsh-patent-core'
import { DraftValidationError } from '../src/draft/validate.ts'

/** 单槽位 schema：正文槽，字符与条目双限。 */
const BLOCKS_SCHEMA: TemplateDraftSchema = {
  sections: { body: { required: true, maxChars: 10, maxItems: 2 } },
}

/** 单槽位 schema：数据行槽，行数上限。 */
const ROWS_SCHEMA: TemplateDraftSchema = {
  sections: { table: { kind: 'rows', columns: 2, required: true, maxRows: 2 } },
}

/** 取草案校验失败的违规列表；未抛出时让用例失败。 */
function violationsOf(input: unknown, schema: TemplateDraftSchema): string[] {
  try {
    validateTemplateDraft(input, schema)
  } catch (error) {
    expect(error).toBeInstanceOf(DraftValidationError)
    return (error as DraftValidationError).violations
  }
  throw new Error('草案未被拒绝')
}

describe('blocks 槽位配额', () => {
  it('正好等于字符上限时通过（空白不计入可见字符）', () => {
    const draft = {
      sections: [{ id: 'body', blocks: [{ kind: 'paragraph', text: '一二三四五 六七八九十' }] }],
    }
    expect(validateTemplateDraft(draft, BLOCKS_SCHEMA).sections).toEqual(draft.sections)
  })

  it('超出字符上限时拒绝，并给出实测值、上限与需删减量', () => {
    const draft = {
      sections: [{ id: 'body', blocks: [{ kind: 'paragraph', text: '一二三四五六七八九十十一' }] }],
    }
    const violations = violationsOf(draft, BLOCKS_SCHEMA)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('sections.body')
    expect(violations[0]).toContain('正文 12 字')
    expect(violations[0]).toContain('上限 10 字')
    expect(violations[0]).toContain('删减 2 字以上')
  })

  it('字符数跨块累加（段落 + 列表项）', () => {
    const draft = {
      sections: [{
        id: 'body',
        blocks: [
          { kind: 'paragraph', text: '一二三' },
          { kind: 'list', items: ['四五六七八', '九十十一十二'] },
        ],
      }],
    }
    expect(violationsOf(draft, BLOCKS_SCHEMA)[0]).toContain('正文 14 字')
  })

  it('列表项超出上限时拒绝，并给出需合并或删除的项数', () => {
    const draft = {
      sections: [{ id: 'body', blocks: [{ kind: 'list', items: ['甲', '乙', '丙'] }] }],
    }
    const violations = violationsOf(draft, BLOCKS_SCHEMA)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('列表 3 项')
    expect(violations[0]).toContain('上限 2 项')
    expect(violations[0]).toContain('合并或删除 1 项以上')
  })

  it('字符与条目同时超限时两条违规都报', () => {
    const draft = {
      sections: [{
        id: 'body',
        blocks: [{ kind: 'list', items: ['一二三四五', '六七八九十', '十一'] }],
      }],
    }
    const violations = violationsOf(draft, BLOCKS_SCHEMA)
    expect(violations).toHaveLength(2)
    expect(violations.some(violation => violation.includes('正文 12 字'))).toBe(true)
    expect(violations.some(violation => violation.includes('列表 3 项'))).toBe(true)
  })
})

describe('rows 槽位配额', () => {
  it('正好等于行数上限时通过', () => {
    const draft = { sections: [{ id: 'table', rows: [['甲', '乙'], ['丙', '丁']] }] }
    expect(validateTemplateDraft(draft, ROWS_SCHEMA).sections).toEqual(draft.sections)
  })

  it('超出上限时拒绝，并给出实测行数、上限与需删减行数', () => {
    const draft = {
      sections: [{ id: 'table', rows: [['甲', '乙'], ['丙', '丁'], ['戊', '己']] }],
    }
    const violations = violationsOf(draft, ROWS_SCHEMA)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('sections.table 数据行 3 行')
    expect(violations[0]).toContain('上限 2 行')
    expect(violations[0]).toContain('合并或删除 1 行以上')
  })
})

describe('未声明配额的槽位', () => {
  it('长正文照旧通过（其他模板零改动）', () => {
    const schema: TemplateDraftSchema = { sections: { body: { required: true } } }
    const draft = {
      sections: [{ id: 'body', blocks: [{ kind: 'paragraph', text: '字'.repeat(5000) }] }],
    }
    expect(validateTemplateDraft(draft, schema).sections).toEqual(draft.sections)
  })

  it('不提供 schema 时没有配额可言', () => {
    const draft = { sections: [{ id: 'body', blocks: [{ kind: 'paragraph', text: '字'.repeat(5000) }] }] }
    expect(validateTemplateDraft(draft).sections).toEqual(draft.sections)
  })
})
