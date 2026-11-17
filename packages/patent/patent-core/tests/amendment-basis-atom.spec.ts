import { describe, expect, it } from 'vitest'
import { AmendmentBasisHandler, amendmentBasisAtom } from '../src/atoms/handlers/builtin/amendment-basis.ts'
import type { AmendmentBasisViolation } from '../src/atoms/handlers/builtin/amendment-basis.ts'

const handler = new AmendmentBasisHandler()

const ORIGINAL_CLAIMS = '1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔。'

const amendedDraft = (claim: string): string =>
  ['修改后权利要求书：', claim, '', '意见陈述：', '对比文件1未公开散热孔。'].join('\n')

const violations = (out: Record<string, unknown>): AmendmentBasisViolation[] =>
  out.amendment_basis_violations as AmendmentBasisViolation[]

describe('amendment-basis atom', () => {
  it('声明的输出以报告为主输出，分类为 gate', () => {
    expect(amendmentBasisAtom.name).toBe('amendment-basis')
    expect(amendmentBasisAtom.category).toBe('gate')
    expect(amendmentBasisAtom.outputSchema[0]).toBe('amendment_basis_report')
    expect(amendmentBasisAtom.inputSchema).toContain('draft')
    expect(amendmentBasisAtom.inputSchema).toContain('claims')
  })

  it('未检测到修改后权利要求段 → 通过（A33 不适用）', async () => {
    const out = await handler.execute({
      state: { draft: '意见陈述：本申请具备创造性，未修改权利要求。' },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
    expect(out.amendment_basis_report).toContain('A33 不适用')
    expect(out.amendment_basis_scope).toBe('未检测到修改后权利要求')
  })

  it('修改后权项与原权项一致 → 通过', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
    expect(out.amendment_basis_report).toContain('通过')
  })

  it('新增特征在原权利要求书中记载 → 通过', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '散热孔和过滤网。')),
        claims: ORIGINAL_CLAIMS,
        description: '所述壳体上设置有散热孔和过滤网。',
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('新增特征只在原说明书中记载 → 通过（说明书也是 A33 依据）', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(
          '1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔，所述壳体内设置有不锈钢材质的过滤网。',
        ),
        claims: ORIGINAL_CLAIMS,
        description: '本申请提供一种装置，壳体内设置有不锈钢材质的过滤网。',
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('新增未记载技术特征 → 未通过（A33 拒绝路径）', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(
          '1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔，所述壳体内设置有不锈钢材质的过滤网。',
        ),
        claims: ORIGINAL_CLAIMS,
        description: '本申请提供一种装置，壳体上设置有散热孔。',
      },
    })
    expect(out.amendment_basis_passed).toBe(false)
    expect(violations(out)).toHaveLength(1)
    expect(violations(out)[0]?.claimNo).toBe('1')
    expect(violations(out)[0]?.addedSpan).toContain('不锈钢材质的过滤网')
    expect(out.amendment_basis_report).toContain('未通过')
    expect(out.amendment_basis_report).toContain('未在原申请文件中记载')
  })

  it('插入单字否定词 → 未通过（单字也改变限定方向）', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('设置有散热孔。', '不设置有散热孔。')),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(false)
    expect(violations(out)).toHaveLength(1)
    expect(violations(out)[0]?.addedSpan).toBe('不')
    expect(out.amendment_basis_report).toContain('未在原申请文件中记载')
  })

  it('单字新增连同相邻上下文有记载 → 通过', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '散热孔组。')),
        claims: ORIGINAL_CLAIMS,
        description: '所述壳体上设置有散热孔组。',
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('仅插入虚词的单字片段 → 忽略', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('壳体上设置', '壳体上和设置')),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('新增从属权项且特征未记载 → 按新权项编号报告', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft('5. 一种装置，其特征在于，还包括太阳能板。'),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(false)
    expect(violations(out).map(item => item.claimNo)).toEqual(['5'])
    expect(violations(out)[0]?.addedSpan).toBe('太阳能板')
    expect(out.amendment_basis_report).toContain('修改后权项：5')
  })

  it('多权项中只有被修改的一项报违规', async () => {
    const originalClaims = [
      ORIGINAL_CLAIMS,
      '2. 根据权利要求1所述的装置，其特征在于，所述散热孔为圆形。',
    ].join('\n')
    const out = await handler.execute({
      state: {
        draft: amendedDraft(
          [
            ORIGINAL_CLAIMS,
            '2. 根据权利要求1所述的装置，其特征在于，所述散热孔为圆形和椭圆形。',
          ].join('\n'),
        ),
        claims: originalClaims,
      },
    })
    expect(out.amendment_basis_passed).toBe(false)
    expect(violations(out).map(item => item.claimNo)).toEqual(['2'])
    expect(violations(out)[0]?.addedSpan).toBe('椭圆形')
    expect(out.amendment_basis_report).toContain('修改后权项：1、2')
  })

  it('仅新增虚词 → 忽略，不报违规', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '所述的散热孔。')),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('权利要求段在下一节标题处结束，不把意见陈述当成权项', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_report).toContain('修改后权项：1')
    expect(out.amendment_basis_report).not.toContain('修改后权项：1、1')
  })

  it('权利要求段后的加粗声明行不计入权项', async () => {
    const out = await handler.execute({
      state: {
        draft: [
          '修改后权利要求书：',
          ORIGINAL_CLAIMS,
          '**声明：本次答复不修改权利要求书，不存在超出原说明书和权利要求书记载范围的问题。**',
          '---',
        ].join('\n'),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
    expect(out.amendment_basis_report).toContain('修改后权项：1')
  })

  it('检测到修改但缺少原申请文件 → 降级，不以通知书冒充依据', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS),
        source_text: '审查意见通知书：权利要求1不具备创造性。',
      },
    })
    expect(out._error).toContain('[amendment-basis]')
    expect(out._error).toContain('缺少原申请文件')
  })

  it('原说明书的 explicit 键优先，来源写进报告', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '散热孔和过滤网。')),
        original_description: '说明书：壳体上设置有散热孔和过滤网。',
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_scope).toBe('原说明书 + 原权利要求书')
    expect(out.amendment_basis_report).toContain('比对来源：原说明书 + 原权利要求书')
  })

  it('自定义 amended_text_keys 与 original_text_keys', async () => {
    const out = await handler.execute({
      state: {
        amended_text_keys: ['my_draft'],
        original_text_keys: ['my_original'],
        my_draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '散热孔和过滤网。')),
        my_original: '一种装置，包括壳体，壳体上设置有散热孔和过滤网。',
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_scope).toBe('原申请文件')
  })

  it('答复正文类型错误 → 降级', async () => {
    const out = await handler.execute({
      state: { draft: 123, claims: ORIGINAL_CLAIMS },
    })
    expect(out._error).toContain('[amendment-basis]')
    expect(out._error).toContain('draft')
  })

  it('原申请文件类型错误 → 降级', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS),
        claims: { text: ORIGINAL_CLAIMS },
      },
    })
    expect(out._error).toContain('[amendment-basis]')
    expect(out._error).toContain('claims')
  })

  it('非法 amended_text_keys 配置 → 降级', async () => {
    const out = await handler.execute({
      state: {
        amended_text_keys: ['draft', 1],
        draft: amendedDraft(ORIGINAL_CLAIMS),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out._error).toContain('[amendment-basis]')
    expect(out._error).toContain('amended_text_keys')
  })

  it('非法 original_text_keys 配置 → 降级', async () => {
    const out = await handler.execute({
      state: {
        original_text_keys: [],
        draft: amendedDraft(ORIGINAL_CLAIMS),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out._error).toContain('[amendment-basis]')
    expect(out._error).toContain('original_text_keys')
  })

  it('缺少修改后文本但提供了原申请文件 → 降级为缺少答复正文', async () => {
    const out = await handler.execute({ state: { claims: ORIGINAL_CLAIMS } })
    expect(out._error).toContain('缺少答复正文')
  })

  it('空白字符串视为未提供文本', async () => {
    const blank = await handler.execute({ state: { draft: '   ', claims: ORIGINAL_CLAIMS } })
    expect(blank._error).toContain('缺少答复正文')
  })

  it('标题与权项同行的写法也能提取', async () => {
    const out = await handler.execute({
      state: {
        draft: `修改后权利要求书：${ORIGINAL_CLAIMS}\n\n意见陈述：无。`,
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_report).toContain('修改后权项：1')
  })

  it('标题后直接进入下一节 → 视为未修改权利要求', async () => {
    const out = await handler.execute({
      state: {
        draft: ['修改后权利要求书：', '意见陈述：本次未修改权利要求。'].join('\n'),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_scope).toBe('未检测到修改后权利要求')
  })

  it('跨行权项正文按同一权项合并', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(['1. 一种装置，包括壳体，', '其特征在于，所述壳体上设置有散热孔。'].join('\n')),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_report).toContain('修改后权项：1')
  })

  it('原申请文件中的权利要求段也用于建立对比基础', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '散热孔和过滤网。')),
        description: '权利要求书：\n1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔和过滤网。',
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_scope).toBe('原说明书 + 原权利要求书')
  })

  it('多个键提供相同原文时只参与一次比对', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS),
        description: ORIGINAL_CLAIMS,
        original_description: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(out.amendment_basis_scope).toBe('原说明书')
  })

  it('修改后权项规范化后为空 → 不产生新增片段', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft('1. 其特征在于'),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_passed).toBe(true)
    expect(violations(out)).toEqual([])
  })

  it('原申请文件规范化后为空 → 修改后权项整体列为新增', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft('1. 一种装置'),
        claims: '其特征在于',
      },
    })
    expect(out.amendment_basis_passed).toBe(false)
    expect(violations(out)[0]?.addedSpan).toBe('装置')
  })

  it('超长文本退回前缀匹配，仍能定位中间插入片段', async () => {
    const source = '甲'.repeat(2010)
    const amended = `${'甲'.repeat(1000)}乙乙乙乙乙乙乙乙乙乙${'甲'.repeat(1000)}`
    const out = await handler.execute({
      state: {
        draft: amendedDraft(`1. ${amended}`),
        claims: `1. ${source}`,
      },
    })
    expect(out.amendment_basis_passed).toBe(false)
    expect(violations(out)[0]?.addedSpan).toBe('乙乙乙乙乙乙乙乙乙乙')
  })

  it('超长文本末尾新增的片段也会输出', async () => {
    const source = '甲'.repeat(2010)
    const amended = `${'甲'.repeat(2010)}乙乙乙乙乙乙乙乙乙乙`
    const out = await handler.execute({
      state: {
        draft: amendedDraft(`1. ${amended}`),
        claims: `1. ${source}`,
      },
    })
    expect(violations(out)[0]?.addedSpan).toBe('乙乙乙乙乙乙乙乙乙乙')
  })

  it('新增片段末尾的虚词被剥离', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS.replace('散热孔。', '散热孔和过滤网之后。')),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(violations(out)[0]?.addedSpan).toBe('过滤网')
  })

  it('报告固定写明字符级对照的复核限制', async () => {
    const out = await handler.execute({
      state: {
        draft: amendedDraft(ORIGINAL_CLAIMS),
        claims: ORIGINAL_CLAIMS,
      },
    })
    expect(out.amendment_basis_report).toContain('是否可直接、毫无疑义地确定仍需人工复核')
  })
})
