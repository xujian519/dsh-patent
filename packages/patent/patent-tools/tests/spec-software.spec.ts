import { describe, expect, it } from 'vitest'
import {
  checkSoftwareClaimSubjectMatter,
  checkSoftwareDisclosure,
  looksLikeComputerProgram,
} from '../src/tool/spec-software.ts'

/** 一种把算法当主题名称的权要（SOFT-DC-010）。 */
const ALGORITHM_CLAIMS = '1. 一种反向传播算法，其特征在于，包括：计算输出误差；按链式法则回传梯度。'

/** 未关联技术领域的训练方法权要（SOFT-DC-007 的错误示例）。 */
const BARE_TRAINING_CLAIMS = [
  '1. 一种神经网络训练方法，包括：获取训练数据；构建神经网络；训练所述神经网络；输出训练完成的神经网络。',
].join('\n')

/** 已关联具体技术领域的训练方法权要（SOFT-DC-007 的正确写法）。 */
const IMAGE_TRAINING_CLAIMS = [
  '1. 一种医学影像分割用的神经网络训练方法，其特征在于，包括：',
  '获取医学影像数据集，所述数据集标注有病灶区域；',
  '构建 U-Net 结构的卷积神经网络；',
  '采用 Dice 损失函数训练所述卷积神经网络。',
].join('\n')

/** 纯商业方法权要（SOFT-DC-008 的错误示例）。 */
const BUSINESS_CLAIMS = '1. 一种商品定价方法，包括：获取用户行为；基于所述行为调整价格；输出定价结果。'

/** 信号介质权要（SOFT-DC-013 的错误示例）。 */
const SIGNAL_MEDIUM_CLAIMS = '1. 一种计算机可读信号介质，其上存储有计算机程序，所述程序被处理器执行时实现图像识别。'

/** 存储介质权要（SOFT-DC-013 的正确写法）。 */
const STORAGE_MEDIUM_CLAIMS = '1. 一种计算机可读存储介质，其上存储有计算机程序，所述程序被处理器执行时实现图像识别。'

describe('checkSoftwareClaimSubjectMatter', () => {
  it('未声明软件域时不评估', () => {
    expect(checkSoftwareClaimSubjectMatter(ALGORITHM_CLAIMS, undefined)).toEqual([])
    expect(checkSoftwareClaimSubjectMatter(ALGORITHM_CLAIMS, 'mechanical')).toEqual([])
    expect(checkSoftwareClaimSubjectMatter(undefined, 'software')).toEqual([])
    expect(checkSoftwareClaimSubjectMatter('   ', 'software')).toEqual([])
  })

  it('主题名称是算法本身时报 error', () => {
    const violations = checkSoftwareClaimSubjectMatter(ALGORITHM_CLAIMS, 'software')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.rule).toBe('software_algorithm_subject')
    expect(violations[0]?.severity).toBe('error')
    expect(violations[0]?.message).toContain('反向传播算法')
    expect(violations[0]?.suggestion).toContain('技术方案')
  })

  it('独立方法权要通篇没有技术载体时报 warning', () => {
    const violations = checkSoftwareClaimSubjectMatter(BARE_TRAINING_CLAIMS, 'software')
    const hit = violations.find(violation => violation.rule === 'software_no_technical_means')
    expect(hit?.severity).toBe('warning')
    expect(hit?.message).toContain('神经网络训练方法')
    // 「神经网络」里的「网络」不算技术载体
    expect(hit?.message).toContain('技术载体')
  })

  it('已限定技术领域的方法权要不再报载体缺失', () => {
    const violations = checkSoftwareClaimSubjectMatter(IMAGE_TRAINING_CLAIMS, 'software')
    expect(violations.filter(violation => violation.rule === 'software_no_technical_means')).toEqual([])
  })

  it('商业类表述报 warning 并指出具体词', () => {
    const violations = checkSoftwareClaimSubjectMatter(BUSINESS_CLAIMS, 'software')
    const hit = violations.find(violation => violation.rule === 'software_business_rule_feature')
    expect(hit?.severity).toBe('warning')
    expect(hit?.message).toContain('「定价」')
  })

  it('信号介质与比特流主题报 error，存储介质不报', () => {
    const signal = checkSoftwareClaimSubjectMatter(SIGNAL_MEDIUM_CLAIMS, 'software')
    expect(signal.map(violation => violation.rule)).toEqual(['software_signal_medium'])
    expect(signal[0]?.severity).toBe('error')
    expect(signal[0]?.message).toContain('计算机可读信号介质')

    const bitstream = checkSoftwareClaimSubjectMatter('1. 一种比特流，其特征在于，所述比特流由编码帧组成。', 'software')
    expect(bitstream[0]?.rule).toBe('software_signal_medium')
    expect(bitstream[0]?.message).toContain('比特流本身')

    expect(checkSoftwareClaimSubjectMatter(STORAGE_MEDIUM_CLAIMS, 'software')).toEqual([])
  })

  it('载波与传输介质主题同样按信号介质报 error', () => {
    const carrier = checkSoftwareClaimSubjectMatter('1. 一种载波，其特征在于，所述载波承载编码帧。', 'software')
    expect(carrier.map(violation => violation.rule)).toEqual(['software_signal_medium'])

    const medium = checkSoftwareClaimSubjectMatter('1. 一种传输介质，其上存储有计算机程序。', 'software')
    expect(medium.map(violation => violation.rule)).toEqual(['software_signal_medium'])
  })

  it('主题名称无法识别（句首没有「一种」）时不按主题判定', () => {
    const claims = '1. 采用卷积神经网络对图像进行分类，其特征在于，包括：输入图像；输出类别。'
    const violations = checkSoftwareClaimSubjectMatter(claims, 'software')
    expect(violations).toEqual([])
  })

  it('从属权利要求不单独评估客体', () => {
    const claims = [ALGORITHM_CLAIMS, '2. 根据权利要求 1 所述的算法，其特征在于，学习率取 0.01。'].join('\n')
    const violations = checkSoftwareClaimSubjectMatter(claims, 'software')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.message).toContain('第 1 项')
  })
})

describe('checkSoftwareDisclosure', () => {
  it('未声明软件域或正文为空时不评估', () => {
    expect(checkSoftwareDisclosure('使用训练数据对模型进行训练。', undefined)).toEqual([])
    expect(checkSoftwareDisclosure('使用训练数据对模型进行训练。', 'chemical')).toEqual([])
    expect(checkSoftwareDisclosure('  ', 'software')).toEqual([])
  })

  it('训练数据无来源/规模/标注时报 warning', () => {
    const violations = checkSoftwareDisclosure('本实施例使用训练数据对模型进行训练。', 'software')
    const hit = violations.find(violation => violation.rule === 'software_training_data_disclosure')
    expect(hit?.severity).toBe('warning')
    expect(hit?.message).toContain('训练数据的来源')
  })

  it('训练数据写明来源与规模后不再报', () => {
    const text = '本实施例采用 ImageNet 数据集（含 120 万张标注图像）训练卷积神经网络模型，训练集与验证集按 8:1 划分。'
    const violations = checkSoftwareDisclosure(text, 'software')
    expect(violations.filter(violation => violation.rule === 'software_training_data_disclosure')).toEqual([])
  })

  it('训练语境须与模型同句，训练人员不误报', () => {
    const text = '本实施例对运维人员进行训练，提升操作熟练度。所述系统运行于服务器。'
    const violations = checkSoftwareDisclosure(text, 'software')
    expect(violations.filter(violation => violation.rule === 'software_training_data_disclosure')).toEqual([])
  })

  it('只写通用词（参数、结构、维度）不足以认定结构已公开', () => {
    const text = '使用神经网络模型进行分类，模型的参数由训练得到，结构见下文，输入维度为 128。'
    const hit = checkSoftwareDisclosure(text, 'software').find(violation => violation.rule === 'software_model_structure_disclosure')
    expect(hit?.severity).toBe('warning')
  })

  it('随机森林等模型族同样进入结构检查', () => {
    const text = '采用随机森林对图像进行分类。'
    const hit = checkSoftwareDisclosure(text, 'software').find(violation => violation.rule === 'software_model_structure_disclosure')
    expect(hit?.severity).toBe('warning')
  })

  it('只提模型名不写结构时报 warning', () => {
    const violations = checkSoftwareDisclosure('使用神经网络模型对图像进行识别。', 'software')
    const hit = violations.find(violation => violation.rule === 'software_model_structure_disclosure')
    expect(hit?.severity).toBe('warning')
    expect(hit?.message).toContain('未记载其结构')
  })

  it('写明层数、卷积与参数后不再报结构缺失', () => {
    const text = '使用 ResNet-50 结构的卷积神经网络，其中残差块包含 2 个 3×3 卷积层与跳跃连接。'
    const violations = checkSoftwareDisclosure(text, 'software')
    expect(violations.filter(violation => violation.rule === 'software_model_structure_disclosure')).toEqual([])
  })

  it('缩写未给出中文全称时报 warning，给出后不再报', () => {
    const undefinedHit = checkSoftwareDisclosure('使用 LSTM 模型对序列建模。', 'software')
    const hit = undefinedHit.find(violation => violation.rule === 'software_abbreviation_undefined')
    expect(hit?.message).toContain('LSTM')

    const defined = checkSoftwareDisclosure('使用长短期记忆网络（LSTM）对序列建模。', 'software')
    expect(defined.filter(violation => violation.rule === 'software_abbreviation_undefined')).toEqual([])
  })

  it('中文全称后直接跟缩写（不带括号）同样算已定义', () => {
    const defined = checkSoftwareDisclosure('使用长短期记忆网络 LSTM 对序列建模。', 'software')
    expect(defined.filter(violation => violation.rule === 'software_abbreviation_undefined')).toEqual([])
  })

  it('括号内只是英文全称不算中文定义', () => {
    const violations = checkSoftwareDisclosure('使用 LSTM(Long Short-Term Memory) 对序列建模。', 'software')
    expect(violations.find(violation => violation.rule === 'software_abbreviation_undefined')?.message).toContain('LSTM')
  })

  it('公知缩写与步骤编号不算未定义缩写', () => {
    const violations = checkSoftwareDisclosure('步骤 S1：用 GPU 对图像做卷积；步骤 S2：输出结果。', 'software')
    expect(violations.filter(violation => violation.rule === 'software_abbreviation_undefined')).toEqual([])
  })

  it('最多报三个未定义缩写，且去重', () => {
    const text = '采用 CNN 与 CNN 以及 LSTM、GRU、BERT 做编码。'
    const violations = checkSoftwareDisclosure(text, 'software')
    const message = violations.find(violation => violation.rule === 'software_abbreviation_undefined')?.message ?? ''
    expect(message).toContain('CNN')
    expect(message).toContain('LSTM')
    expect(message).toContain('GRU')
    expect(message).not.toContain('BERT')
    expect(message.match(/CNN/g)).toHaveLength(1)
  })
})

describe('looksLikeComputerProgram', () => {
  it('算法或模型表述识别为计算机程序发明', () => {
    expect(looksLikeComputerProgram('一种图像识别方法，采用神经网络', '')).toBe(true)
    expect(looksLikeComputerProgram('', '1. 一种计算机程序产品，包括程序指令')).toBe(true)
  })

  it('普通机械文本不识别为计算机程序发明', () => {
    expect(looksLikeComputerProgram('一种螺栓，包括螺杆与螺母', '1. 一种螺栓')).toBe(false)
  })
})
