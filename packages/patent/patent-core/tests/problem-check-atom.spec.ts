import { describe, expect, it } from 'vitest'
import { ProblemCheckHandler, problemCheckAtom } from '../src/atoms/handlers/builtin/problem-check.ts'

const handler = new ProblemCheckHandler()

const codes = (out: Record<string, unknown>): string[] =>
  (out.problem_check_violations as Array<{ code: string }>).map(violation => violation.code)

describe('problem-check atom', () => {
  it('声明的输出以报告为主输出，输入读取 diff 与区别特征', () => {
    expect(problemCheckAtom.name).toBe('problem-check')
    expect(problemCheckAtom.category).toBe('compare')
    expect(problemCheckAtom.outputSchema[0]).toBe('problem_check_report')
    expect(problemCheckAtom.inputSchema).toContain('diff')
    expect(problemCheckAtom.inputSchema).toContain('distinguishing_features')
  })

  it('问题是区别特征自身的复述 → 阻断（拒绝路径）', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['设置限位凸台'],
          actual_technical_problem: '如何设置限位凸台',
        }),
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
    expect(out.problem_check_report).toContain('未通过')
    expect(out.problem_check_report).toContain('区别特征自身')
  })

  it('问题落到技术效果 → 通过，且不产生阻断项', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['设置限位凸台'],
          actual_technical_problem: '如何将装配温度从95℃降至78℃',
        }),
      },
    })
    expect(out.problem_check_passed).toBe(true)
    expect(codes(out)).toEqual([])
    expect(out.problem_check_report).toContain('通过')
    expect(out.problem_check_report).toContain('区别技术特征：1 项')
  })

  it('平面文本中的区别特征与问题同样参与比对', async () => {
    const out = await handler.execute({
      state: {
        diff:
          '区别技术特征为：设置限位凸台；实际解决的技术问题为：如何设置限位凸台；技术启示：无。',
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('多个区别特征按顿号拆分', async () => {
    const out = await handler.execute({
      state: {
        diff: '区别技术特征为：限位凸台、密封圈；实际解决的技术问题为：如何提高密封可靠性。',
      },
    })
    expect(out.problem_check_report).toContain('区别技术特征：2 项')
  })

  it('问题包含解决手段 → 阻断', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['液冷管路'],
          actual_technical_problem: '通过设置限位凸台防止位移',
        }),
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-SOLUTION-BINDING')
  })

  it('问题包含多个因果连接 → 阻断', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['液冷管路'],
          actual_technical_problem: '温度过高导致芯片损坏，使得整机宕机',
        }),
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-MULTI-CAUSAL')
  })

  it('缺少可测指标 → 质量提示，但不阻断', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['液冷管路'],
          actual_technical_problem: '提高可靠性',
        }),
      },
    })
    expect(out.problem_check_passed).toBe(true)
    expect(codes(out)).toEqual(['PROBLEM-UNMEASURED'])
    expect(out.problem_check_report).toContain('[提示]')
  })

  it('未提取到技术问题 → 记为未执行，不能按通过放行', async () => {
    const out = await handler.execute({
      state: { diff: '区别技术特征为：液冷管路；技术启示：无。' },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(out.problem_check_violations).toEqual([])
    expect(out.problem_check_report).toContain('未提取到实际解决的技术问题')
    expect(out.problem_check_report).toContain('本次未执行')
  })

  it('只有特征、没有 diff 文本 → 仍按缺问题记为未执行', async () => {
    const out = await handler.execute({ state: { distinguishing_features: ['液冷管路'] } })
    expect(out.problem_check_passed).toBe(false)
    expect(out.problem_check_report).toContain('未提取到实际解决的技术问题')
  })

  it('结构化特征状态与 JSON 问题组合使用', async () => {
    const out = await handler.execute({
      state: {
        distinguishing_features: ['液冷管路布局'],
        diff: JSON.stringify({ actual_technical_problem: '如何布置液冷管路' }),
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('问题只是在更长句中提到特征 → 不误报', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['散热鳍片'],
          actual_technical_problem: '如何提高散热鳍片的散热效率',
        }),
      },
    })
    expect(out.problem_check_passed).toBe(true)
    expect(codes(out)).not.toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('过短的特征不参与复述比对', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['X'],
          actual_technical_problem: '如何实现X',
        }),
      },
    })
    expect(codes(out)).not.toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('参数可覆盖 diff 文本键与特征键', async () => {
    const out = await handler.execute({
      state: {
        diff_text_keys: ['inventiveness_diff'],
        feature_keys: ['diff_features'],
        inventiveness_diff: JSON.stringify({ actual_technical_problem: '如何设置限位凸台' }),
        diff_features: ['设置限位凸台'],
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('多个 diff 键提供相同文本时只分析一次', async () => {
    const diff = JSON.stringify({
      distinguishing_features: ['设置限位凸台'],
      actual_technical_problem: '如何设置限位凸台',
    })
    const out = await handler.execute({ state: { diff, inventiveness_diff: diff } })
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
    expect(out.problem_check_report).toContain('区别技术特征：1 项')
  })

  it('JSON 前后带说明文字时提取对象片段', async () => {
    const out = await handler.execute({
      state: {
        diff:
          '对比结果如下：'
          + '{"distinguishing_features":["设置限位凸台"],"actual_technical_problem":"如何设置限位凸台"}'
          + ' 以上。',
      },
    })
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('结构化特征可以是单个字符串', async () => {
    const out = await handler.execute({
      state: {
        distinguishing_features: '设置限位凸台',
        diff: JSON.stringify({ actual_technical_problem: '如何设置限位凸台' }),
      },
    })
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('问题规范化后过短时不参与复述比对', async () => {
    const out = await handler.execute({
      state: {
        diff: JSON.stringify({
          distinguishing_features: ['设置限位凸台'],
          actual_technical_problem: '。',
        }),
      },
    })
    expect(codes(out)).not.toContain('PROBLEM-EQUALS-FEATURE')
  })

  it('没有区别特征时报告跳过复述检查', async () => {
    const out = await handler.execute({
      state: { diff: JSON.stringify({ actual_technical_problem: '如何提高可靠性' }) },
    })
    expect(out.problem_check_report).toContain('未提供区别技术特征，跳过')
  })

  it('配置键非法 → 降级', async () => {
    const badDiffKeys = await handler.execute({ state: { diff_text_keys: 'diff' } })
    expect(badDiffKeys._error).toContain('params.diff_text_keys')

    const badFeatureKeys = await handler.execute({ state: { feature_keys: [''] } })
    expect(badFeatureKeys._error).toContain('params.feature_keys')
  })

  it('状态值类型错误 → 降级并指明键名', async () => {
    const objectDiff = await handler.execute({
      state: { diff: { actual_technical_problem: '如何设置限位凸台' } },
    })
    expect(objectDiff._error).toContain('[problem-check]')
    expect(objectDiff._error).toContain('state.diff 不是字符串')

    const arrayDiff = await handler.execute({ state: { diff: ['实际解决的技术问题为：如何设置限位凸台'] } })
    expect(arrayDiff._error).toContain('state.diff 不是字符串')

    const badFeature = await handler.execute({ state: { distinguishing_features: 3 } })
    expect(badFeature._error).toContain('state.distinguishing_features 不是字符串或字符串数组')
  })

  it('代码围栏中的 JSON 也能解析', async () => {
    const out = await handler.execute({
      state: {
        diff:
          '```json\n' +
          '{"distinguishing_features":["设置限位凸台"],"actual_technical_problem":"如何设置限位凸台"}\n' +
          '```',
      },
    })
    expect(out.problem_check_passed).toBe(false)
    expect(codes(out)).toContain('PROBLEM-EQUALS-FEATURE')
  })
})
