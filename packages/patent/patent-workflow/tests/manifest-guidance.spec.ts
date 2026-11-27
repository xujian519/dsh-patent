import { describe, expect, it } from 'vitest'
import { validateWorkflowManifest } from '@deepseek-ai/dsh-patent-core'
import {
  builtinPatentManifests,
  OA_RESPONSE_DRAFT_BUDGET,
  patentInfringementManifest,
  patentInventivenessManifest,
  patentInvalidationManifest,
  patentOaResponseManifest,
  patentReexaminationManifest,
} from '@deepseek-ai/dsh-patent-workflow'

/** 内置 manifest 目录的完整 id 集（新增作业须在此显式登记）。 */
const EXPECTED_MANIFEST_IDS = [
  'patent_disclosure_v1',
  'patent_infringement_v1',
  'patent_invalidation_v1',
  'patent_inventiveness_v1',
  'patent_novelty_v1',
  'patent_oa_response_v1',
  'patent_patentability_v1',
  'patent_reexamination_v1',
]

const stageOf = (manifestId: string, stageId: string): string | undefined => {
  const manifest = builtinPatentManifests.find(m => m.id === manifestId)
  return manifest?.stages.find(s => s.id === stageId)?.guidance
}

describe('内置 manifest 的阶段法律指引（guidance）', () => {
  it('OA 答复：parse 定为确定性原子；draft 含驳回类型对照表、策略决策树、三层论证纪律与 A33 限制', () => {
    const manifest = builtinPatentManifests.find(m => m.id === 'patent_oa_response_v1')
    const parse = manifest?.stages.find(s => s.id === 'parse')
    expect(parse?.guidance).toBeUndefined()
    const draft = stageOf('patent_oa_response_v1', 'draft')
    expect(draft).toContain('26.3')
    expect(draft).toContain('22.2')
    expect(draft).toContain('单独对比')
    expect(draft).toContain('最核心的驳回理由')
    expect(draft).toContain('纯争辩')
    expect(draft).toContain('放弃答复')
    expect(draft).toContain('机器默认')
    expect(draft).toContain('A33')
    expect(draft).toContain('禁止编造实验数据')
    expect(draft).toContain('事实 → 规则 → 论证')
    expect(draft).toContain('争点')
    expect(draft).toContain('不以通知书审查意见项号铺陈')
    expect(draft).not.toContain('逐条答复每项被驳')
  })

  it('OA 答复：修订轮要求先认定第一次答复是否修改权利要求 1，不得沿用答复计划的机器默认', () => {
    const draft = stageOf('patent_oa_response_v1', 'draft') ?? ''
    // 上游 response-plan 在 claims 无行首编号时把权 1 当从属并给「删除」；
    // 指引必须点名这是机器默认，并要求按 claims 与原权利要求比对后二选一。
    expect(draft).toContain('第一次答复未修改权利要求 1，本次亦不修改')
    expect(draft).toContain('权利要求1（从属）：删除')
    expect(draft).toContain('没有独立权利要求被点出')
    expect(draft).toContain('修改前文本、修改后文本与原说明书或原权利要求书的记载依据')
    // 禁止把两种情形写进同一份答复；该禁令必须点名具体的附条件措辞。
    expect(draft).toMatch(/不得写「删除前次答复中的进一步限定（如有）」/)
    expect(draft).toContain('不得用「如审查员认为……」')
    expect(draft).toContain('总体立场按①纯争辩（不修改）陈述')
    expect(draft).toContain('未修改时写不修改的理由＋权利要求全文')
  })

  it('创造性：closest 缺证据推断规则，diff 技术问题纪律，hint 软件与组合方案边界条件', () => {
    const closest = stageOf('patent_inventiveness_v1', 'closest')
    expect(closest).toContain('边界条件')
    expect(closest).toContain('简单变体')
    const diff = stageOf('patent_inventiveness_v1', 'diff')
    expect(diff).toContain('区别于说明书记载的发明目的')
    const hint = stageOf('patent_inventiveness_v1', 'hint')
    expect(hint).toContain('简单重组')
    expect(hint).toContain('相反教导')
  })

  it('侵权 report 含等同三限制与风险等级输出要求', () => {
    const report = stageOf('patent_infringement_v1', 'report')
    expect(report).toContain('禁止反悔')
    expect(report).toContain('捐献')
    expect(report).toContain('现有技术抗辩')
    expect(report).toContain('手段-功能-效果')
    expect(report).toContain('风险等级')
  })

  it('OA 答复：draft 同时给出篇幅预算与删减三禁令，数值由预算常量插值', () => {
    const draft = stageOf('patent_oa_response_v1', 'draft') ?? ''
    // 数字一律经 OA_RESPONSE_DRAFT_BUDGET 插值：改常量必须传导到提示文字，
    // 否则会出现「文案写 4000、校验按 5000」的两套数。
    for (const line of [
      `正文总量 ≤ ${OA_RESPONSE_DRAFT_BUDGET.total} 字`,
      `一、总体立场 ≤ ${OA_RESPONSE_DRAFT_BUDGET.position} 字`,
      `3.1 与 3.2 各 ≤ ${OA_RESPONSE_DRAFT_BUDGET.factItems} 项，每项 ≤ ${OA_RESPONSE_DRAFT_BUDGET.factSentences} 句`,
      `R 条 ≤ ${OA_RESPONSE_DRAFT_BUDGET.ruleItems} 条`,
      `5.1 ≤ ${OA_RESPONSE_DRAFT_BUDGET.argumentNovelty} 字，5.2 ≤ ${OA_RESPONSE_DRAFT_BUDGET.argumentInventiveness} 字`,
      `5.3 ≤ ${OA_RESPONSE_DRAFT_BUDGET.otherIssues} 条`,
      `八、结论与请求 ≤ ${OA_RESPONSE_DRAFT_BUDGET.conclusion} 字`,
    ]) {
      expect(draft).toContain(line)
    }
    // 负控制：三条禁令必须同时在场，且保持「不复述 → 不重述 → 不重引」的顺序。
    // 删掉任何一条，这个整体匹配就不再命中。
    expect(draft).toMatch(
      /删减三禁令[\s\S]*不复述上游产物[\s\S]*同一结论不在三处改写[\s\S]*同一段原文只整段引用一次/,
    )
    expect(draft).toContain('审查意见未提出的争点不设节')
    expect(draft).toContain('由模板折叠')
    // 检索方案一节最易膨胀：只约束"一组一行"，不约束具体措辞。
    expect(draft).toContain('七、证据与引用')
    // 位置：预算段排在「输出顺序」之后，即紧邻材料注入处——放在指引中段会被
    // 后面几万字的上游产物冲淡。
    expect(draft.lastIndexOf('篇幅预算')).toBeGreaterThan(draft.lastIndexOf('输出顺序'))
  })

  it('全部内置 manifest 通过校验且已声明的 guidance 均非空', () => {
    for (const manifest of builtinPatentManifests) {
      validateWorkflowManifest(manifest)
      for (const stage of manifest.stages) {
        if (stage.guidance !== undefined) expect(stage.guidance.trim()).not.toBe('')
      }
    }
    // 批次二声明了 guidance 的三个 manifest 在目录中且可按 id 检索
    for (const id of ['patent_oa_response_v1', 'patent_inventiveness_v1', 'patent_infringement_v1']) {
      expect(builtinPatentManifests.some(m => m.id === id)).toBe(true)
    }
  })

  it('模块级导出的 manifest 与目录中的实例一致', () => {
    const pairs = [
      [patentOaResponseManifest, 'patent_oa_response_v1'],
      [patentInventivenessManifest, 'patent_inventiveness_v1'],
      [patentInfringementManifest, 'patent_infringement_v1'],
      [patentInvalidationManifest, 'patent_invalidation_v1'],
      [patentReexaminationManifest, 'patent_reexamination_v1'],
    ] as const
    for (const [manifest, id] of pairs) {
      expect(manifest.id).toBe(id)
      expect(builtinPatentManifests.find(entry => entry.id === id)).toBe(manifest)
    }
  })

  it('目录覆盖八个作业且 id 唯一', () => {
    const ids = builtinPatentManifests.map(manifest => manifest.id)
    expect([...ids].sort()).toEqual(EXPECTED_MANIFEST_IDS)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
