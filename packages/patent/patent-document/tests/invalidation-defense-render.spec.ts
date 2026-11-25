/**
 * 无效宣告程序意见陈述书（invalidation-defense）的端到端渲染：草案结构 → 生成节标题与四段式
 * 正文 → 落盘 HTML → 机械合规检查零告警。
 *
 * 断言的是成品文书里的形态：逐项答辩的节标题由模板体例（节序 `5`、关系词「的」）与草案结构
 * 共同生成，被主张几项理由就出几节；反证的编号在正文与清单两侧对齐（渲染器的证据编号核对
 * 零告警即该项通过）。
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

/** 渲染一份被请求人侧的草案，返回写出的 HTML 与渲染告警。 */
async function render(draft: TemplateDraft): Promise<{ html: string; warnings: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-inv-defense-'))
  dirs.push(dir)
  const schema: TemplateDraftSchema = GENERIC_TEMPLATE_SCHEMAS['invalidation-defense']
  const validated = validateTemplateDraft(draft, schema)
  const result = await renderPatentDocument(
    { template: 'invalidation-defense', outputName: 'defense', outputDir: dir, templateDraft: validated, format: 'html' },
    dir,
    { subprocess: unusedSubprocess() },
  )
  return { html: readFileSync(result.htmlPath, 'utf8'), warnings: result.warnings }
}

const defenseDraft = (): TemplateDraft => ({
  fields: {
    'meta-patent-no': 'CN202320123456.7',
    'meta-patent-title': '一种带自锁机构的货物拉紧器',
    'meta-grant-date': '2023-08-15',
    'meta-patentee': '某某物流装备有限公司',
    'meta-requester': '某某贸易有限公司',
    'meta-request-date': '2026-03-12',
    'meta-transfer-no': '2026-03-28 转送（发文序号 2026xxxxxx）',
    'meta-deadline': '2026-04-28',
    'meta-date': '2026-04-24',
    'position-summary': '请求人的无效宣告理由均不成立，请求维持专利权有效。',
    'conclusion-text': '请求维持本专利权全部有效。',
    'footer-case': 'CN2026-WG-0042',
    'footer-date': '2026-04-24',
  },
  sections: [
    { id: 'doc-number', blocks: [{ kind: 'paragraph', text: 'CN2026-WG-0042' }] },
    { id: 'position-points', blocks: [{ kind: 'list', ordered: true, items: ['权利要求 1 具备创造性。', '权利要求 1 得到说明书支持。'] }] },
    { id: 'procedural-body', blocks: [
      { kind: 'paragraph', text: '请求人具备主体资格，专利权人对请求书形式不提出异议。' },
      { kind: 'paragraph', text: '指定答复期限于 2026 年 4 月 28 日届满，依照专利法实施细则第 75 条不得延长。' },
    ] },
    { id: 'evidence-objection-body', blocks: [
      { kind: 'paragraph', text: '证据 1 为专利文献，专利权人对其真实性无异议。' },
      { kind: 'paragraph', text: '证据 2 为销售发票复印件，请求人未提交原件核对，专利权人对真实性不予认可。' },
    ] },
    { id: 'amendment-basis', blocks: [{ kind: 'paragraph', text: '本次答复未修改权利要求书。' }] },
    { id: 'amendment-table', rows: [['权1–3', '—', '—', '未修改', '—']] },
    {
      id: 'defense-body',
      grounds: [
        {
          article: '专利法第22条第3款',
          ground: '创造性',
          claimNos: [1, 2],
          facts: '请求人主张证据 1 为最接近的现有技术，区别技术特征已被证据 2 公开。',
          evidence: '证据 1 的摆杆为一体结构，没有与棘轮齿面配合的斜面；反证1 表明斜面自锁不是惯用手段。',
          conclusion: '权利要求 1、2 具备创造性，请求人的理由不成立。',
        },
        {
          article: '专利法第26条第4款',
          ground: '说明书支持与清楚',
          claimNos: [1],
          facts: '请求人主张倾角数值范围在说明书中没有记载。',
          evidence: '说明书第 [0021] 段记载了倾角优选 12° 至 18°，该范围能够实现。',
          conclusion: '权利要求 1 得到说明书支持。',
        },
      ],
    },
    { id: 'evidence-table', rows: [['反证1', 'ISBN 978-7-111-XXXXX-X', '《机械设计手册》第 6 版', '2018-03', '公知常识性证据', '第 000 页']] },
    { id: 'claim-conclusion-table', rows: [
      ['权1', '请求维持有效', 'A22.3、A26.4', '见 5.1、5.2'],
      ['权2', '请求维持有效', 'A22.3', '见 5.1'],
    ] },
  ],
})

describe('invalidation-defense：逐项答辩节由结构生成', () => {
  it('节标题取模板体例的关系词，提交几项理由就出几节，四段式小标题随节生成', async () => {
    const { html, warnings } = await render(defenseDraft())

    expect(html).toContain('<h3>5.1 权利要求 1、2 的创造性（专利法第22条第3款）</h3>')
    expect(html).toContain('<h3>5.2 权利要求 1 的说明书支持与清楚（专利法第26条第4款）</h3>')
    expect(html.match(/<h3>\d+\.\d+ 权利要求/g)?.length).toBe(2)
    expect(html).toContain('<h4>事实认定</h4><p>请求人主张证据 1 为最接近的现有技术，区别技术特征已被证据 2 公开。</p>')
    expect(html).toContain('<h4>证据分析</h4>')
    expect(html).toContain('<h4>法条适用与结论</h4><p>权利要求 1、2 具备创造性，请求人的理由不成立。</p>')
    // 被请求人侧不套用请求人侧的关系词。
    expect(html).not.toMatch(/<h3>[^<]*不具备/)
    expect(warnings).toEqual([])
  })

  it('证据编号两侧对齐：反证登记在清单并被正文引用，编号核对零告警', async () => {
    const { html, warnings } = await render(defenseDraft())
    expect(html).toContain('<td class="mono">反证1</td>')
    expect(html).toContain('反证1 表明斜面自锁不是惯用手段')
    expect(warnings).toEqual([])
  })

  it('未修改权利要求书时表 1 登记一行，且件内不含内部工作记录', async () => {
    const { html } = await render(defenseDraft())
    expect(html).toContain('<td>未修改</td>')
    for (const forbidden of ['引用日志', '成功率', '缺口', '模型推断']) {
      expect(html, forbidden).not.toContain(forbidden)
    }
  })
})
