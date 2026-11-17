import { describe, expect, it } from 'vitest'
import { AdversaryModelHandler } from '@deepseek-ai/dsh-patent-core'
import { adversaryModelAtom } from '../src/atoms/handlers/builtin/adversary-model.ts'
import { assessEvidenceIndependent } from '../src/adversary/assessment.ts'
import { buildAdversaryPrompt } from '../src/adversary/prompt.ts'
import {
  buildAdversaryReport,
  degradedSummary,
  renderAdversaryReport,
} from '../src/adversary/report.ts'
import {
  checkInputIsolation,
  FORBIDDEN_KEYS,
  FORBIDDEN_OUTPUT_TERMS,
  scanOutputForLeaks,
} from '../src/adversary/isolation-check.ts'
import { computeOverallConfidence, detectDivergence } from '../src/adversary/divergence.ts'
import { locateDisputesIndependent } from '../src/adversary/dispute.ts'
import { parseAdversaryOutput } from '../src/adversary/parse.ts'
import type { AdversaryDispute, StageProvider } from '@deepseek-ai/dsh-patent-core'
import type { AdversaryOfficeAction, AdversaryPlanEntry } from '../src/adversary/types.ts'

describe('adversary-model atom', () => {
  it('atom 声明正确', () => {
    expect(adversaryModelAtom.name).toBe('adversary-model')
    expect(adversaryModelAtom.category).toBe('gate')
    expect(adversaryModelAtom.usesModel).toBe(true)
    expect(adversaryModelAtom.inputSchema).toEqual([
      'office_action',
      'claims',
      'response_plan',
      'response_plan_summary',
    ])
    expect(adversaryModelAtom.outputSchema).toEqual([
      'adversary_report',
      'adversary_disputes',
      'adversary_confidence',
    ])
    // 信息隔离：不包含己方中间推理键
    expect(adversaryModelAtom.inputSchema).not.toContain('dispute_framing_report')
    expect(adversaryModelAtom.inputSchema).not.toContain('claim_chart')
    expect(adversaryModelAtom.inputSchema).not.toContain('draft')
  })

  it('handler 名称与 atom 一致', () => {
    const handler = new AdversaryModelHandler()
    expect(handler.name).toBe('adversary-model')
    expect(handler.category).toBe('gate')
  })
})

describe('独立争议定位', () => {
  it('从通知书结构化字段识别争议法条', () => {
    const officeAction: AdversaryOfficeAction = {
      rejectionTypes: ['inventiveness', 'claim-clarity'],
      affectedClaims: [1, 2],
    }
    const disputes = locateDisputesIndependent(officeAction, '')
    expect(disputes.length).toBe(2)
    expect(disputes.map(d => d.statute).sort()).toEqual(['A22.3', 'A26.4'])
    expect(disputes[0]?.claims).toEqual([1, 2])
    expect(disputes[0]?.tag).toBe('heuristic')
  })

  it('识别 oa-parse 输出的 clarity/support/scope 驳回类型', () => {
    const officeAction: AdversaryOfficeAction = {
      rejectionTypes: ['clarity', 'support', 'scope', 'formal'],
      affectedClaims: [1],
    }
    const disputes = locateDisputesIndependent(officeAction, '')
    expect(disputes.map(d => d.statute).sort()).toEqual(['A26.4', 'A33'])
  })

  it('无通知书时从正文扫描', () => {
    const disputes = locateDisputesIndependent(undefined, '权利要求1-3不具备创造性，不符合专利法第22条第3款')
    expect(disputes.length).toBeGreaterThan(0)
    expect(disputes.some(d => d.statute === 'A22.3')).toBe(true)
    expect(disputes[0]?.tag).toBe('unverified')
  })

  it('无法映射的驳回类型被跳过', () => {
    const officeAction: AdversaryOfficeAction = {
      rejectionTypes: ['unknown-ground'],
      affectedClaims: [1],
    }
    const disputes = locateDisputesIndependent(officeAction, '')
    expect(disputes.length).toBe(0)
  })
})

describe('独立证据评估', () => {
  it('检测答复计划未覆盖的驳回理由', () => {
    const officeAction: AdversaryOfficeAction = {
      rejectionTypes: ['inventiveness', 'novelty'],
      affectedClaims: [1, 2],
    }
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
    ]
    const disputes = assessEvidenceIndependent(officeAction, responsePlan)
    expect(disputes.some(d => d.statute === 'A22.2' && d.relation === 'disagreement')).toBe(true)
  })

  it('检测权项不对齐', () => {
    const officeAction: AdversaryOfficeAction = {
      rejectionTypes: ['inventiveness'],
      affectedClaims: [1, 2],
    }
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [3, 4] },
    ]
    const disputes = assessEvidenceIndependent(officeAction, responsePlan)
    expect(disputes.some(d => d.relation === 'disagreement')).toBe(true)
  })

  it('无输入时返回空', () => {
    expect(assessEvidenceIndependent(undefined, [])).toEqual([])
    expect(assessEvidenceIndependent({ rejectionTypes: [] }, undefined)).toEqual([])
  })
})

describe('分歧检测', () => {
  it('标记 agreement：基线覆盖的法条', () => {
    const disputes: AdversaryDispute[] = [
      {
        statute: 'A22.3',
        claims: [1, 2],
        point: '创造性',
        relation: 'missed_by_baseline',
        confidence: 0.8,
        tag: 'heuristic',
      },
    ]
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
    ]
    const marked = detectDivergence(disputes, responsePlan)
    expect(marked[0]?.relation).toBe('agreement')
  })

  it('标记 missed_by_baseline：基线未覆盖的法条', () => {
    const disputes: AdversaryDispute[] = [
      {
        statute: 'A22.2',
        claims: [1],
        point: '新颖性',
        relation: 'missed_by_baseline',
        confidence: 0.8,
        tag: 'heuristic',
      },
    ]
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1] },
    ]
    const marked = detectDivergence(disputes, responsePlan)
    expect(marked[0]?.relation).toBe('missed_by_baseline')
  })

  it('保持 disagreement：证据评估已标记的分歧', () => {
    const disputes: AdversaryDispute[] = [
      {
        statute: 'A22.3',
        claims: [3, 4],
        point: '权项不对齐',
        relation: 'disagreement',
        divergenceReason: '策略权项与通知书涉及权项不对齐',
        confidence: 0.7,
        tag: 'heuristic',
      },
    ]
    const marked = detectDivergence(disputes, [{ ground: 'inventiveness', strategy: 'amend', claims: [1, 2] }])
    expect(marked[0]?.relation).toBe('disagreement')
  })
})

describe('整体置信度', () => {
  it('无争议点时返回 0', () => {
    expect(computeOverallConfidence([])).toBe(0)
  })

  it('加权平均', () => {
    const disputes: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '', relation: 'agreement', confidence: 0.8, tag: 'heuristic' },
      { statute: 'A26.4', claims: [2], point: '', relation: 'agreement', confidence: 0.6, tag: 'heuristic' },
    ]
    const confidence = computeOverallConfidence(disputes)
    // (0.8^2 + 0.6^2) / (0.8 + 0.6) = (0.64 + 0.36) / 1.4 = 1.0 / 1.4 ≈ 0.714
    expect(confidence).toBeCloseTo(0.714, 2)
  })
})

describe('报告生成', () => {
  it('聚合报告结构正确', () => {
    const disputes: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '创造性', relation: 'agreement', confidence: 0.8, tag: 'heuristic' },
      { statute: 'A22.2', claims: [2], point: '新颖性', relation: 'missed_by_baseline', confidence: 0.9, tag: 'heuristic' },
      { statute: 'A26.4', claims: [3], point: '权项不对齐', relation: 'disagreement', confidence: 0.7, tag: 'heuristic', divergenceReason: 'test' },
      { statute: 'A33', claims: [4], point: '未验证', relation: 'missed_by_baseline', confidence: 0.3, tag: 'unverified' },
    ]
    const report = buildAdversaryReport(disputes, '测试摘要')
    expect(report.disputes.length).toBe(4)
    expect(report.agreements.length).toBe(1)
    expect(report.missedByBaseline.length).toBe(2)
    expect(report.disagreements.length).toBe(1)
    expect(report.unverified.length).toBe(1)
    expect(report.summary).toBe('测试摘要')
    expect(report.overallConfidence).toBeGreaterThan(0)
  })

  it('渲染报告包含分类信息', () => {
    const disputes: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '创造性', relation: 'agreement', confidence: 0.8, tag: 'heuristic' },
    ]
    const report = buildAdversaryReport(disputes, '摘要')
    const text = renderAdversaryReport(report)
    expect(text).toContain('对抗式检验报告')
    expect(text).toContain('一致 1')
    expect(text).toContain('限制说明')
  })

  it('降级摘要', () => {
    expect(degradedSummary([])).toBe('模型不可用，未识别到争议点。')
    const unverified: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '', relation: 'missed_by_baseline', confidence: 0.3, tag: 'unverified' },
    ]
    expect(degradedSummary(unverified)).toContain('均为未验证占位')
  })
})

describe('handler execute', () => {
  it('完整流程：读取输入、生成报告', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1, 2],
      }),
      claims: '权利要求1-2',
      response_plan: JSON.stringify([
        { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
      ]),
      response_plan_summary: '修改权利要求1-2',
    }
    const result = await handler.execute({ state })
    expect(result.adversary_report).toBeDefined()
    expect(typeof result.adversary_report).toBe('string')
    expect(result.adversary_disputes).toBeDefined()
    expect(Array.isArray(result.adversary_disputes)).toBe(true)
    expect(typeof result.adversary_confidence).toBe('number')
  })

  it('无输入时仍生成报告', async () => {
    const handler = new AdversaryModelHandler()
    const result = await handler.execute({ state: {} })
    expect(result.adversary_report).toBeDefined()
    expect(result.adversary_disputes).toEqual([])
    expect(result.adversary_confidence).toBe(0)
  })

  it('模型不可用时 fail-closed：使用确定性结果 + 降级摘要', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1, 2],
      }),
      claims: '权利要求1-2',
      response_plan: JSON.stringify([
        { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
      ]),
    }
    const result = await handler.execute({ state, provider: {} })
    expect(result.adversary_report).toBeDefined()
    expect(result.adversary_report).toContain('模型不可用')
    expect(result.adversary_confidence).toBeGreaterThan(0)
  })

  it('模型调用成功：解析模型输出并合并结果', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness', 'claim-clarity'],
        affectedClaims: [1, 2],
      }),
      claims: '权利要求1-2',
      response_plan: JSON.stringify([
        { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
      ]),
    }
    const modelOutput = JSON.stringify({
      disputes: [
        {
          statute: 'A22.3',
          claims: [1, 2],
          point: '创造性评估',
          weakness: '证据支撑不足',
          confidence: 0.85,
        },
      ],
      overall_assessment: '答复计划基本覆盖驳回理由，但创造性论证需加强。',
      divergence_reason: '模型识别到答复计划未充分论证技术效果。',
    })
    const provider: StageProvider = { callLLM: async () => modelOutput }
    const result = await handler.execute({ state, provider })
    expect(result.adversary_report).toBeDefined()
    expect(result.adversary_report).toContain('创造性评估')
    expect(result.adversary_report).toContain('证据支撑不足')
    expect(result.adversary_confidence).toBeGreaterThan(0)
  })

  it('accepts the examiner-argument array that oa-parse writes', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1],
        examinerArguments: ['第一段审查意见。', '第二段审查意见。'],
      }),
      claims: '权利要求1',
      response_plan: JSON.stringify([{ ground: 'inventiveness', strategy: 'amend', claims: [1] }]),
    }
    let prompt = ''
    const provider: StageProvider = {
      callLLM: async (request: string) => {
        prompt = request
        return '{"disputes":[],"overall_assessment":"整体评估"}'
      },
    }
    const result = await handler.execute({ state, provider })
    expect(result.adversary_report).toBeDefined()
    expect(prompt).toContain('第一段审查意见。')
    expect(prompt).toContain('第二段审查意见。')
  })

  it('模型输出含禁止术语时丢弃并回退到确定性结果', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({ rejectionTypes: ['inventiveness'], affectedClaims: [1] }),
      claims: '权利要求1',
      response_plan: JSON.stringify([{ ground: 'inventiveness', strategy: 'amend', claims: [1] }]),
    }
    const modelOutput = JSON.stringify({
      disputes: [{ statute: 'A22.3', claims: [1], point: '参考 claim_chart 的映射', confidence: 0.9 }],
      overall_assessment: '整体评估',
    })
    const provider: StageProvider = { callLLM: async () => modelOutput }
    const result = await handler.execute({ state, provider })
    expect(result.adversary_report).toContain('禁止术语')
    expect(result.adversary_report).not.toContain('claim_chart 的映射')
  })

  it('模型输出解析失败时降级到确定性结果', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1],
      }),
      claims: '权利要求1',
      response_plan: JSON.stringify([
        { ground: 'inventiveness', strategy: 'amend', claims: [1] },
      ]),
    }
    const provider: StageProvider = { callLLM: async () => '这不是有效的 JSON' }
    const result = await handler.execute({ state, provider })
    expect(result.adversary_report).toBeDefined()
    expect(result.adversary_report).toContain('模型不可用')
  })

  it('LLM 调用失败时降级', async () => {
    const handler = new AdversaryModelHandler()
    const state = {
      office_action: JSON.stringify({
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1],
      }),
      claims: '权利要求1',
      response_plan: JSON.stringify([
        { ground: 'inventiveness', strategy: 'amend', claims: [1] },
      ]),
    }
    const provider: StageProvider = { callLLM: async () => { throw new Error('LLM timeout') } }
    const result = await handler.execute({ state, provider })
    expect(String(result._error)).toMatch(/LLM 调用失败/)
  })
})

// =============================================================================
// 信息隔离检查（Spike 结论：三重检查确保隔离严格）
// =============================================================================

describe('信息隔离检查', () => {
  describe('声明层：inputSchema 不包含禁止键', () => {
    it('inputSchema 不包含所有 FORBIDDEN_KEYS', () => {
      for (const key of FORBIDDEN_KEYS) {
        expect(adversaryModelAtom.inputSchema).not.toContain(key)
      }
    })
  })

  describe('运行时层：checkInputIsolation', () => {
    it('无禁止键时返回 clean=true', () => {
      const stateKeys = ['office_action', 'claims', 'response_plan']
      const result = checkInputIsolation(stateKeys)
      expect(result.clean).toBe(true)
      expect(result.leakedKeys).toEqual([])
    })

    it('检测到单个禁止键时 fail-closed', () => {
      const stateKeys = ['office_action', 'dispute_framing_report', 'claims']
      const result = checkInputIsolation(stateKeys)
      expect(result.clean).toBe(false)
      expect(result.leakedKeys).toEqual(['dispute_framing_report'])
    })

    it('检测到多个禁止键', () => {
      const stateKeys = ['claim_chart', 'draft', 'office_action']
      const result = checkInputIsolation(stateKeys)
      expect(result.clean).toBe(false)
      expect(result.leakedKeys).toContain('claim_chart')
      expect(result.leakedKeys).toContain('draft')
    })

    it('共享 state 含上游中间产物时仍正常评估', async () => {
      const handler = new AdversaryModelHandler()
      const state = {
        office_action: JSON.stringify({ rejectionTypes: ['inventiveness'], affectedClaims: [1] }),
        claims: '权利要求1',
        response_plan: JSON.stringify([{ ground: 'inventiveness', strategy: 'amend', claims: [1] }]),
        dispute_framing_report: '己方推理',
        claim_chart: '己方映射',
        draft: '己方草稿',
      }
      const result = await handler.execute({ state })
      expect(result.adversary_report).not.toContain('信息隔离检查失败')
      expect(result.adversary_confidence).toBeGreaterThan(0)
    })
  })

  describe('输出层：scanOutputForLeaks', () => {
    it('正常报告不包含禁止术语', () => {
      const report = '这是一份正常的对抗式检验报告，包含创造性分析。'
      const result = scanOutputForLeaks(report)
      expect(result.clean).toBe(true)
      expect(result.leakedKeys).toEqual([])
    })

    it('检测到禁止术语时返回泄漏列表', () => {
      const report = '报告包含 dispute_framing 相关内容'
      const result = scanOutputForLeaks(report)
      expect(result.clean).toBe(false)
      expect(result.leakedKeys).toContain('dispute_framing')
    })

    it('检测到多个禁止术语', () => {
      const report = '报告包含 claim_chart 和己方推理内容'
      const result = scanOutputForLeaks(report)
      expect(result.clean).toBe(false)
      expect(result.leakedKeys).toContain('claim_chart')
      expect(result.leakedKeys).toContain('己方推理')
    })

    it('支持自定义禁止术语列表', () => {
      const customTerms = ['自定义禁止词']
      const report = '包含自定义禁止词的文本'
      const result = scanOutputForLeaks(report, customTerms)
      expect(result.clean).toBe(false)
      expect(result.leakedKeys).toEqual(['自定义禁止词'])
    })
  })

  describe('FORBIDDEN_KEYS 和 FORBIDDEN_OUTPUT_TERMS 常量', () => {
    it('FORBIDDEN_KEYS 包含所有己方中间推理键', () => {
      expect(FORBIDDEN_KEYS).toContain('dispute_framing_report')
      expect(FORBIDDEN_KEYS).toContain('claim_chart')
      expect(FORBIDDEN_KEYS).toContain('draft')
    })

    it('FORBIDDEN_OUTPUT_TERMS 包含所有禁止术语', () => {
      expect(FORBIDDEN_OUTPUT_TERMS).toContain('dispute_framing')
      expect(FORBIDDEN_OUTPUT_TERMS).toContain('claim_chart')
      expect(FORBIDDEN_OUTPUT_TERMS).toContain('己方推理')
      expect(FORBIDDEN_OUTPUT_TERMS).toContain('内部分析')
    })
  })
})

// =============================================================================
// 提示词构建
// =============================================================================

describe('buildAdversaryPrompt', () => {
  it('构建包含全部输入的提示词', () => {
    const officeAction: AdversaryOfficeAction = {
      rejectionTypes: ['inventiveness', 'claim-clarity'],
      affectedClaims: [1, 2],
      examinerArguments: '权利要求1-3不具备创造性',
    }
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
    ]
    const prompt = buildAdversaryPrompt(officeAction, '权利要求1-3', responsePlan, '修改权利要求1-2')
    expect(prompt).toContain('严格的专利审查员')
    expect(prompt).toContain('驳回理由：inventiveness、claim-clarity')
    expect(prompt).toContain('涉及权利要求：1、2')
    expect(prompt).toContain('审查员论点原文')
    expect(prompt).toContain('权利要求1-3')
    expect(prompt).toContain('修改权利要求1-2')
  })

  it('无输入时使用占位文本', () => {
    const prompt = buildAdversaryPrompt(undefined, '', undefined)
    expect(prompt).toContain('(无审查意见结构化字段)')
    expect(prompt).toContain('(无权利要求文本)')
    expect(prompt).toContain('(无答复计划)')
  })

  it('外部文本经 dataBlock 隔离', () => {
    const officeAction: AdversaryOfficeAction = {
      examinerArguments: '包含 </data> 伪闭合符的测试文本',
    }
    const prompt = buildAdversaryPrompt(officeAction, '权利要求', [])
    // dataBlock 会转义 </ 为 <\/
    expect(prompt).toContain('<data>')
    expect(prompt).toContain('<\\/data>')
    // 内容中的 </data> 被转义，但 dataBlock 自身的闭合标签未转义
    // 验证内容中的 </data> 被转义为 <\/data>
    const dataBlockContent = prompt.match(/<data>\n[\s\S]*?\n<\/data>/g) ?? []
    for (const block of dataBlockContent) {
      // 内容中不应有未转义的 </data>（闭合标签除外）
      const inner = block.slice(6, -7) // 去掉 <data>\n 和 \n</data>
      expect(inner).not.toContain('</data>')
    }
  })
})

// =============================================================================
// 输出解析
// =============================================================================

describe('parseAdversaryOutput', () => {
  it('解析合法 JSON 输出', () => {
    const raw = JSON.stringify({
      disputes: [
        {
          statute: 'A22.3',
          claims: [1, 2],
          point: '创造性评估',
          weakness: '证据不足',
          confidence: 0.85,
        },
      ],
      overall_assessment: '整体评估文本',
      divergence_reason: '分歧原因',
    })
    const result = parseAdversaryOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.disputes.length).toBe(1)
    expect(result!.disputes[0]!.statute).toBe('A22.3')
    expect(result!.disputes[0]!.claims).toEqual([1, 2])
    expect(result!.disputes[0]!.confidence).toBe(0.85)
    expect(result!.overallAssessment).toBe('整体评估文本')
    expect(result!.divergenceReason).toBe('分歧原因')
  })

  it('解析 markdown 代码围栏包裹的 JSON', () => {
    const raw = '```json\n{"disputes": [], "overall_assessment": "ok", "divergence_reason": ""}\n```'
    const result = parseAdversaryOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.disputes).toEqual([])
  })

  it('非法 JSON 返回 null', () => {
    expect(parseAdversaryOutput('这不是 JSON')).toBeNull()
    expect(parseAdversaryOutput('')).toBeNull()
  })

  it('缺少 disputes 数组返回 null', () => {
    expect(parseAdversaryOutput('{"other": 1}')).toBeNull()
  })

  it('过滤非法争议点', () => {
    const raw = JSON.stringify({
      disputes: [
        { statute: 'A22.3', point: '有效', confidence: 0.8 },
        { statute: '', point: '无效：空 statute' },
        { point: '无效：缺少 statute' },
        '非对象元素',
        null,
      ],
      overall_assessment: 'ok',
    })
    const result = parseAdversaryOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.disputes.length).toBe(1)
    expect(result!.disputes[0]!.statute).toBe('A22.3')
  })

  it('非法 confidence 默认 0.5', () => {
    const raw = JSON.stringify({
      disputes: [{ statute: 'A22.3', point: 'test', confidence: 2.0 }],
      overall_assessment: '',
    })
    const result = parseAdversaryOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.disputes[0]!.confidence).toBe(0.5)
  })

  it('weakness 合并到 point', () => {
    const raw = JSON.stringify({
      disputes: [{ statute: 'A22.3', point: '争议点', weakness: '薄弱环节' }],
      overall_assessment: '',
    })
    const result = parseAdversaryOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.disputes[0]!.point).toContain('争议点')
    expect(result!.disputes[0]!.point).toContain('薄弱环节')
    expect(result!.disputes[0]!.divergenceReason).toBe('薄弱环节')
  })
})
