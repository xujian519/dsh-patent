import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_OUTPUT_DIR, renderPatentDocument } from '@deepseek-ai/dsh-patent-document'
import { validateTemplateDraft, type SpecDraft, type TemplateDraft } from '@deepseek-ai/dsh-patent-core'
import { FORM_TEMPLATE_SCHEMAS } from '../src/document/draftSchema/index.ts'
import { fakeSubprocess, successHandle, unusedSubprocess } from './helpers.ts'

// Deterministic render-side seams: Chrome discovery and the template source
// are environment-dependent, and the atomic-write failure needs a controllable
// fs/promises. findChrome is a same-module binding of renderPdf, so discovery
// is fenced by mocking existsSync for the built-in candidate list instead.
const renderMocks = vi.hoisted(() => ({
  chromeCandidates: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    'C:\\Program Files\\Google Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  craftedTemplate: undefined as string | undefined,
  failNextWriteFile: false,
  failNextRm: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: ((p: unknown) => {
      const path = String(p)
      if (renderMocks.chromeCandidates.includes(path)) return false
      return actual.existsSync(p as Parameters<typeof actual.existsSync>[0])
    }) as typeof actual.existsSync,
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(async (...args: unknown[]) => {
      if (renderMocks.failNextWriteFile) {
        renderMocks.failNextWriteFile = false
        throw new Error('模拟磁盘写入失败')
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(...args)
    }),
    rm: vi.fn(async (...args: unknown[]) => {
      if (renderMocks.failNextRm) {
        renderMocks.failNextRm = false
        throw new Error('模拟清理失败')
      }
      return (actual.rm as (...a: unknown[]) => Promise<void>)(...args)
    }),
  }
})

vi.mock('../src/document/templateResolver.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/document/templateResolver.ts')>()
  return {
    ...actual,
    readTemplateHtml: vi.fn((id: string) => renderMocks.craftedTemplate ?? actual.readTemplateHtml(id as never)),
  }
})

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-doc-'))
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** A subprocess runtime that writes the requested PDF path, simulating headless Chrome. */
function pdfWritingSubprocess() {
  return fakeSubprocess((spec) => {
    const pdfArg = spec.argv.find(a => a.startsWith('--print-to-pdf='))
    if (pdfArg !== undefined) writeFileSync(pdfArg.slice('--print-to-pdf='.length), '%PDF-1.4')
    return successHandle()
  }).runtime
}

describe('renderPatentDocument', () => {
  it('renders HTML with injected content and brand', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'test-opinion',
          outputDir: dir,
          format: 'html',
          brand: { firm: '测试事务所' },
          templateDraft: {
            fields: {
              'meta-client': '委托方 A',
              'meta-title': '智能保温杯',
              'sum-conclusion': '授权前景良好。',
            },
            sections: [],
          },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )

      expect(existsSync(result.htmlPath)).toBe(true)
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('测试事务所')
      expect(html).toContain('委托方 A')
      expect(html).toContain('智能保温杯')
      expect(html).toContain('授权前景良好。')
      expect(result.pdfPath).toBeUndefined()
      expect(result.pdfError).toBeUndefined()
    } finally {
      cleanup(dir)
    }
  })

  it('accepts a Chinese draft name as the output filename', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: '待补案卷号-claims-spec_v1_未放行校验稿',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '中文命名' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      expect(result.htmlPath).toContain('待补案卷号-claims-spec_v1_未放行校验稿.html')
    } finally {
      cleanup(dir)
    }
  })

  it('accepts a circled-numeral case prefix as the output filename', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: '②件_权利要求书与说明书_内部稿',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '圈码前缀' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      expect(result.htmlPath).toContain('②件_权利要求书与说明书_内部稿.html')
    } finally {
      cleanup(dir)
    }
  })

  it('accepts Chinese punctuation in a draft name', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: '02_权利要求书（草案）·v1',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '中文标点' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      expect(result.htmlPath).toContain('02_权利要求书（草案）·v1.html')
    } finally {
      cleanup(dir)
    }
  })

  it('rejects a name carrying a path separator', async () => {
    const dir = makeTempDir()
    try {
      await expect(
        renderPatentDocument(
          {
            template: 'patentability-opinion',
            outputName: '内部稿/②件',
            outputDir: dir,
            format: 'html',
          },
          dir,
          { subprocess: unusedSubprocess() },
        ),
      ).rejects.toThrow(/非法输出文件名/)
    } finally {
      cleanup(dir)
    }
  })

  it('falls back to template tokens.css defaults when no brand is given', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'test-default-brand',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '默认品牌测试' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('XX 知识产权代理事务所')
    } finally {
      cleanup(dir)
    }
  })

  it('uses data/cases/<caseId>/outputs when a caseId is given', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'search-report',
          outputName: 'sr-001',
          caseId: 'case-2026-001',
          format: 'html',
          templateDraft: { fields: { 'meta-title': '检索报告测试' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.htmlPath.endsWith(join('data', 'cases', 'case-2026-001', 'outputs', 'sr-001.html'))).toBe(true)
      expect(existsSync(result.htmlPath)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('fails closed on an illegal output name', async () => {
    const dir = makeTempDir()
    try {
      await expect(
        renderPatentDocument(
          {
            template: 'patentability-opinion',
            outputName: '../escape',
            outputDir: dir,
            format: 'html',
          },
          dir,
          { subprocess: unusedSubprocess() },
        ),
      ).rejects.toThrow(/非法输出文件名/)
    } finally {
      cleanup(dir)
    }
  })

  it('renders a PDF through the injected subprocess seam', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'chrome'), '')
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'test-pdf',
          outputDir: dir,
          format: 'pdf',
          templateDraft: { fields: { 'meta-title': 'PDF 生成测试' }, sections: [] },
        },
        dir,
        { subprocess: pdfWritingSubprocess(), chromePath: join(dir, 'chrome') },
      )
      expect(result.pdfPath).toBeDefined()
      expect(result.pdfPath).toBe(join(dir, 'test-pdf.pdf'))
      expect(existsSync(result.pdfPath as string)).toBe(true)
      expect(existsSync(result.htmlPath)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('degrades to HTML-only when no Chrome is discoverable', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'no-chrome',
          outputDir: dir,
          format: 'both',
          templateDraft: { fields: { 'meta-title': '降级测试' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess(), chromePath: join(dir, 'missing-chrome') },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      expect(result.pdfPath).toBeUndefined()
      expect(result.pdfError).toBeDefined()
      expect(result.pdfError).toContain('未找到 Chrome')
    } finally {
      cleanup(dir)
    }
  })

  it('renders a generic document template from a templateDraft and keeps the skeleton wrappers', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'generic-draft',
          outputDir: dir,
          format: 'html',
          templateDraft: {
            fields: { 'meta-title': '草案标题' },
            sections: [
              { id: 'basis-body', blocks: [{ kind: 'paragraph', text: '要件结论正文。' }] },
            ],
          },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('<p>要件结论正文。</p>')
      // 骨架包装（含分区标题与子槽位）由模板保留，草案只注入槽位内容。
      expect(html).toContain('id="executive-summary"')
    } finally {
      cleanup(dir)
    }
  })

  it('skips an illegal draft section id with a warning', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'illegal-id',
          outputDir: dir,
          format: 'html',
          templateDraft: { sections: [{ id: '../bad', blocks: [{ kind: 'paragraph', text: '丢弃内容' }] }] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.warnings.join(' ')).toContain('../bad')
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).not.toContain('丢弃内容')
    } finally {
      cleanup(dir)
    }
  })

  it('warns on draft section ids missing from the template without polluting the HTML', async () => {
    const dir = makeTempDir()
    try {
      renderMocks.craftedTemplate = '<html><body><section id="specification-body"></section></body></html>'
      const result = await renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: 'warn-ids',
          outputDir: dir,
          format: 'html',
          draft: {
            meta: { caseNumber: 'CN2026-0001', title: '一种智能保温杯', applicant: '示例科技有限公司', inventor: '张三', agent: 'XX 事务所', date: '2026-10-09' },
            claims: ['一种智能保温杯，其特征在于，包括杯体。'],
            abstract: ['本发明公开一种智能保温杯。'],
            figureFiles: ['fig1.svg'],
            sections: {
              technicalField: [{ kind: 'paragraph', text: '本发明属于日用品领域。' }],
              background: [{ kind: 'paragraph', text: '现有保温杯无法显示水温。' }],
              summary: [{ kind: 'paragraph', text: '本发明提供一种智能保温杯。' }],
              drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
              embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
            },
          },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const warnings = result.warnings.join(' ')
      expect(warnings).toContain('claims-body')
      expect(warnings).toContain('abstract')
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('<h3>技术领域</h3>')
      // 未命中的槽位不注入：meta/claims 等槽位在模板中不存在，其内容整体被跳过。
      expect(html).not.toContain('示例科技有限公司')
      expect(html).not.toContain('claim-num')
    } finally {
      renderMocks.craftedTemplate = undefined
      cleanup(dir)
    }
  })

  it('warns on internal working-record headings in the assembled document', async () => {
    const dir = makeTempDir()
    try {
      renderMocks.craftedTemplate = '<html><head></head><body><h2>待办清单</h2><section id="basis"></section></body></html>'
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'internal-heading',
          outputDir: dir,
          format: 'html',
          templateDraft: { sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.warnings?.join(' ')).toContain('内部工作记录用语')
    } finally {
      renderMocks.craftedTemplate = undefined
      cleanup(dir)
    }
  })

  it('warns on evidence ids the body cites but the evidence list does not register', async () => {
    const dir = makeTempDir()
    try {
      renderMocks.craftedTemplate = '<html><head></head><body><h2>一、总体立场</h2><p>D2 公开了 F1。</p>'
        + '<section aria-label="证据清单"><table><tbody><tr><td>D1</td></tr></tbody></table></section></body></html>'
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'evidence-mismatch',
          outputDir: dir,
          format: 'html',
          templateDraft: { sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.warnings?.join(' ')).toContain('「D2」未登记在证据清单')
    } finally {
      renderMocks.craftedTemplate = undefined
      cleanup(dir)
    }
  })

  it('fails closed on an illegal case id', async () => {
    const dir = makeTempDir()
    try {
      await expect(
        renderPatentDocument(
          {
            template: 'patentability-opinion',
            outputName: 'escape',
            caseId: '../../etc',
            format: 'html',
          },
          dir,
          { subprocess: unusedSubprocess() },
        ),
      ).rejects.toThrow(/非法案卷号/)
    } finally {
      cleanup(dir)
    }
  })

  it('atomically overwrites a same-named document', async () => {
    const dir = makeTempDir()
    try {
      await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'dup',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '第一版' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'dup',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '第二版' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('第二版')
      expect(html).not.toContain('第一版')
    } finally {
      cleanup(dir)
    }
  })

  it('warns when an explicit brandPath is missing', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'missing-brand',
          outputDir: dir,
          format: 'html',
          brandPath: join(dir, 'not-there.json'),
          templateDraft: { fields: { 'meta-title': '品牌回退测试' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.warnings?.join(' ')).toContain('品牌配置文件不存在')
    } finally {
      cleanup(dir)
    }
  })

  it('lands in the default output directory when neither outputDir nor caseId is given', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'default-dir',
          format: 'html',
          templateDraft: { fields: { 'meta-title': '缺省目录' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.htmlPath).toBe(join(dir, DEFAULT_OUTPUT_DIR, 'default-dir.html'))
      expect(existsSync(result.htmlPath)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('resolves a relative outputDir against cwd', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'rel-out',
          outputDir: 'out/docs',
          format: 'html',
          templateDraft: { fields: { 'meta-title': '相对目录' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.htmlPath).toBe(join(dir, 'out', 'docs', 'rel-out.html'))
      expect(existsSync(result.htmlPath)).toBe(true)
    } finally {
      cleanup(dir)
    }
  })

  it('resolves a relative brandPath against cwd and applies the theme brand', async () => {
    const dir = makeTempDir()
    try {
      writeFileSync(join(dir, 'theme.json'), JSON.stringify({ documents: { patent: { firm: '相对品牌' } } }))
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'rel-brand',
          outputDir: dir,
          format: 'html',
          brandPath: 'theme.json',
          templateDraft: { fields: { 'meta-title': '相对品牌路径' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('相对品牌')
    } finally {
      cleanup(dir)
    }
  })

  it('defaults the format to both and reports the pdf error', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'default-both',
          outputDir: dir,
          templateDraft: { fields: { 'meta-title': '默认 both' }, sections: [] },
        },
        dir,
        { subprocess: unusedSubprocess(), chromePath: join(dir, 'missing-chrome') },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      expect(result.pdfError).toBeDefined()
      expect(result.pdfError).toContain('未找到 Chrome')
    } finally {
      cleanup(dir)
    }
  })

  it('forwards an injected signal and omits the chromePath override', async () => {
    const dir = makeTempDir()
    try {
      const env = { ...process.env, DSH_CHROME_PATH: undefined, CHROME_PATH: undefined }
      vi.spyOn(process, 'env', 'get').mockReturnValue(env)
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'signal-only',
          outputDir: dir,
          format: 'pdf',
          templateDraft: { fields: { 'meta-title': '信号传递' }, sections: [] },
        },
        dir,
        {
          subprocess: unusedSubprocess(),
          signal: new AbortController().signal,
        },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      expect(result.pdfError).toContain('未找到 Chrome')
    } finally {
      vi.restoreAllMocks()
      cleanup(dir)
    }
  })

  it('cleans up the temp file and rethrows when the atomic write fails', async () => {
    const dir = makeTempDir()
    try {
      renderMocks.failNextWriteFile = true
      renderMocks.failNextRm = true
      await expect(
        renderPatentDocument(
          {
            template: 'patentability-opinion',
            outputName: 'write-fail',
            outputDir: dir,
            format: 'html',
            templateDraft: { fields: { 'meta-title': '写失败' }, sections: [] },
          },
          dir,
          { subprocess: unusedSubprocess() },
        ),
      ).rejects.toThrow(/模拟磁盘写入失败/)
    } finally {
      cleanup(dir)
    }
  })

  it('prepends the brand style when the template has no head', async () => {
    const dir = makeTempDir()
    try {
      renderMocks.craftedTemplate = '<html><body><section id="sec">x</section></body></html>'
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'no-head',
          outputDir: dir,
          format: 'html',
          brand: { firm: '无头品牌' },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html.startsWith('<style>')).toBe(true)
      expect(html).toContain('无头品牌')
    } finally {
      renderMocks.craftedTemplate = undefined
      cleanup(dir)
    }
  })

  it('renders each of the four post-draft templates from the real assets', async () => {
    const dir = makeTempDir()
    try {
      const cases = [
        {
          template: 'rectification-response',
          fields: { 'meta-title': '一种电池模组散热方法', 'rect-findings': '通知缺陷摘录' },
        },
        {
          template: 're-examination-request',
          fields: { 'meta-title': '一种电池模组散热结构', 'ground-1': '针对理由一的回应' },
        },
        {
          template: 'infringement-opinion',
          fields: { 'meta-title': '一种电池模组温度均衡装置', 'claim-text': '权利要求 1 全文', 'conclusion-text': '落入保护范围' },
        },
        {
          template: 'litigation-pleading',
          fields: { 'meta-title': '侵害发明专利权纠纷', 'doc-kind': '答辩状' },
        },
      ] as const
      for (const c of cases) {
        const result = await renderPatentDocument(
          {
            template: c.template,
            outputName: `tmp-${c.template}`,
            outputDir: dir,
            format: 'html',
            templateDraft: { fields: { ...c.fields }, sections: [] },
          },
          dir,
          { subprocess: unusedSubprocess() },
        )
        const html = readFileSync(result.htmlPath, 'utf8')
        for (const value of Object.values(c.fields)) {
          expect(html).toContain(value)
        }
      }
    } finally {
      cleanup(dir)
    }
  })
})

describe('renderPatentDocument claims-spec 受控草案', () => {
  /** 最小可渲染 claims-spec 草案（与 draft-converter 用例同形）。 */
  function draft(): SpecDraft {
    return {
      meta: { caseNumber: 'CN2026-0001', title: '一种智能保温杯', applicant: '示例科技有限公司', inventor: '张三', agent: 'XX 事务所', date: '2026-10-09' },
      claims: ['一种智能保温杯，其特征在于，包括杯体。'],
      abstract: ['本发明公开一种智能保温杯。'],
      figureFiles: ['fig1.svg'],
      sections: {
        technicalField: [{ kind: 'paragraph', text: '本发明属于日用品领域。' }],
        background: [{ kind: 'paragraph', text: '现有保温杯无法显示水温。' }],
        summary: [{ kind: 'paragraph', text: '本发明提供一种智能保温杯。' }],
        drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
        embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
      },
    }
  }

  it('balances void and self-closing tags and skips an element with no matching close', async () => {
    const dir = makeTempDir()
    try {
      renderMocks.craftedTemplate =
        '<html><head><title>t</title></head><body>' +
        '<section id="specification-body"><p>orig</p><br><span/></section>' +
        '<img id="claims-body">' +
        '<div id="abstract"><span>'
      const result = await renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: 'tag-scan',
          outputDir: dir,
          format: 'html',
          draft: draft(),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('<h3>技术领域</h3>')
      expect(html).not.toContain('orig')
      // claims-body（void img）与 abstract（未闭合 div）都找不到配对闭合，整体跳过并告警。
      expect(result.warnings.join(' ')).toContain('claims-body')
      expect(result.warnings.join(' ')).toContain('abstract')
    } finally {
      renderMocks.craftedTemplate = undefined
      cleanup(dir)
    }
  })

  it('claims-spec 传 draft 渲染：结构由转换器生成，非落款无占位符', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: 'spec-draft',
          outputDir: dir,
          format: 'html',
          draft: draft(),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('<h3>技术领域</h3><p>本发明属于日用品领域。</p>')
      expect(html).toContain('<span class="claim-num">1.</span>一种智能保温杯')
      expect(html).toContain('<li>图1为整体结构示意图。</li>')
      expect(html).toContain('图 <span class="mono">1</span>')
      // 非落款区域不得残留占位符（落款签名块除外）。
      const body = html.split('<div class="doc-closing">')[0] ?? ''
      expect(body).not.toContain('________')
      expect(body).not.toContain('<h4')
    } finally {
      cleanup(dir)
    }
  })

  it('未迁移模板传 SpecDraft 时报错并说明可用的草案模板', async () => {
    const dir = makeTempDir()
    try {
      await expect(renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'opinion-draft',
          outputDir: dir,
          format: 'html',
          draft: draft(),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )).rejects.toThrow(/不接受 SpecDraft 草案/)
    } finally {
      cleanup(dir)
    }
  })

  it('claims-spec 的 draft 与 templateDraft 互斥', async () => {
    const dir = makeTempDir()
    try {
      await expect(renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: 'spec-both',
          outputDir: dir,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '多余' }, sections: [] },
          draft: draft(),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )).rejects.toThrow(/draft 与 templateDraft 互斥/)
    } finally {
      cleanup(dir)
    }
  })
})

describe('renderPatentDocument 表单模板受控草案', () => {
  function exampleDraft(template: 'right-evaluation-report' | 'search-report-form'): TemplateDraft {
    const raw: unknown = JSON.parse(readFileSync(
      `packages/patent/patent-document/assets/templates/patent/${template}/assets/example-draft.json`,
      'utf8',
    ))
    return validateTemplateDraft(raw, FORM_TEMPLATE_SCHEMAS[template])
  }

  it('search-report-form 用 templateDraft 渲染并填充槽位', async () => {
    const dir = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'search-report-form',
          outputName: 'form-draft',
          outputDir: dir,
          format: 'html',
          templateDraft: exampleDraft('search-report-form'),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(result.warnings).toEqual([])
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('报告编号：<span class="fill">SR-2026-0001</span>')
      expect(html).toContain('检索人：<span class="fill">王磊</span>')
      expect(html).not.toContain('data-slot')
    } finally {
      cleanup(dir)
    }
  })

  it('draft 与 templateDraft 互斥', async () => {
    const dir = makeTempDir()
    try {
      await expect(renderPatentDocument(
        {
          template: 'right-evaluation-report',
          outputName: 'both-drafts',
          outputDir: dir,
          format: 'html',
          draft: {
            meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
            claims: ['一种装置，其特征在于，包括本体。'],
            abstract: ['摘要正文。'],
            figureFiles: ['fig1.svg'],
            sections: {
              technicalField: [{ kind: 'paragraph', text: '本发明属于机械领域。' }],
              background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
              summary: [{ kind: 'paragraph', text: '本发明提供一种装置。' }],
              drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
              embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
            },
          } satisfies SpecDraft,
          templateDraft: exampleDraft('right-evaluation-report'),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )).rejects.toThrow(/draft 与 templateDraft 互斥/)
    } finally {
      cleanup(dir)
    }
  })

  it('claims-spec 传 templateDraft 报错并指向 draft（SpecDraft 结构）', async () => {
    const dir = makeTempDir()
    try {
      await expect(renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: 'wrong-draft-kind',
          outputDir: dir,
          format: 'html',
          templateDraft: exampleDraft('right-evaluation-report'),
        },
        dir,
        { subprocess: unusedSubprocess() },
      )).rejects.toThrow(/claims-spec 请用 draft 参数（SpecDraft 结构）/)
    } finally {
      cleanup(dir)
    }
  })
})

describe('renderPatentDocument 工作目录约束', () => {
  it('rejects an outputDir whose real path leaves the working directory', async () => {
    const cwd = makeTempDir()
    const outside = makeTempDir()
    try {
      await expect(renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'escape',
          outputDir: outside,
          format: 'html',
          templateDraft: { fields: { 'meta-title': '越界输出' }, sections: [] },
        },
        cwd,
        { subprocess: unusedSubprocess() },
      )).rejects.toThrow(/输出目录 越出工作目录/)
      expect(existsSync(join(outside, 'escape.html'))).toBe(false)
    } finally {
      cleanup(cwd)
      cleanup(outside)
    }
  })

  it('accepts an absolute outputDir inside the working directory', async () => {
    const cwd = makeTempDir()
    try {
      const result = await renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'inside',
          outputDir: join(cwd, 'deliver'),
          format: 'html',
          templateDraft: { fields: { 'meta-title': '工作目录内输出' }, sections: [] },
        },
        cwd,
        { subprocess: unusedSubprocess() },
      )
      expect(result.htmlPath).toBe(join(cwd, 'deliver', 'inside.html'))
      expect(existsSync(result.htmlPath)).toBe(true)
    } finally {
      cleanup(cwd)
    }
  })

  it('rejects a brandPath whose real path leaves the working directory', async () => {
    const cwd = makeTempDir()
    const outside = makeTempDir()
    writeFileSync(join(outside, 'theme.json'), '{}')
    try {
      await expect(renderPatentDocument(
        {
          template: 'patentability-opinion',
          outputName: 'escape-brand',
          outputDir: join(cwd, 'deliver'),
          format: 'html',
          brandPath: join(outside, 'theme.json'),
          templateDraft: { fields: { 'meta-title': '越界品牌' }, sections: [] },
        },
        cwd,
        { subprocess: unusedSubprocess() },
      )).rejects.toThrow(/品牌配置路径 越出工作目录/)
    } finally {
      cleanup(cwd)
      cleanup(outside)
    }
  })
})
