import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateJsonSchemaValue, type JsonSchemaNode } from '@deepseek-ai/dsh-tools'
import { validateSpecDraft, validateTemplateDraft } from '@deepseek-ai/dsh-patent-core'
import { createRenderPatentDocumentTool, renderDocumentResult } from '@deepseek-ai/dsh-patent-document'
import { fakeSubprocess, successHandle } from './helpers.ts'

describe('render_patent_document tool', () => {
  /** patentability-opinion 的最小合规草案：只填注册表声明的必填槽位。 */
  function opinionDraft(title = '标题'): Record<string, unknown> {
    return {
      fields: {
        'meta-client': '委托方',
        'meta-title': title,
        'meta-case': '案卷号',
        'meta-basis': '分析依据',
        'meta-date': '2026-10-09',
        'sum-title': '结论摘要',
        'sum-conclusion': '结论正文。',
        'footer-case': 'PA-2026-0031 · 机密',
        'footer-date': '2026 年 10 月 09 日',
      },
      sections: [
        { id: 'doc-number', blocks: [{ kind: 'paragraph', text: '文档编号：PA-2026-0031 · 版本 V1.0' }] },
        { id: 'basis-body', blocks: [{ kind: 'paragraph', text: '要件结论。' }] },
        { id: 'claim-decomposition-body', blocks: [{ kind: 'paragraph', text: '特征分解。' }] },
        { id: 'feature-comparison-body', blocks: [{ kind: 'paragraph', text: '比对结论。' }] },
        { id: 'inventiveness-step-1', blocks: [{ kind: 'paragraph', text: '最接近的现有技术。' }] },
        { id: 'inventiveness-step-2', blocks: [{ kind: 'paragraph', text: '区别特征与实际解决的技术问题。' }] },
        { id: 'inventiveness-step-3', blocks: [{ kind: 'paragraph', text: '技术启示分析。' }] },
        { id: 'other-requirements-body', blocks: [{ kind: 'paragraph', text: '其他要件。' }] },
        { id: 'evidence-body', blocks: [{ kind: 'paragraph', text: '证据清单。' }] },
        { id: 'citation-log-body', blocks: [{ kind: 'paragraph', text: '引用日志。' }] },
      ],
    }
  }

  it('declares the defineTool shape', () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })

    expect(tool.name).toBe('render_patent_document')
    expect(typeof tool.description).toBe('string')
    expect(tool.description.length).toBeGreaterThan(0)
    const parameters = tool.parameters as { properties?: Record<string, unknown>; required?: string[] }
    expect(parameters.properties).toBeDefined()
    expect(parameters.properties).toHaveProperty('template')
    expect(parameters.properties).toHaveProperty('outputName')
    expect(parameters.properties).not.toHaveProperty('sections')
    expect(parameters.properties).toHaveProperty('draft')
    expect(parameters.required).toContain('draft')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.execute).toBe('function')
    const draft = parameters.properties?.draft as { oneOf?: unknown[]; additionalProperties?: boolean }
    expect(draft.oneOf).toHaveLength(2)
    expect(draft.additionalProperties).toBeUndefined()
  })

  it('accepts exactly one draft branch and rejects an item wrapper', () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    const schema = tool.parameters as JsonSchemaNode
    const spec = {
      meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
      claims: ['一种装置，其特征在于，包括示例部件。'],
      abstract: ['本发明公开一种装置。'],
      figureFiles: ['fig1.svg', 'fig2.svg'],
      sections: {
        technicalField: [{ kind: 'paragraph', text: '本发明属于示例领域。' }],
        background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
        summary: [{ kind: 'list', items: ['效果一', '效果二'], ordered: true }],
        drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图', '剖视示意图'] }],
        embodiment: [{
          kind: 'table',
          name: '示例参数表',
          header: ['参数', '取值'],
          rows: [['长度', '10mm']],
        }],
      },
    }
    const check = (draft: unknown, template = 'claims-spec') => validateJsonSchemaValue(schema, {
      template,
      outputName: 'out',
      draft,
    })
    expect(check(spec)).toEqual([])
    expect(check({ fields: {}, sections: [] }, 'oa-response')).toEqual([])
    const templateDraft = {
      fields: { 'footer-case': '案卷' },
      sections: [
        { id: 'body', blocks: [{ kind: 'paragraph', text: '正文。' }] },
        { id: 'rows', rows: [['a', 'b']] },
        { id: 'grounds', grounds: [{ article: '专利法第22条第3款', ground: '创造性', claimNos: [1], facts: '事实', evidence: '证据', conclusion: '结论' }] },
      ],
    }
    expect(check(templateDraft, 'invalidation-opinion')).toEqual([])
    expect(check({ ...spec, claims: { item: ['一种装置'] } }).join('\n')).toContain('matched 0')
    expect(check({ ...spec, sections: [] }).join('\n')).toContain('matched 0')
    const tableInField = {
      ...spec,
      sections: {
        ...spec.sections,
        technicalField: [{ kind: 'table', name: '不应出现', header: ['列'], rows: [['值']] }],
      },
    }
    expect(check(tableInField)).toEqual([])
    expect(() => validateSpecDraft(tableInField)).toThrow('表格仅允许出现在具体实施方式')
    expect(() => validateSpecDraft({ ...spec, claims: [''] })).toThrow('claims[0] 为空')
    expect(check({ ...spec, claims: [''] })).toEqual([])
    const drawingFree = {
      ...spec,
      figureFiles: [],
      sections: { ...spec.sections, drawingDescriptions: [] },
    }
    expect(check(drawingFree)).toEqual([])
    expect(validateSpecDraft(drawingFree).figureFiles).toEqual([])
    expect(() => validateTemplateDraft({ fields: {}, sections: [{ id: 'missing', blocks: [{ kind: 'paragraph', text: 'x' }] }] }, { sections: { body: { required: true } } })).toThrow('未知槽位')
  })

  it('executes a claims-spec render from a controlled draft', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const tool = createRenderPatentDocumentTool({ subprocess })
      const value = (await tool.execute(
        {
          template: 'claims-spec',
          outputName: 'spec-draft',
          outputDir: dir,
          format: 'html',
          draft: {
            meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
            claims: ['一种装置，其特征在于，包括示例部件。'],
            abstract: ['本发明公开一种装置。'],
            figureFiles: ['fig1.svg'],
            sections: {
              technicalField: [{ kind: 'paragraph', text: '本发明属于示例领域。' }],
              background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
              summary: [{ kind: 'paragraph', text: '本发明提供一种装置。' }],
              drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
              embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
            },
          },
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string; warnings: string[] }

      expect(existsSync(value.htmlPath)).toBe(true)
      const html = readFileSync(value.htmlPath, 'utf8')
      expect(html).toContain('<h3>技术领域</h3><p>本发明属于示例领域。</p>')
      expect(html).toContain('<span class="claim-num">1.</span>一种装置')
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an invalid draft with the slot-listing validation message', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    await expect(tool.execute(
      {
        template: 'claims-spec',
        outputName: 'bad-draft',
        format: 'html',
        draft: {
          meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
          claims: ['1. 自带项号的一种装置'],
          abstract: ['本发明公开一种装置。'],
          figureFiles: ['fig1.svg'],
          sections: {
            technicalField: [{ kind: 'paragraph', text: '本发明属于示例领域。' }],
            background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
            summary: [{ kind: 'paragraph', text: '本发明提供一种装置。' }],
            drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
            embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
          },
        },
      },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow(/claims\[0\] 自带项号/)
  })

  it('rejects the legacy sections parameter at the executor argument gate', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    // sections 已不在参数 schema 里：执行器按缺 required draft 拒绝，不静默忽略旧键。
    await expect(tool.execute(
      {
        template: 'claims-spec',
        outputName: 'legacy-sections',
        format: 'html',
        sections: { 'meta-title': '旧用法' },
      },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow(/missing required property "draft"/)
  })

  it('rejects a non-string brand value', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    await expect(tool.execute(
      {
        template: 'claims-spec',
        outputName: 'bad-brand',
        format: 'html',
        brand: { firm: 42 as never },
        draft: {
          meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
          claims: ['一种装置，其特征在于，包括示例部件。'],
          abstract: ['本发明公开一种装置。'],
          figureFiles: ['fig1.svg'],
          sections: {
            technicalField: [{ kind: 'paragraph', text: '本发明属于示例领域。' }],
            background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
            summary: [{ kind: 'paragraph', text: '本发明提供一种装置。' }],
            drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
            embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
          },
        },
      },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow(/brand 的键 "firm" 必须是字符串/)
  })

  it('renders the canonical result as pure model-facing prose', () => {
    const text = renderDocumentResult({
      htmlPath: '/out/a.html',
      pdfPath: '/out/a.pdf',
      warnings: ['section 未命中'],
    })
    expect(text).toContain('HTML written: /out/a.html')
    expect(text).toContain('PDF written: /out/a.pdf')
    expect(text).toContain('Warning: section 未命中')
  })

  it('names the PDF failure reason in prose', () => {
    const text = renderDocumentResult({ htmlPath: '/out/a.html', pdfError: 'no chrome', warnings: [] })
    expect(text).toContain('PDF not written: no chrome')
    expect(text).toContain('/out/a.html')
    expect(text).not.toContain('PDF written:')
  })

  it('executes an html-only render and returns the canonical value', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const tool = createRenderPatentDocumentTool({ subprocess })
      const value = (await tool.execute(
        {
          template: 'patentability-opinion',
          outputName: 'test-opinion',
          outputDir: dir,
          format: 'html',
          draft: opinionDraft('标题'),
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string; warnings: string[] }

      expect(value.htmlPath).toBe(join(dir, 'test-opinion.html'))
      expect(existsSync(value.htmlPath)).toBe(true)
      expect(Array.isArray(value.warnings)).toBe(true)
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('threads an injected print timeout through the tool options', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const chrome = join(dir, 'chrome')
    writeFileSync(chrome, '')
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const subprocess = fakeSubprocess((spec) => {
        const pdfArgument = spec.argv.find(argument => argument.startsWith('--print-to-pdf='))
        if (pdfArgument !== undefined) writeFileSync(pdfArgument.slice('--print-to-pdf='.length), '%PDF-1.4')
        return successHandle()
      }).runtime
      const tool = createRenderPatentDocumentTool({ subprocess, chromePath: chrome, pdfTimeoutMs: 1_500 })
      const value = (await tool.execute(
        {
          template: 'patentability-opinion',
          outputName: 'timed',
          outputDir: dir,
          format: 'pdf',
          draft: opinionDraft('标题'),
        },
        { signal: new AbortController().signal } as never,
      )) as { pdfPath?: string }

      expect(value.pdfPath).toBe(join(dir, 'timed.pdf'))
      expect(existsSync(value.pdfPath ?? '')).toBe(true)
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('renders the canonical result through the output renderer', () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    const blocks = tool.output.render({}, { htmlPath: '/out/a.html', warnings: [] })
    expect(blocks).toEqual([{ type: 'text', text: 'HTML written: /out/a.html' }])
  })

  it('executes without brand, outputDir, or format into the default output directory', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    try {
      const tool = createRenderPatentDocumentTool({ subprocess, defaultOutputDir: dir, chromePath: join(dir, 'missing-chrome') })
      const value = (await tool.execute(
        { template: 'patentability-opinion', outputName: 'default-dir', draft: opinionDraft('缺省') },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string; warnings: string[]; pdfError?: string }

      expect(value.htmlPath).toBe(join(dir, 'default-dir.html'))
      expect(existsSync(value.htmlPath)).toBe(true)
      expect(value.warnings).toEqual([])
      expect(value.pdfError).toContain('未找到 Chrome')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('executes with an inline brand and brandPath overrides', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const themePath = join(dir, 'theme.json')
      writeFileSync(themePath, JSON.stringify({ documents: { patent: { accent: '#112233' } } }))
      const tool = createRenderPatentDocumentTool({ subprocess })
      const value = (await tool.execute(
        {
          template: 'patentability-opinion',
          outputName: 'branded',
          outputDir: dir,
          format: 'html',
          draft: opinionDraft('品牌'),
          brand: { firm: '显式事务所' },
          brandPath: themePath,
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string }
      const html = readFileSync(value.htmlPath, 'utf8')
      expect(html).toContain('显式事务所')
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('executes with a caseId into data/cases/<caseId>/outputs relative to the cwd', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const tool = createRenderPatentDocumentTool({ subprocess })
      const value = (await tool.execute(
        {
          template: 'patentability-opinion',
          outputName: 'sr-case',
          caseId: 'c-2026-01',
          format: 'html',
          draft: opinionDraft('案卷'),
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string }
      expect(value.htmlPath.endsWith(join('data', 'cases', 'c-2026-01', 'outputs', 'sr-case.html'))).toBe(true)
      expect(existsSync(value.htmlPath)).toBe(true)
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('executes a PDF render and reports the written pdf path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      writeFileSync(join(dir, 'chrome'), '')
      const subprocess = fakeSubprocess((spec) => {
        const pdfArg = spec.argv.find(a => a.startsWith('--print-to-pdf='))
        if (pdfArg !== undefined) writeFileSync(pdfArg.slice('--print-to-pdf='.length), '%PDF-1.4')
        return successHandle()
      }).runtime
      const tool = createRenderPatentDocumentTool({ subprocess, chromePath: join(dir, 'chrome') })
      const value = (await tool.execute(
        {
          template: 'patentability-opinion',
          outputName: 'pdf-ok',
          outputDir: dir,
          format: 'pdf',
          draft: opinionDraft('PDF 成功'),
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string; pdfPath?: string }

      expect(value.pdfPath).toBe(join(dir, 'pdf-ok.pdf'))
      expect(existsSync(value.pdfPath as string)).toBe(true)
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('render_patent_document tool 表单草案分发', () => {
  const srpDraft = {
    fields: {
      reportNo: 'SR-2026-0001',
      searchDateYear: '2026', searchDateMonth: '10', searchDateDay: '08',
      applicationNo: 'ZL2022209876543',
      inventionTitle: '一种带式输送机的自动张紧机构',
      patentee: '宁波华驰输送设备有限公司',
      searcher: '王磊', reviewer: '陈静',
      ipcClass: 'B65G 23/44', footerFirm: 'SR-2026-0001',
      distXCount: '0', distXRatio: '0%', distXImpact: '—',
      distYCount: '2', distYRatio: '25%', distYImpact: '组合影响权利要求 1、5 的创造性',
      distACount: '6', distARatio: '75%', distAImpact: '背景技术',
      distTotalCount: '8', distTotalRatio: '100%',
      reportDateYear: '2026', reportDateMonth: '10', reportDateDay: '08',
    },
    sections: [
      { id: 'searchField', blocks: [{ kind: 'paragraph', text: 'B65G23/44' }] },
      { id: 'databases', blocks: [{ kind: 'paragraph', text: 'CNABS' }] },
      {
        id: 'relatedDocuments',
        rows: [['Y', 'CN213456789 U', '2021.06.22', 'B65G 23/44', '说明书全文', '1、5']],
      },
      { id: 'conclusion', blocks: [{ kind: 'paragraph', text: '共筛选出 8 篇相关文件。' }] },
      {
        id: 'searchRounds',
        rows: [['R1', 'CNABS', '输送带 AND 张紧', '312', '2026.10.08']],
      },
    ],
  }

  it('executes a search-report-form render from a form draft', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const tool = createRenderPatentDocumentTool({ subprocess })
      const value = (await tool.execute(
        {
          template: 'search-report-form',
          outputName: 'form-draft',
          outputDir: dir,
          format: 'html',
          draft: srpDraft,
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string; warnings: string[] }
      expect(existsSync(value.htmlPath)).toBe(true)
      const html = readFileSync(value.htmlPath, 'utf8')
      expect(html).toContain('报告编号：<span class="fill">SR-2026-0001</span>')
      expect(html).toContain('<span class="fill w-sm">R1</span>')
      expect(html).not.toContain('data-slot')
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects an invalid form draft with the slot-listing validation message', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    await expect(tool.execute(
      {
        template: 'search-report-form',
        outputName: 'bad-form-draft',
        format: 'html',
        draft: { fields: { reportNo: 'X', unknownSlot: 'y' }, sections: [] },
      },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow(/fields.unknownSlot 未知槽位/)
  })

  it('rejects an unknown choice option listing available options', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const tool = createRenderPatentDocumentTool({ subprocess })
    await expect(tool.execute(
      {
        template: 'right-evaluation-report',
        outputName: 'bad-choice',
        format: 'html',
        draft: {
          fields: { evalTarget: 'notAnOption' },
          sections: [],
        },
      },
      { signal: new AbortController().signal } as never,
    )).rejects.toThrow(/未知选项 "notAnOption".*granted/)
  })

  it('executes an oa-response render from a generic-template draft', async () => {
    const subprocess = fakeSubprocess(() => successHandle()).runtime
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tool-'))
    const savedCwd = process.cwd()
    try {
      process.chdir(dir)
      const tool = createRenderPatentDocumentTool({ subprocess })
      const value = (await tool.execute(
        {
          template: 'oa-response',
          outputName: 'oa-draft',
          outputDir: dir,
          format: 'html',
          draft: {
            fields: {
              'meta-appno': 'CN2022209876543',
              'meta-title': '一种带式输送机的自动张紧机构',
              'meta-oa-no': '第一次审查意见通知书',
              'meta-oa-date': '2026-09-01',
              'meta-response-date': '2026-10-09',
              'meta-agent': 'XX 知识产权代理事务所',
              'position-summary': '申请人认为权利要求具备新颖性与创造性。',
              'conclusion-text': '恳请授予专利权。',
              'footer-case': 'OA-2026-0042 · 机密',
              'footer-date': '2026 年 10 月 09 日',
            },
            sections: [
              { id: 'doc-number', blocks: [{ kind: 'paragraph', text: '答复编号：OA-2026-0042 · 版本 V1.0' }] },
              { id: 'position-points', blocks: [{ kind: 'list', items: ['要点一；', '要点二。'], ordered: true }] },
              {
                id: 'amendment-table',
                rows: [['权利要求 1', '未限定随动结构', '增加随动结构', '克服创造性缺陷']],
              },
              { id: 'amended-claim-1', blocks: [{ kind: 'paragraph', text: '1. 一种带式输送机的自动张紧机构，其特征在于，还包括随动结构。' }] },
              { id: 'facts-application', blocks: [{ kind: 'paragraph', text: 'F1 随动结构记载于原权利要求 1。' }] },
              { id: 'facts-prior-art', blocks: [{ kind: 'paragraph', text: 'P1 对比文件 1 未公开随动结构。' }] },
              { id: 'rules-body', blocks: [{ kind: 'paragraph', text: 'R1《专利法》第 22 条第 3 款。' }] },
              { id: 'argument-novelty', blocks: [{ kind: 'paragraph', text: '对比文件 1 未公开随动结构，权利要求 1 具备新颖性。' }] },
              { id: 'argument-inventiveness', blocks: [{ kind: 'paragraph', text: '对比文件 1 与 2 的结合无技术启示。' }] },
              {
                id: 'evidence-table',
                rows: [['D1', 'CN213456789 U', '2021.06.22', '实用新型', '随动结构未公开', '证据来源']],
              },
              {
                id: 'citation-table',
                rows: [['D1', 'CN213456789 U', '2021.06.22', '对比文件', '全文', '1']],
              },
            ],
          },
        },
        { signal: new AbortController().signal } as never,
      )) as { htmlPath: string; warnings: string[] }
      expect(existsSync(value.htmlPath)).toBe(true)
      const html = readFileSync(value.htmlPath, 'utf8')
      expect(html).toContain('CN2022209876543')
      expect(html).toContain('<td>增加随动结构</td>')
      expect(html).toContain('随动结构未公开')
    } finally {
      process.chdir(savedCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
