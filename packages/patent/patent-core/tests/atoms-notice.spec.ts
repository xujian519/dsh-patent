import { describe, expect, it } from 'vitest'
import {
  GROUND_PROGRAMS,
  LookupStageHandler,
  registerBuiltinAtoms,
  type GroundFinding,
  type ParsedOfficeAction,
} from '@deepseek-ai/dsh-patent-core'

registerBuiltinAtoms()

const OA_TEXT = [
  '权利要求1-5不具备创造性，不符合专利法第22条第3款的规定。',
  '对比文件1（CN112345678A，Y类）公开了权利要求1的前序特征。',
  '审查员认为：本领域技术人员有动机将对比文件1与公知常识结合。',
].join('\n')

const run = async (name: string, state: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const handler = LookupStageHandler(name)
  if (handler === undefined) throw new Error(`未注册的原子: ${name}`)
  return await handler.execute({ state })
}

describe('oa-parse 原子', () => {
  it('解析通知书：输出结构化事实与中文摘要', async () => {
    const out = await run('oa-parse', { input: OA_TEXT })
    const parsed = JSON.parse(String(out.office_action)) as ParsedOfficeAction
    expect(parsed.rejectionType).toBe('inventiveness')
    expect(parsed.affectedClaims).toEqual([1, 2, 3, 4, 5])
    expect(parsed.citations.map(c => c.documentNumber)).toEqual(['CN112345678A'])
    expect(parsed.citations[0]?.relevancy).toBe('Y')
    expect(parsed.examinerArguments.length).toBeGreaterThan(0)
    expect(String(out.office_action_summary)).toContain('创造性（专利法第22条第3款）')
    expect(String(out.office_action_summary)).toContain('影响权利要求: 1, 2, 3, 4, 5')
    // #653：oa-parse 作为 reference_documents 生产者，把引用文献写成可读文本供换位审查消费。
    expect(String(out.reference_documents)).toContain('CN112345678A')
  })

  it('正文为空时降级并归因到原子', async () => {
    const out = await run('oa-parse', { input: '   ' })
    expect(String(out._error)).toContain('[oa-parse]')
    expect(String(out._error)).toContain('通知书正文为空')
  })
})

describe('grounds 原子', () => {
  it('无效：命中无效理由表并给出法条依据', async () => {
    const out = await run('grounds', {
      input: '请求人主张权利要求1不具备创造性（专利法第22条第3款），且修改超出原说明书范围（第33条）。',
      ground_program: 'invalidation',
    })
    const findings = JSON.parse(String(out.grounds)) as GroundFinding<string>[]
    expect(findings.map(f => f.ground)).toEqual(['inventiveness', 'amendment'])
    expect(String(out.grounds_summary)).toContain('创造性无效（不具备创造性）（专利法第22条第3款）')
    expect(out.patent_subject).toBeUndefined()
  })

  it('复审：另判专利权类型（实用新型）并保留客体缺陷理由', async () => {
    const out = await run('grounds', {
      input: '本实用新型不具备创造性，且不属于实用新型的保护客体（第2条第3款）。',
      ground_program: 'reexamination',
    })
    const findings = JSON.parse(String(out.grounds)) as GroundFinding<string>[]
    expect(findings.map(f => f.ground)).toEqual(['inventiveness', 'utility-model-subject-matter'])
    expect(out.patent_subject).toBe('utility-model')
  })

  it('外观设计：用外观设计理由表', async () => {
    const out = await run('grounds', {
      input: '本外观设计相对于现有设计不具有明显区别，不符合专利法第23条第1款。',
      ground_program: 'design',
    })
    const findings = JSON.parse(String(out.grounds)) as GroundFinding<string>[]
    expect(findings.map(f => f.ground)).toEqual(['not-prior-design'])
    expect(out.patent_subject).toBeUndefined()
  })

  it('否定表述在摘要中标注，不读作已主张理由', async () => {
    const out = await run('grounds', {
      input: '请求人未主张权利要求1不具备新颖性，但主张权利要求1不具备创造性。',
      ground_program: 'invalidation',
    })
    const findings = JSON.parse(String(out.grounds)) as GroundFinding<string>[]
    expect(findings.map(finding => [finding.ground, finding.negated])).toEqual([
      ['novelty', true],
      ['inventiveness', false],
    ])
    expect(String(out.grounds_summary)).toContain(
      '新颖性无效（不具备新颖性）（专利法第22条第2款，文中为否定表述）',
    )
    expect(String(out.grounds_summary)).toContain('创造性无效（不具备创造性）（专利法第22条第3款）')
    expect(String(out.grounds_summary)).not.toContain('创造性无效（不具备创造性）（专利法第22条第3款，文中为否定表述）')
  })

  it('未命中理由时不造理由，摘要明示须人工判读', async () => {
    const out = await run('grounds', { input: '请求人请求宣告专利权无效。', ground_program: 'invalidation' })
    expect(JSON.parse(String(out.grounds))).toEqual([])
    expect(String(out.grounds_summary)).toContain('未识别到具体法条依据')
  })

  it('ground_program 缺失或非法时降级并说明取值域，不猜理由表', async () => {
    const missing = await run('grounds', { input: OA_TEXT })
    expect(String(missing._error)).toContain('[grounds]')
    expect(String(missing._error)).toContain('(缺失)')
    expect(String(missing._error)).toContain(GROUND_PROGRAMS.join(' / '))

    const invalid = await run('grounds', { input: OA_TEXT, ground_program: 'appeal' })
    expect(String(invalid._error)).toContain('appeal')
    expect(invalid.grounds).toBeUndefined()
  })

  it('正文为空时降级', async () => {
    const out = await run('grounds', { input: '', ground_program: 'design' })
    expect(String(out._error)).toContain('程序文书正文为空')
  })
})

describe('response-plan 原子', () => {
  const OA_INVENTIVENESS = [
    '权利要求1-5不具备创造性，不符合专利法第22条第3款的规定。',
    '对比文件1（CN112345678A，Y类）公开了权利要求1的前序特征。',
  ].join('\n')

  it('由解析产出拼装计划骨架（策略摘要与必答段落）', async () => {
    const parsed = await run('oa-parse', { input: OA_INVENTIVENESS })
    const out = await run('response-plan', {
      office_action: parsed.office_action,
      claims: '1. 一种装置，包括壳体。\n2. 根据权利要求1所述的装置，其特征在于还包括滤芯。',
    })
    const text = String(out.response_plan)
    expect(text).toContain('策略摘要：创造性→争辩')
    expect(text).toContain('- 创造性（争辩）：最接近的现有技术')
    expect(String(out.response_plan_summary)).toBe('创造性→争辩')
  })

  it('修改类理由：独立/从属检测进入逐权项修改对照', async () => {
    const parsed = await run('oa-parse', {
      input: '权利要求1和权利要求2的保护范围不清楚，不符合专利法第26条第4款的规定。',
    })
    const out = await run('response-plan', {
      office_action: parsed.office_action,
      claims: '1. 一种装置，包括壳体。\n2. 根据权利要求1所述的装置，其特征在于还包括滤芯。',
    })
    const text = String(out.response_plan)
    expect(text).toContain('- 权利要求1（独立）：澄清限定')
    expect(text).toContain('- 权利要求2（从属）：从属引用调整')
  })

  it('解析产出缺少 affectedClaims 或不是合法 JSON 时降级', async () => {
    const noClaims = await run('response-plan', {
      office_action: JSON.stringify({
        rejectionType: 'inventiveness',
        rejectionTypes: ['inventiveness'],
        citations: [],
      }),
    })
    expect(String(noClaims._error)).toContain('缺少 affectedClaims 数组')

    const invalid = await run('response-plan', { office_action: '{"rejectionType":' })
    expect(String(invalid._error)).toContain('不是合法 JSON')
  })

  it('缺少解析产出时降级（不猜计划）', async () => {
    const out = await run('response-plan', { claims: '1. 一种装置。' })
    expect(String(out._error)).toContain('[response-plan]')
    expect(String(out._error)).toContain('缺少解析结果')
  })
})
