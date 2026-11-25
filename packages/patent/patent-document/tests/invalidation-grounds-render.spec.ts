/**
 * 无效理由节（grounds 槽位）的端到端渲染：草案结构 → 生成节标题与四段式正文 → 落盘 HTML。
 *
 * 断言的是成品文书里的标题形态（`4.1 权利要求 1、2 不具备创造性（…）`）与「按实际主张的理由
 * 生成章节」这一条：草案提交两项不同法条的理由就得两个小节，未提交的理由不出现在文书里。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderPatentDocument } from '@deepseek-ai/dsh-patent-document'
import { validateTemplateDraft, type TemplateDraft, type TemplateDraftSchema } from '@deepseek-ai/dsh-patent-core'
import { GENERIC_TEMPLATE_SCHEMAS } from '../src/document/draftSchema/index.ts'
import { unusedSubprocess } from './helpers.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 渲染一份草案并返回写出的 HTML。 */
async function render(template: 'invalidation-opinion' | 'invalidation-analysis', draft: TemplateDraft): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inv-grounds-'))
  dirs.push(dir)
  const schema: TemplateDraftSchema = GENERIC_TEMPLATE_SCHEMAS[template]
  const validated = validateTemplateDraft(draft, schema)
  const result = await renderPatentDocument(
    { template, outputName: 'inv', outputDir: dir, templateDraft: validated, format: 'html' },
    dir,
    { subprocess: unusedSubprocess() },
  )
  expect(result.warnings).toEqual([])
  return readFileSync(result.htmlPath, 'utf8')
}

const meta = {
  'meta-patent-no': 'CN2025XXXXXXXX.X',
  'meta-patent-title': '一种智能保温杯',
  'meta-grant-date': '2025-12-10',
  'meta-patentee': '盛水科技有限公司',
  'meta-date': '2026-08-14',
  'footer-case': 'IV-2026-0015',
  'footer-date': '2026-08-14',
}

const requestDraft = (grounds: TemplateDraft['sections'][number]): TemplateDraft => ({
  fields: {
    ...meta,
    'meta-requester': '华新科技有限公司',
    'position-summary': '请求人认为涉案专利的权利要求 1、2 不具备创造性，应予无效。',
    'conclusion-text': '请求宣告权利要求 1、2 无效。',
  },
  sections: [
    { id: 'doc-number', blocks: [{ kind: 'paragraph', text: 'IV-2026-0015' }] },
    { id: 'position-points', blocks: [{ kind: 'list', items: ['权利要求 1、2 不具备创造性（A22.3）。'] }] },
    { id: 'claim-feature-table', rows: [['权1', 'F1', '双层真空结构', '延长保温时长']] },
    { id: 'evidence-table', rows: [
      ['D1', 'CN20151234567A', '双层真空保温杯', '2025-05-12', '现有技术', '¶0015'],
      ['D3', 'CN20161234567U', '电加热保温容器', '2024-11-03', '现有技术', '¶0021'],
    ] },
    grounds,
    { id: 'claim-conclusion-table', rows: [['权1', '请求宣告无效', 'A22.3', 'D1+D3 结合']] },
  ],
})

describe('invalidation-opinion：无效理由节由草案结构生成', () => {
  it('逐项生成 4.N 节标题与四段式正文，提交几项就出几节', async () => {
    const html = await render('invalidation-opinion', requestDraft({
      id: 'grounds-body',
      grounds: [
        {
          article: '专利法第22条第3款',
          ground: '创造性',
          claimNos: [1, 2],
          facts: '权利要求 1 包括 F1 双层真空结构。',
          evidence: 'D1 ¶0015 公开了 F1。',
          conclusion: '权利要求 1、2 不具备创造性。',
        },
        {
          article: '专利法第26条第4款',
          ground: '不清楚',
          claimNos: [3],
          facts: '权利要求 3 未限定阈值。',
          evidence: '说明书未记载阈值。',
          conclusion: '权利要求 3 保护范围不清楚。',
        },
      ],
    }))

    expect(html).toContain('<h3>4.1 权利要求 1、2 不具备创造性（专利法第22条第3款）</h3>')
    expect(html).toContain('<h3>4.2 权利要求 3 不具备不清楚（专利法第26条第4款）</h3>')
    expect(html.match(/<h3>\d+\.\d+ 权利要求/g)?.length).toBe(2)
    expect(html).toContain('<h4>事实认定</h4><p>权利要求 1 包括 F1 双层真空结构。</p>')
    expect(html).toContain('<h4>证据分析</h4><p>D1 ¶0015 公开了 F1。</p>')
    expect(html).toContain('<h4>法条适用与结论</h4><p>权利要求 1、2 不具备创造性。</p>')
    // 未主张的理由不因模板而出现（模板已不写死新颖性小节）。
    expect(html).not.toContain('不具备新颖性')
    expect(html).not.toContain('引用日志')
    // 落款签名行由人工在定稿时填写（与其余交付件同一约定），除它以外的占位必须已被草案填满。
    const placeholders = html.match(/________/g) ?? []
    const signaturePlaceholders = html.match(/class="sign-block">[^<]*________/g) ?? []
    expect(placeholders.length).toBe(signaturePlaceholders.length)
  })

  it('内部件用同一机制生成理由节，节序前缀取各自注册表的声明', async () => {
    const html = await render('invalidation-analysis', {
      fields: {
        ...meta,
        'meta-client': '华新科技有限公司',
        'scope-summary': '本次分析范围为权利要求 1、2 的创造性。',
        'conclusion-text': '权利要求 1、2 可无效（证据充分）。',
      },
      sections: [
        { id: 'doc-number', blocks: [{ kind: 'paragraph', text: 'IV-2026-0015' }] },
        { id: 'scope-points', blocks: [{ kind: 'list', items: ['权利要求 1、2 的创造性。'] }] },
        { id: 'claim-feature-table', rows: [['权1', 'F1', '双层真空结构', '延长保温时长']] },
        { id: 'evidence-table', rows: [
          ['D1', 'CN20151234567A', '双层真空保温杯', '2025-05-12', '现有技术', '¶0015'],
          ['D2', 'CN20159876543U', '杯盖温度显示结构（全文未取得）', '2024-09-18', '现有技术（待核）', '—'],
          ['D3', 'CN20161234567U', '电加热保温容器', '2024-11-03', '现有技术', '¶0021'],
        ] },
        {
          id: 'grounds-body',
          grounds: [{
            article: '专利法第22条第3款',
            ground: '创造性',
            claimNos: [1],
            facts: '事实。',
            evidence: '证据。',
            conclusion: '结论。',
          }],
        },
        { id: 'claim-outlook-table', rows: [['权1', '可无效（证据充分）', 'A22.3', 'D1+D3 结合']] },
        { id: 'citation-table', rows: [['D1 公开 F1', '现有技术文献', 'D1', '2025-05-12', '证据支撑', '¶0015']] },
        { id: 'gaps-body', blocks: [{ kind: 'list', items: ['D2 未取得全文。'] }] },
      ],
    })

    expect(html).toContain('<h3>4.1 权利要求 1 不具备创造性（专利法第22条第3款）</h3>')
    expect(html).toContain('成功率分档')
    expect(html).toContain('D2 未取得全文。')
  })
})
