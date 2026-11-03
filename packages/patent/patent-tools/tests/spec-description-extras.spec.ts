import { describe, expect, it } from 'vitest'
import {
  checkBackgroundCitations,
  checkEffectComparison,
  checkSequenceListing,
  checkTermConsistency,
  checkTextMedia,
  checkUtilityModelFigureContent,
  checkUtilityModelSubjectMatter,
} from '../src/tool/spec-description-extras.ts'

/** 组合一段带指定小节正文的说明书文本。 */
function spec(background: string, summary = '', embodiment = ''): string {
  return [
    '## 技术领域',
    '本发明涉及检测技术领域。',
    '## 背景技术',
    background,
    '## 发明内容',
    summary,
    '## 具体实施方式',
    embodiment || '实施例1：本实施例提供一种检测装置。',
  ].join('\n')
}

describe('checkBackgroundCitations', () => {
  it('完整专利引证不报，缺国别/号/日期逐项报', () => {
    expect(checkBackgroundCitations(spec('对比文件1（CN1234567A，2020年1月1日公开）公开了一种装置。'))).toEqual([])
    const missing = checkBackgroundCitations(spec('对比文件1公开了一种装置。'))
    expect(missing).toHaveLength(1)
    expect(missing[0]?.message).toContain('国别')
    expect(missing[0]?.message).toContain('公开号/专利号')
    expect(missing[0]?.message).toContain('公开日/公告日')
  })

  it('非专利文献缺出处时 warning，给出书名不报', () => {
    expect(checkBackgroundCitations(spec('期刊论文指出该结构存在缺陷。'))[0]?.message).toContain('未注明出处')
    expect(checkBackgroundCitations(spec('期刊《检测技术》指出该结构存在缺陷。'))).toEqual([])
    expect(checkBackgroundCitations(spec('《检测技术手册》指出该结构存在缺陷。'))).toEqual([])
  })

  it('没有引证句或没有背景技术时不报', () => {
    expect(checkBackgroundCitations(spec('现有技术存在精度不足的问题。'))).toEqual([])
    expect(checkBackgroundCitations('## 技术领域\n检测。')).toEqual([])
  })
})

describe('checkEffectComparison', () => {
  it('有益效果缺少对比对象时 warning', () => {
    const violations = checkEffectComparison(spec('', '有益效果：提高检测精度，降低误报率。'))
    expect(violations[0]?.rule).toBe('effect_prior_art_comparison')
  })

  it('有对比对象或效果过短时不报', () => {
    expect(checkEffectComparison(spec('', '有益效果：相比现有技术，检测精度提高 20%。'))).toEqual([])
    expect(checkEffectComparison(spec('', '有益效果：精度高。'))).toEqual([])
    expect(checkEffectComparison(spec('', '本发明提供一种装置。'))).toEqual([])
  })
})

describe('checkSequenceListing', () => {
  it('出现序列但没有序列表时 warning', () => {
    const violations = checkSequenceListing(spec('', '本发明使用 SEQ ID NO: 1 所示序列。'))
    expect(violations[0]?.rule).toBe('sequence_listing')
  })

  it('提及序列表或没有序列时不报', () => {
    expect(checkSequenceListing(spec('', '序列见独立序列表 SEQ ID NO: 1。'))).toEqual([])
    expect(checkSequenceListing(spec('', '本发明不使用生物序列。'))).toEqual([])
  })
})

describe('checkTextMedia', () => {
  it('正文图片报 error', () => {
    const violations = checkTextMedia(spec('', '结构见 ![图1](fig1.png)。'))
    expect(violations.find(violation => violation.rule === 'image_in_text')?.severity).toBe('error')
  })

  it('表格在具体实施方式之外时 warning，在具体实施方式内不报', () => {
    const outside = checkTextMedia(spec('| 参数 | 值 |\n| --- | --- |\n| a | 1 |'))
    expect(outside.find(violation => violation.rule === 'table_outside_embodiment')?.severity).toBe('warning')
    const inside = checkTextMedia(spec('', '', '| 参数 | 值 |\n| --- | --- |\n| a | 1 |'))
    expect(inside).toEqual([])
  })
})

describe('checkTermConsistency', () => {
  it('同一标号对应多个名称、同一名称对应多个标号时 warning', () => {
    const ref = checkTermConsistency('壳体（1）与底座（1）连接。')
    expect(ref[0]?.message).toContain('标记 1 对应多个部件名')
    const name = checkTermConsistency('壳体（1）与壳体（2）连接。')
    expect(name[0]?.message).toContain('部件「壳体」使用了多个附图标记')
  })

  it('重复使用同一组名称与标号、或程序性标号时不报', () => {
    expect(checkTermConsistency('壳体（1）设置于底座（2），壳体（1）与底座（2）连接。')).toEqual([])
    expect(checkTermConsistency('实施例（1）与实施例（2）。')).toEqual([])
  })
})

describe('checkUtilityModelFigureContent', () => {
  const text = '## 附图说明\n图1为现有技术结构图。\n图2为性能曲线图。'

  it('实用新型仅有现有技术图或曲线图时 warning', () => {
    expect(checkUtilityModelFigureContent(text, 'utility_model')[0]?.rule).toBe('utility_model_figure_content')
  })

  it('有结构图、发明或没有附图说明时不报', () => {
    expect(checkUtilityModelFigureContent('## 附图说明\n图1为整体结构图。\n图2为性能曲线图。', 'utility_model')).toEqual([])
    expect(checkUtilityModelFigureContent(text, 'invention')).toEqual([])
    expect(checkUtilityModelFigureContent('## 技术领域\n检测。', 'utility_model')).toEqual([])
  })
})

describe('checkUtilityModelSubjectMatter', () => {
  const methodClaims = '1. 一种螺栓的制造方法，其特征在于：包括依次执行的热镦粗步骤与搓丝步骤。'
  const compositionClaims = '1. 一种润滑脂组合物，其特征在于：由基础油与稠化剂组成。'

  it('实用新型的方法主题报 error，并点出项号', () => {
    const found = checkUtilityModelSubjectMatter(methodClaims, 'utility_model')
    expect(found).toHaveLength(1)
    expect(found[0]?.rule).toBe('utility_model_method_claim')
    expect(found[0]?.severity).toBe('error')
    expect(found[0]?.message).toContain('第 1 项权利要求')
    expect(found[0]?.message).toContain('螺栓的制造方法')
  })

  it('实用新型的组合物主题报 error', () => {
    const found = checkUtilityModelSubjectMatter(compositionClaims, 'utility_model')
    expect(found[0]?.rule).toBe('utility_model_composition')
    expect(found[0]?.severity).toBe('error')
  })

  it('以工艺命名的产品不误报，发明类型不检查', () => {
    expect(checkUtilityModelSubjectMatter('1. 一种用于制造螺栓的模具，其特征在于：包括上模与下模。', 'utility_model')).toEqual([])
    expect(checkUtilityModelSubjectMatter(methodClaims, 'invention')).toEqual([])
  })

  it('未给权利要求、空白权利要求或无法解析主题时不报', () => {
    expect(checkUtilityModelSubjectMatter(undefined, 'utility_model')).toEqual([])
    expect(checkUtilityModelSubjectMatter('   ', 'utility_model')).toEqual([])
    expect(checkUtilityModelSubjectMatter('权利要求书如下。', 'utility_model')).toEqual([])
    // 权项能切分但主题名称取不到（句首不是「一种」）时跳过，不误报。
    expect(checkUtilityModelSubjectMatter('1. 其特征在于：包括壳体。', 'utility_model')).toEqual([])
  })

  it('多项缺陷按权项顺序各报一条', () => {
    const claims = [methodClaims, '2. 一种螺母的制造工艺，其特征在于：包括冷镦步骤。', compositionClaims].join('\n')
    const found = checkUtilityModelSubjectMatter(claims, 'utility_model')
    expect(found.map(v => v.rule)).toEqual([
      'utility_model_method_claim',
      'utility_model_method_claim',
      'utility_model_composition',
    ])
  })
})
