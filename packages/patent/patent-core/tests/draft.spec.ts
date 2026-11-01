import { describe, expect, it } from 'vitest'
import {
  DraftValidationError,
  SPEC_PART_HEADINGS,
  formatTableCaption,
  validateSpecDraft,
  validateTemplateDraft,
  type SpecDraft,
  type TemplateDraftSchema,
} from '@deepseek-ai/dsh-patent-core'

/**
 * 一个可通过校验的最小 claims-spec 草案；用例用结构化克隆后局部覆写来制造违规。
 */
function validSpecDraft(): SpecDraft {
  return {
    meta: {
      caseNumber: 'CN2026-0001',
      title: '一种示例装置',
      applicant: '示例申请人',
      inventor: '示例发明人',
      agent: '示例代理机构',
      date: '2026-10-09',
    },
    claims: ['一种示例装置，其特征在于，包括示例部件。'],
    abstract: ['本发明公开一种示例装置。'],
    figureFiles: ['fig1.png', 'fig2.png'],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '本发明属于示例技术领域。' }],
      background: [{ kind: 'paragraph', text: '现有技术存在示例问题。' }],
      summary: [
        { kind: 'paragraph', text: '本发明提供一种示例装置。' },
        { kind: 'list', items: ['示例效果一', '示例效果二'] },
      ],
      drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图', '剖视示意图'] }],
      embodiment: [
        { kind: 'paragraph', text: '下面结合附图说明。' },
        {
          kind: 'table',
          name: '示例参数表',
          header: ['参数', '取值'],
          rows: [['长度', '10mm']],
        },
      ],
    },
  }
}

/** 浅合并顶层键；sections/meta 等复合键由用例整体替换。 */
function withSpecDraft(overrides: Record<string, unknown>): unknown {
  return { ...validSpecDraft(), ...overrides }
}

function expectSpecViolation(input: unknown, ...fragments: string[]): void {
  let caught: unknown
  try {
    validateSpecDraft(input)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DraftValidationError)
  const message = (caught as DraftValidationError).message
  for (const fragment of fragments) {
    expect(message).toContain(fragment)
  }
}

describe('SPEC_PART_HEADINGS', () => {
  it('固定五部分的中文标题', () => {
    expect(SPEC_PART_HEADINGS).toEqual({
      technicalField: '技术领域',
      background: '背景技术',
      summary: '发明内容',
      drawingDescriptions: '附图说明',
      embodiment: '具体实施方式',
    })
  })

  it('SPEC_PART_ORDER 与键序一致', async () => {
    const { SPEC_PART_ORDER } = await import('@deepseek-ai/dsh-patent-core')
    expect(SPEC_PART_ORDER).toEqual(['technicalField', 'background', 'summary', 'drawingDescriptions', 'embodiment'])
  })
})

describe('numberedFigureDescriptions', () => {
  it('跨列表块连续编号，末项标记 last', async () => {
    const { numberedFigureDescriptions } = await import('@deepseek-ai/dsh-patent-core')
    const result = numberedFigureDescriptions([
      { kind: 'paragraph', text: '本申请共三幅附图。' },
      { kind: 'list', items: ['整体结构示意图', '模块框图'] },
      { kind: 'list', items: ['剖视示意图'] },
    ])
    expect(result).toEqual([
      { index: 1, text: '整体结构示意图', last: false },
      { index: 2, text: '模块框图', last: false },
      { index: 3, text: '剖视示意图', last: true },
    ])
  })

  it('忽略非列表块且空列表部分返回空', async () => {
    const { numberedFigureDescriptions } = await import('@deepseek-ai/dsh-patent-core')
    expect(numberedFigureDescriptions([{ kind: 'paragraph', text: '无附图。' }])).toEqual([])
    expect(numberedFigureDescriptions([])).toEqual([])
  })
})

describe('validateSpecDraft', () => {
  it('接受最小完整草案并按原值返回', () => {
    const draft = validSpecDraft()
    expect(validateSpecDraft(draft)).toEqual(draft)
  })

  it('缺省 abstractFigure 时返回 undefined 字段', () => {
    const validated = validateSpecDraft(validSpecDraft())
    expect(validated.abstractFigure).toBeUndefined()
  })

  it('保留显式 abstractFigure', () => {
    const validated = validateSpecDraft({ ...validSpecDraft(), abstractFigure: '2' })
    expect(validated.abstractFigure).toBe('2')
  })

  it('拒绝非对象输入', () => {
    expectSpecViolation(null, '草案必须是对象')
    expectSpecViolation('draft', '草案必须是对象')
    expectSpecViolation(['draft'], '草案必须是对象')
  })

  it('拒绝未知顶层键并列出可用项', () => {
    expectSpecViolation(withSpecDraft({ extra: 1 }), 'extra', 'meta', 'claims', 'abstract', 'figureFiles', 'abstractFigure', 'sections')
  })

  it('meta 缺失时报缺失并列出可用项', () => {
    const { meta: _meta, ...rest } = validSpecDraft()
    expectSpecViolation(rest, 'meta 缺失', 'caseNumber', 'title', 'applicant', 'inventor', 'agent', 'date')
  })

  it('meta 为非对象时拒绝', () => {
    expectSpecViolation(withSpecDraft({ meta: '示例' }), 'meta 必须是对象')
  })

  it.each(['caseNumber', 'title', 'applicant', 'inventor', 'agent', 'date'] as const)('meta.%s 必填非空', (field) => {
    expectSpecViolation(withSpecDraft({ meta: { ...validSpecDraft().meta, [field]: '  ' } }), `meta.${field} 为空`)
    const { [field]: _dropped, ...restMeta } = validSpecDraft().meta
    expectSpecViolation(withSpecDraft({ meta: restMeta }), `meta.${field} 缺失`)
  })

  it('meta 未知键时拒绝并列出可用项', () => {
    expectSpecViolation(withSpecDraft({ meta: { ...validSpecDraft().meta, extra: 'x' } }), 'meta.extra', 'caseNumber、title、applicant、inventor、agent、date')
  })

  it('claims 缺失或为空数组时拒绝', () => {
    expectSpecViolation(withSpecDraft({ claims: undefined }), 'claims 缺失')
    expectSpecViolation(withSpecDraft({ claims: [] }), 'claims 至少一项')
  })

  it('claims 含空项或非字符串项时拒绝', () => {
    expectSpecViolation(withSpecDraft({ claims: [' '] }), 'claims[0] 为空')
    expectSpecViolation(withSpecDraft({ claims: [1] }), 'claims[0] 必须是字符串')
  })

  it('claims 为非数组时拒绝', () => {
    expectSpecViolation(withSpecDraft({ claims: '一种装置' }), 'claims 必须是数组')
  })

  it.each(['1. 一种装置', '3、 一种装置', '12．一种装置'])('claims 自带项号 %s 时拒绝', (claim) => {
    expectSpecViolation(withSpecDraft({ claims: [claim] }), 'claims[0] 自带项号')
  })

  it('claims 允许句内数字（非行首项号）', () => {
    const validated = validateSpecDraft(withSpecDraft({ claims: ['一种装置，包括 3 个部件。'] }))
    expect(validated.claims).toEqual(['一种装置，包括 3 个部件。'])
  })

  it('abstract 缺失、为空数组或含空段时拒绝', () => {
    expectSpecViolation(withSpecDraft({ abstract: undefined }), 'abstract 缺失')
    expectSpecViolation(withSpecDraft({ abstract: [] }), 'abstract 至少一段')
    expectSpecViolation(withSpecDraft({ abstract: ['ok', ' '] }), 'abstract[1] 为空')
  })

  it('abstractFigure 为空字符串时拒绝', () => {
    expectSpecViolation(withSpecDraft({ abstractFigure: '' }), 'abstractFigure 为空')
  })

  it('abstractFigure 超出附图项数或非十进制正整数时拒绝', () => {
    expectSpecViolation(withSpecDraft({ abstractFigure: '3' }), 'abstractFigure', '1..2')
    expectSpecViolation(withSpecDraft({ abstractFigure: '0' }), 'abstractFigure', '1..2')
    expectSpecViolation(withSpecDraft({ abstractFigure: '02' }), 'abstractFigure')
    expectSpecViolation(withSpecDraft({ abstractFigure: '2.0' }), 'abstractFigure')
    expectSpecViolation(withSpecDraft({ abstractFigure: '二' }), 'abstractFigure')
  })

  it('figureFiles 缺失、为空数组或含空项时拒绝', () => {
    expectSpecViolation(withSpecDraft({ figureFiles: undefined }), 'figureFiles 缺失')
    expectSpecViolation(withSpecDraft({ figureFiles: [] }), 'figureFiles 至少一项')
    expectSpecViolation(withSpecDraft({ figureFiles: [' '] }), 'figureFiles[0] 为空')
  })

  it('附图说明条目数与 figureFiles 项数不一致时拒绝', () => {
    const tooFew = { ...validSpecDraft().sections, drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }] }
    expectSpecViolation(
      withSpecDraft({ sections: tooFew }),
      '附图说明条目数与 figureFiles 项数不一致',
      '附图说明 1 条',
      'figureFiles 2 项',
    )
    const tooMany = {
      ...validSpecDraft().sections,
      drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图', '剖视示意图', '局部放大示意图'] }],
    }
    expectSpecViolation(withSpecDraft({ sections: tooMany }), '附图说明 3 条', 'figureFiles 2 项')
  })

  it('附图说明列表项自带图号或句末标点时拒绝', () => {
    const authored = {
      ...validSpecDraft().sections,
      drawingDescriptions: [{ kind: 'list', items: ['图1为本发明实施例的整体结构示意图；', '剖视示意图。'] }],
    }
    expectSpecViolation(
      withSpecDraft({ sections: authored }),
      'sections.drawingDescriptions[0].items[0] 自带图号和句末标点',
      '图号（「图N为」）与句末标点由渲染器生成',
    )
    expectSpecViolation(withSpecDraft({ sections: authored }), 'sections.drawingDescriptions[0].items[1] 自带句末标点')
  })

  it('附图说明列表项只带图号时拒绝', () => {
    const sections = {
      ...validSpecDraft().sections,
      drawingDescriptions: [{ kind: 'list', items: ['图 1 整体结构示意图', '剖视示意图'] }],
    }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.drawingDescriptions[0].items[0] 自带图号')
  })

  it('附图说明的段落块可以携带图号', () => {
    const sections = {
      ...validSpecDraft().sections,
      drawingDescriptions: [
        { kind: 'paragraph', text: '图1为整体结构示意图。' },
        { kind: 'list', items: ['整体结构示意图', '剖视示意图'] },
      ],
    }
    expect(() => validateSpecDraft(withSpecDraft({ sections }))).not.toThrow()
  })

  it('附图说明的段落与表格块不计入附图条目', () => {
    const sections = {
      ...validSpecDraft().sections,
      drawingDescriptions: [
        { kind: 'paragraph', text: '本申请共两幅附图。' },
        { kind: 'list', items: ['整体结构示意图', '剖视示意图'] },
      ],
    }
    const validated = validateSpecDraft(withSpecDraft({ sections }))
    expect(validated.sections.drawingDescriptions).toHaveLength(2)
  })

  it('sections 缺失、为非对象或为空对象时拒绝', () => {
    expectSpecViolation(withSpecDraft({ sections: undefined }), 'sections 缺失')
    expectSpecViolation(withSpecDraft({ sections: [] }), 'sections 必须是对象')
    expectSpecViolation(withSpecDraft({ sections: {} }), 'sections.technicalField 缺失', 'sections.embodiment 缺失')
  })

  it('某部分块为非数组时拒绝', () => {
    const sections = { ...validSpecDraft().sections, background: 'x' }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.background 必须是数组')
  })

  it('sections 含未知章节时拒绝并列出可用项', () => {
    const sections = { ...validSpecDraft().sections, other: [{ kind: 'paragraph', text: 'x' }] }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.other', 'technicalField', 'embodiment')
  })

  it('sections 缺某部分时拒绝并指出中文标题', () => {
    const { background: _bg, ...sections } = validSpecDraft().sections
    expectSpecViolation(withSpecDraft({ sections }), 'background', '背景技术')
  })

  it('各部分至少一个块', () => {
    expectSpecViolation(withSpecDraft({ sections: { ...validSpecDraft().sections, summary: [] } }), 'sections.summary 至少一个块')
  })

  it('未知块类型时拒绝并列出可用项', () => {
    const sections = {
      ...validSpecDraft().sections,
      background: [{ kind: 'heading', text: 'x' }],
    }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.background[0]', 'paragraph', 'list', 'table')
  })

  it('块为非对象时拒绝', () => {
    const sections = { ...validSpecDraft().sections, background: ['x'] }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.background[0] 必须是对象')
  })

  it('paragraph 文本为空或缺失时拒绝', () => {
    const sections = { ...validSpecDraft().sections, background: [{ kind: 'paragraph' }] }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.background[0].text 缺失')
    const emptySections = { ...validSpecDraft().sections, background: [{ kind: 'paragraph', text: ' ' }] }
    expectSpecViolation(withSpecDraft({ sections: emptySections }), 'sections.background[0].text 为空')
  })

  it('paragraph 拒绝未知键', () => {
    const sections = { ...validSpecDraft().sections, background: [{ kind: 'paragraph', text: 'x', extra: 1 }] }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.background[0].extra')
  })

  it('list 缺 items、空 items 或含空项时拒绝', () => {
    const base = validSpecDraft().sections
    expectSpecViolation(withSpecDraft({ sections: { ...base, background: [{ kind: 'list' }] } }), 'sections.background[0].items 缺失')
    expectSpecViolation(withSpecDraft({ sections: { ...base, background: [{ kind: 'list', items: [] }] } }), 'sections.background[0].items 至少一项')
    expectSpecViolation(withSpecDraft({ sections: { ...base, background: [{ kind: 'list', items: ['ok', ' '] }] } }), 'sections.background[0].items[1] 为空')
  })

  it('list 接受 ordered 标记并拒绝未知键与非布尔 ordered', () => {
    const validated = validateSpecDraft(withSpecDraft({
      sections: { ...validSpecDraft().sections, background: [{ kind: 'list', items: ['一'], ordered: true }] },
    }))
    expect(validated.sections.background[0]).toEqual({ kind: 'list', items: ['一'], ordered: true })
    const base = validSpecDraft().sections
    const extraSections = { ...base, background: [{ kind: 'list', items: ['一'], ordered: true, extra: 1 }] }
    expectSpecViolation(withSpecDraft({ sections: extraSections }), 'sections.background[0].extra')
    const badOrdered = { ...base, background: [{ kind: 'list', items: ['一'], ordered: 'yes' }] }
    expectSpecViolation(withSpecDraft({ sections: badOrdered }), 'sections.background[0].ordered 必须是布尔值')
  })

  it('table 名称缺失、为空或以「表+数字」开头时拒绝', () => {
    const base = validSpecDraft().sections
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', header: ['a'], rows: [['b']] }] } }), 'sections.embodiment[0].name 缺失')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: ' ', header: ['a'], rows: [['b']] }] } }), 'name 为空')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: '表1 参数', header: ['a'], rows: [['b']] }] } }), '不得以「表+数字」开头')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: '表 2 · 参数', header: ['a'], rows: [['b']] }] } }), '不得以「表+数字」开头')
  })

  it('table 表头为空或数据行为空时拒绝', () => {
    const base = validSpecDraft().sections
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: '参数', header: [], rows: [['b']] }] } }), 'header 至少一列')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: '参数', header: ['a'], rows: [] }] } }), 'rows 至少一行')
  })

  it('table rows 缺失、为非数组或行非数组时拒绝', () => {
    const base = validSpecDraft().sections
    const block = { kind: 'table', name: '参数', header: ['a'] }
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [block] } }), 'rows 缺失')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ ...block, rows: 'x' }] } }), 'rows 必须是数组')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ ...block, rows: ['x'] }] } }), 'rows[0] 必须是数组')
  })

  it('table 行宽与表头不一致或含空单元格时拒绝', () => {
    const base = validSpecDraft().sections
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: '参数', header: ['a', 'b'], rows: [['x']] }] } }), '行宽')
    expectSpecViolation(withSpecDraft({ sections: { ...base, embodiment: [{ kind: 'table', name: '参数', header: ['a'], rows: [[' ']] }] } }), 'rows[0][0] 为空')
  })

  it('table 拒绝未知键', () => {
    const sections = {
      ...validSpecDraft().sections,
      embodiment: [{ kind: 'table', name: '参数', header: ['a'], rows: [['b']], extra: 1 }],
    }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.embodiment[0].extra')
  })

  it('表格仅允许出现在具体实施方式', () => {
    const sections = {
      ...validSpecDraft().sections,
      summary: [{ kind: 'table', name: '参数', header: ['a'], rows: [['b']] }],
    }
    expectSpecViolation(withSpecDraft({ sections }), 'sections.summary', 'embodiment')
  })

  it('聚合多项违规并给出总数', () => {
    let caught: unknown
    try {
      validateSpecDraft({ meta: {}, claims: [] })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DraftValidationError)
    const err = caught as DraftValidationError
    expect(err.violations.length).toBeGreaterThanOrEqual(3)
    expect(err.message).toContain(`${err.violations.length} 项`)
  })
})

describe('validateTemplateDraft', () => {
  it('接受仅含 sections 的草案', () => {
    const draft = { sections: [{ id: 'analysis', blocks: [{ kind: 'paragraph', text: '示例分析。' }] }] }
    expect(validateTemplateDraft(draft)).toEqual(draft)
  })

  it('接受 fields 并拒绝空值与非字符串值', () => {
    const validated = validateTemplateDraft({ fields: { client: '示例客户' }, sections: [] })
    expect(validated.fields).toEqual({ client: '示例客户' })
    expectTemplateViolation({ fields: { client: ' ' }, sections: [] }, 'fields.client 为空')
    expectTemplateViolation({ fields: { client: 1 }, sections: [] }, 'fields.client 必须是字符串')
    expectTemplateViolation({ fields: 'client', sections: [] }, 'fields 必须是对象')
  })

  it('sections 缺失、为非数组或条目缺 id/blocks 时拒绝', () => {
    expectTemplateViolation({ sections: undefined }, 'sections 缺失')
    expectTemplateViolation({ sections: {} }, 'sections 必须是数组')
    expectTemplateViolation({ sections: ['x'] }, 'sections[0] 必须是对象')
    expectTemplateViolation({ sections: [{ blocks: [{ kind: 'paragraph', text: 'x' }] }] }, 'sections[0].id 缺失')
    expectTemplateViolation({ sections: [{ id: 'analysis' }] }, 'sections[0].blocks 缺失')
    expectTemplateViolation({ sections: [{ id: 'analysis', blocks: 'x' }] }, 'sections[0].blocks 必须是数组')
  })

  it('拒绝未知顶层键并列出可用项', () => {
    expectTemplateViolation({ extra: 1, sections: [] }, 'extra', 'fields', 'sections')
  })

  it('重复槽位 id 时拒绝并列出可用项', () => {
    const draft = {
      sections: [
        { id: 'analysis', blocks: [{ kind: 'paragraph', text: '一' }] },
        { id: 'analysis', blocks: [{ kind: 'paragraph', text: '二' }] },
      ],
    }
    expectTemplateViolation(draft, '重复槽位', 'analysis')
  })

  it('按 schema 拒绝未知字段并列出可用项', () => {
    const schema = { fields: { client: { required: true } }, sections: { analysis: { required: true } } }
    const draft = { fields: { other: 'x' }, sections: [{ id: 'analysis', blocks: [{ kind: 'paragraph', text: 'x' }] }] }
    expectTemplateViolation(draft, schema, 'fields.other', 'client')
  })

  it('按 schema 拒绝未知章节并列出可用项', () => {
    const schema = { sections: { analysis: { required: true } } }
    expectTemplateViolation({ sections: [{ id: 'other', blocks: [{ kind: 'paragraph', text: 'x' }] }] }, schema, 'sections.other', 'analysis')
  })

  it('按 schema 校验必填字段与必填章节', () => {
    const schema = { fields: { client: { required: true } }, sections: { analysis: { required: true } } }
    expectTemplateViolation({ sections: [{ id: 'analysis', blocks: [{ kind: 'paragraph', text: 'x' }] }] }, schema, 'fields.client 缺失')
    expectTemplateViolation({ fields: { client: 'x' }, sections: [] }, schema, 'sections.analysis 缺失')
  })

  it('按 schema 允许省略可选槽位', () => {
    const schema = { fields: { client: { required: false } }, sections: { analysis: { required: false } } }
    expect(validateTemplateDraft({ sections: [] }, schema)).toEqual({ sections: [] })
  })

  it('拒绝非对象输入并列出可用项', () => {
    let caught: unknown
    try {
      validateTemplateDraft(null)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DraftValidationError)
    expect((caught as DraftValidationError).message).toContain('fields')
    expect((caught as DraftValidationError).message).toContain('sections')
  })

  it('schema 只声明章节槽位时拒绝任何字段并给出空可用项', () => {
    const schema = { sections: { analysis: { required: true } } }
    const draft = { fields: { client: 'x' }, sections: [{ id: 'analysis', blocks: [{ kind: 'paragraph', text: 'x' }] }] }
    expectTemplateViolation(draft, schema, 'fields.client 未知槽位（可用项：）')
  })

  it('schema 中未声明的槽位不出现在可用项提示中', () => {
    const schema = { sections: { analysis: { required: true }, conclusion: { required: true } } }
    expectTemplateViolation({ sections: [] }, schema, 'analysis', 'conclusion')
  })

  it('choice 槽位按可选项校验单选值，未知选项列出可选项', () => {
    const schema = {
      fields: {
        evalTarget: {
          required: true,
          kind: 'choice' as const,
          options: [
            { id: 'granted', label: '与授权公告一并公布的专利文件' },
            { id: 'maintained', label: '由无效宣告请求审查决定维持有效的专利文件' },
          ],
        },
      },
    }
    const draft = { fields: { evalTarget: 'granted' }, sections: [] }
    expect(validateTemplateDraft(draft, schema).fields).toEqual({ evalTarget: 'granted' })
    expectTemplateViolation({ fields: { evalTarget: 'unknown' }, sections: [] }, schema, '未知选项 "unknown"', 'granted（与授权公告一并公布的专利文件）')
    expectTemplateViolation({ fields: { evalTarget: 1 }, sections: [] }, schema, 'fields.evalTarget[0] 必须是字符串')
    expectTemplateViolation({ sections: [] }, schema, 'fields.evalTarget 缺失')
  })

  it('choice 槽位多选接受数组、单选拒绝数组', () => {
    const multiple = { fields: { scope: { kind: 'choice' as const, multiple: true, options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }] } } }
    const draft = { fields: { scope: ['a', 'b'] }, sections: [] }
    expect(validateTemplateDraft(draft, multiple).fields).toEqual({ scope: ['a', 'b'] })
    // 多选槽位也接受单字符串（视同单项）。
    expect(validateTemplateDraft({ fields: { scope: 'a' }, sections: [] }, multiple).fields).toEqual({ scope: ['a'] })
    const single = { fields: { scope: { kind: 'choice' as const, options: [{ id: 'a', label: '甲' }] } } }
    expectTemplateViolation({ fields: { scope: ['a'] }, sections: [] }, single, '单选槽位', '不接受数组')
    expectTemplateViolation({ fields: { scope: [] }, sections: [] }, multiple, '至少选择一项')
    const noOptions = { fields: { scope: { kind: 'choice' as const } } }
    expectTemplateViolation({ fields: { scope: ['a'] }, sections: [] }, noOptions, '单选槽位', '未声明')
  })

  it('rows 槽位校验列数与非空单元格', () => {
    const schema = { sections: { relatedDocuments: { required: true, kind: 'rows' as const, columns: 2 } } }
    const draft = { sections: [{ id: 'relatedDocuments', rows: [['X', 'CN101234567A'], ['Y', 'CN2345678B']] }] }
    expect(validateTemplateDraft(draft, schema).sections).toEqual(draft.sections)
    expectTemplateViolation({ sections: [{ id: 'relatedDocuments', rows: [['X']] }] }, schema, '列数 1 与模板列数 2 不一致')
    expectTemplateViolation({ sections: [{ id: 'relatedDocuments', rows: [['X', 'A'], ['Y']] }] }, schema, '列数 1 与首行列数 2 不一致')
    expectTemplateViolation({ sections: [{ id: 'relatedDocuments', rows: [] }] }, schema, '至少一行')
    expectTemplateViolation({ sections: [{ id: 'relatedDocuments', rows: [['X', '']] }] }, schema, 'sections.0.rows[0][1] 为空')
    expectTemplateViolation({ sections: [{ id: 'relatedDocuments', blocks: [{ kind: 'paragraph', text: 'x' }] }] }, schema, '数据行槽位，不接受 blocks')
    expectTemplateViolation(
      { sections: [{ id: 'relatedDocuments', rows: [['X', 'A']], grounds: [] }] },
      schema,
      '数据行槽位，不接受 grounds',
    )
  })

  it('正文槽位拒绝 rows 与表格块', () => {
    const schema = { sections: { analysis: { required: true } } }
    expectTemplateViolation({ sections: [{ id: 'analysis', rows: [['X']] }] }, schema, '正文槽位，不接受 rows')
    expectTemplateViolation(
      { sections: [{ id: 'analysis', blocks: [{ kind: 'paragraph', text: 'x' }], grounds: [] }] },
      schema,
      '正文槽位，不接受 grounds',
    )
    const tableBlock = { sections: [{ id: 'analysis', blocks: [{ kind: 'table', name: 't', header: ['h'], rows: [['c']] }] }] }
    expectTemplateViolation(tableBlock, schema, '表格块仅 claims-spec 支持')
  })

  it('grounds 槽位校验法条、理由名、权项号与三段正文', () => {
    const schema = { sections: { 'grounds-body': { required: true, kind: 'grounds' as const, groundsPrefix: '4' } } }
    const item = {
      article: '专利法第22条第3款',
      ground: '创造性',
      claimNos: [1, 2],
      facts: '事实。',
      evidence: '证据。',
      conclusion: '结论。',
    }
    expect(validateTemplateDraft({ sections: [{ id: 'grounds-body', grounds: [item] }] }, schema).sections)
      .toEqual([{ id: 'grounds-body', grounds: [item] }])

    // 权项号去重升序：重复与乱序写法归一为同一份已校验值。
    const shuffled = { ...item, claimNos: [2, 1, 2] }
    expect(validateTemplateDraft({ sections: [{ id: 'grounds-body', grounds: [shuffled] }] }, schema).sections)
      .toEqual([{ id: 'grounds-body', grounds: [item] }])

    const base = { sections: [{ id: 'grounds-body', grounds: [item] }] }
    expectTemplateViolation({ ...base, sections: [{ id: 'grounds-body', grounds: [] }] }, schema, '至少一项')
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', grounds: [{ ...item, article: '' }] }] },
      schema,
      'article 为空',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', grounds: [{ ...item, claimNos: [0] }] }] },
      schema,
      '必须是 ≥1 的整数',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', grounds: [{ ...item, claimNos: [] }] }] },
      schema,
      '至少一个权利要求序号',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', grounds: [{ ...item, claimNos: undefined }] }] },
      schema,
      'claimNos 缺失',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', grounds: [{ ...item, facts: '  ' }] }] },
      schema,
      'facts 为空',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', blocks: [{ kind: 'paragraph', text: 'x' }] }] },
      schema,
      '无效理由槽位，不接受 blocks / rows',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', rows: [['X']] }] },
      schema,
      '无效理由槽位，不接受 blocks / rows',
    )
    expectTemplateViolation(
      { sections: [{ id: 'grounds-body', grounds: ['not-an-object'] }] },
      schema,
      '必须是对象',
    )
  })
})

describe('formatTableCaption', () => {
  it('renders the table number and name', () => {
    expect(formatTableCaption(2, '实验数据')).toBe('表 2 · 实验数据')
  })
})

function expectTemplateViolation(input: unknown, ...fragments: string[]): void
function expectTemplateViolation(input: unknown, schema: TemplateDraftSchema, ...fragments: string[]): void
function expectTemplateViolation(input: unknown, schemaOrFragment: TemplateDraftSchema | string, ...rest: string[]): void {
  const fragments = typeof schemaOrFragment === 'string' ? [schemaOrFragment, ...rest] : rest
  const schema = typeof schemaOrFragment === 'string' ? undefined : schemaOrFragment
  let caught: unknown
  try {
    validateTemplateDraft(input, schema)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DraftValidationError)
  const message = (caught as DraftValidationError).message
  for (const fragment of fragments) {
    expect(message).toContain(fragment)
  }
}
