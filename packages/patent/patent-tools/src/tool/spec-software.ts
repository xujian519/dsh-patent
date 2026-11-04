/**
 * Software and AI filing checks: computer-program subject matter (Patent Law
 * A25.1.2), storage-medium claim form, and the model-disclosure gaps (A26.3)
 * that the form checks do not cover.
 *
 * Every rule is gated on `tech_domain: 'software'`: the same wording carries a
 * different meaning elsewhere (「模型」in a mechanical filing is a mould, 「层」
 * in a chemical one is a coating layer), so running these rules domain-blind
 * would report the other domains' filings as computer programs. A hit means the
 * drafting needs review — the exclusions themselves stay a legal judgement.
 * @module @deepseek-ai/dsh-patent-tools/tool/spec-software
 */

import type { TechDomain } from './draft-claims.ts'
import { claimSubjects } from './internal/claim-subjects.ts'
import type { SpecViolation } from './spec-types.ts'

/**
 * Technical fields and technical objects a program can act on. A method claim
 * with none of these states an information-processing procedure only.
 */
const TECHNICAL_CARRIER = new RegExp([
  '图像', '影像', '视频', '音频', '语音', '文本', '信号', '传感器', '摄像头', '相机', '麦克风', '雷达',
  '激光', '红外', '芯片', '处理器', '存储器', '内存', '缓存', '总线', '网络', '信道', '带宽', '时延',
  '功耗', '报文', '数据包', '通信', '无线', '光纤', '编码', '解码', '调制', '解调', '压缩', '渲染',
  '定位', '导航', '无人机', '机器人', '车辆', '电机', '电池', '医疗', '医学', '临床', '工业', '产线',
  '机床', '设备', '终端', '服务器', '数据库', '操作系统', '编译器', '虚拟化', '分布式', '集群', '异构',
  '算力', '张量', '加密', '解密', '密钥', '指纹', '人脸', '姿态', '点云', '三维', '遥感', '地震',
  '气象', '电网', '交通', '铁路', '航空', '仓储', '农业', '水文', '地质',
].join('|'))

/** Subjects that name the method a program carries out. */
const METHOD_SUBJECT = /(?:方法|工艺|步骤)$/

/** Subjects that name an algorithm or program itself instead of a technical product. */
const ALGORITHM_SUBJECT = /(?:算法|公式|定理|数学模型|计算模型|程序代码|源代码|程序)$/

/**
 * Subjects whose claimed object is a signal: the signal itself, a signal
 * carrier («计算机可读信号介质»), or a transmission medium.
 */
const SIGNAL_SUBJECT = /(?:信号|载波)$|信号[^。]{0,10}(?:介质|载体|媒介)$|传输介质$/

/** Storage-medium subjects, which are admissible product claims. */
const STORAGE_MEDIUM_SUBJECT = /存储介质|存储载体|可读介质/

/** Bare bitstream subject: an information rule under A25.1.2, a form error under A26.4. */
const BITSTREAM_SUBJECT = /比特流$/

/**
 * Vocabulary of a business, management, financial, teaching, or game rule. A
 * hit is a subject-matter risk signal, not an exclusion: fintech and education
 * filings legitimately use these words and argue technical effect around them.
 */
const BUSINESS_TERMS = new RegExp([
  '定价', '价格', '售价', '折扣', '优惠', '促销', '营销', '广告', '推广', '销量', '销售额', '营收',
  '利润', '成本核算', '订单', '成交', '撮合', '交易', '支付', '结算', '保险', '理财', '贷款', '信贷',
  '证券', '股票', '基金', '汇率', '会员', '积分', '优惠券', '返利', '佣金', '竞价', '拍卖', '招聘',
  '简历', '绩效', '考勤', '排班', '薪酬', '合同', '租赁', '门店', '导购', '经营', '行政审批', '报销',
  '教学计划', '课程表', '考试成绩', '闯关', '游戏关卡', '虚拟道具', '排行榜', '转化率', '留存率',
].join('|'))

/**
 * A sentence that trains a model: the training word and the model word must sit
 * in the same sentence (`训练运维人员` is not model training, and a distant
 * mention of「网络」elsewhere in the description is not evidence either).
 */
const TRAINING_MODEL_SENTENCE = /(?:训练|微调|预训练)[^。；！？]{0,40}(?:模型|神经网络)|(?:模型|神经网络)[^。；！？]{0,40}(?:训练|微调|预训练)/

/** What a training disclosure must name: source, scale, or labels of the data. */
const TRAINING_DATA_TERMS = ['数据集', '训练集', '验证集', '测试集', '样本', '标注', '采集', '来源', '规模', '数量', '比例', '划分', '批次']

/** A mention of a learned model, which A26.3 requires to be reproducible. */
const MODEL_MENTION = /神经网络|深度学习|机器学习|语言模型|大模型|transformer|随机森林|支持向量机|svm|决策树|梯度提升/i

/**
 * Structure terms that make a model reproducible. Kept to architecture-level
 * vocabulary: generic words (「参数」「结构」「节点」「维度」) appear in almost
 * every description and would let the check pass without any structure.
 */
const STRUCTURE_TERMS = ['层数', '卷积', '池化', '激活函数', '注意力', '残差', '编码器', '解码器', '隐藏层', '隐层', '全连接', '输入层', '输出层', '网络结构', '模型结构', '权重', '超参数', '特征维度', '节点数', '神经元']

/** An uppercase abbreviation token; step labels such as `S1` are filtered out below. */
const ABBREVIATION = /\b[A-Z][A-Z0-9]{1,7}\b/g

/** Abbreviations a skilled person knows without a definition in the text. */
const KNOWN_ABBREVIATIONS = new Set([
  'AI', 'API', 'APP', 'AR', 'CPU', 'DNS', 'FTP', 'GB', 'GPU', 'GPS', 'HDMI', 'HTML', 'HTTP', 'HTTPS',
  'IDE', 'ID', 'IP', 'JSON', 'KB', 'LTE', 'MB', 'MR', 'NFC', 'OCR', 'OS', 'PC', 'PCI', 'RAM', 'ROM',
  'SDK', 'SIM', 'SQL', 'SSD', 'SSH', 'SSL', 'TB', 'TCP', 'TLS', 'UDP', 'UI', 'URL', 'USB', 'UX', 'VR',
  'XML',
])

/** How many undefined abbreviations one run reports at most. */
const MAX_ABBREVIATIONS = 3

/**
 * Whether a submission looks like a computer-program invention. Used to say so
 * instead of silently skipping the software rules when the caller declared no
 * technical domain.
 * @param text - the specification text.
 * @param claims - the claims text.
 * @returns true when either text names an algorithm, model, or program.
 */
export function looksLikeComputerProgram(text: string, claims: string): boolean {
  return /算法|神经网络|机器学习|深度学习|模型训练|计算机程序|程序产品|处理器执行/.test(`${text}\n${claims}`)
}

/**
 * Subject-matter and form rules that read the claims: an algorithm as the
 * claimed subject, a signal as the claimed carrier, an independent method claim
 * with no technical carrier at all, and business-rule vocabulary.
 * @param claims - the claims text; absent or blank input is not checked.
 * @param techDomain - the declared technical domain; only `software` is checked.
 * @returns one violation per offending independent claim, in claim order.
 */
export function checkSoftwareClaimSubjectMatter(
  claims: string | undefined,
  techDomain: TechDomain | undefined,
): SpecViolation[] {
  if (techDomain !== 'software') return []
  if (claims === undefined || claims.trim().length === 0) return []
  const violations: SpecViolation[] = []
  for (const claim of claimSubjects(claims)) {
    const { number, subject, text } = claim
    const subjectViolation = softwareSubjectViolation(number, subject)
    if (subjectViolation !== undefined) {
      violations.push(subjectViolation)
      continue
    }
    if (METHOD_SUBJECT.test(subject) && !TECHNICAL_CARRIER.test(carrierText(text))) {
      violations.push({
        rule: 'software_no_technical_means',
        family: 'claims',
        severity: 'warning',
        message: `第 ${number} 项独立权利要求「${subject}」未出现任何技术领域或技术载体：方案可能被认定为仅涉及智力活动的规则和方法（《专利法》第二十五条第一款第二项；《专利审查指南》第二部分第一章 4.2、第二部分第九章 2）`,
        suggestion: '把算法限定到具体技术场景（所处理的技术对象、所满足的技术约束或所运行的技术设备），并据以说明所解决的技术问题与实际达到的技术效果',
      })
    }
    const businessTerm = BUSINESS_TERMS.exec(text)?.[0]
    if (businessTerm !== undefined) {
      violations.push({
        rule: 'software_business_rule_feature',
        family: 'claims',
        severity: 'warning',
        message: `第 ${number} 项独立权利要求含商业/管理类表述「${businessTerm}」：须论证除商业规则外还采用技术手段、解决技术问题（《专利法》第二十五条第一款第二项；《专利审查指南》第二部分第一章 4.2、第二部分第九章 2）`,
        suggestion: '补入支撑该表述的技术手段（如交易数据的实时校验、分布式一致性处理），并在有益效果中给出对应的技术效果，避免权要整体落入商业方法',
      })
    }
  }
  return violations
}

/**
 * The claim text with neural-network mentions removed.「网络」is a technical
 * carrier for data-transmission claims, but in「神经网络」it names the algorithm,
 * so the carrier test must not count it.
 * @param text - the claim text.
 * @returns the text to test for a technical carrier.
 */
function carrierText(text: string): string {
  return text.replace(/神经网络/g, '')
}

/**
 * The subject-name rule that decides a whole claim: a named algorithm is
 * excluded by A25.1.2 itself, and a signal carrier is a form error under A26.4.
 * @param number - the claim number, for the message.
 * @param subject - the trimmed claim subject.
 * @returns the violation, or `undefined` when the subject is admissible.
 */
function softwareSubjectViolation(number: number, subject: string): SpecViolation | undefined {
  if (ALGORITHM_SUBJECT.test(subject)) {
    return {
      rule: 'software_algorithm_subject',
      family: 'claims',
      severity: 'error',
      message: `第 ${number} 项权利要求的主题「${subject}」是算法或程序本身：算法本身属于智力活动的规则和方法（《专利法》第二十五条第一款第二项；《专利审查指南》第二部分第一章 4.2、第二部分第九章 2）`,
      suggestion: '把主题改写为算法所服务的技术方案（如「一种基于…的图像识别方法」），并在特征部分记载算法处理的技术对象与技术约束',
    }
  }
  if (SIGNAL_SUBJECT.test(subject) && !STORAGE_MEDIUM_SUBJECT.test(subject)) {
    return {
      rule: 'software_signal_medium',
      family: 'claims',
      severity: 'error',
      message: `第 ${number} 项权利要求把载体写成信号或传输介质（「${subject}」）：信号与传输介质不属于《专利法》第二十六条第四款意义上的产品（《专利审查指南》第二部分第九章 5.2）`,
      suggestion: '改写为「一种计算机可读存储介质，其上存储有计算机程序，所述程序被处理器执行时实现…」，需要保护传输过程时另以方法权利要求布局',
    }
  }
  if (BITSTREAM_SUBJECT.test(subject)) {
    return {
      rule: 'software_signal_medium',
      family: 'claims',
      severity: 'error',
      message: `第 ${number} 项权利要求的主题「${subject}」是比特流本身：单纯比特流属于智力活动的规则和方法（《专利法》第二十五条第一款第二项；《专利审查指南》第二部分第九章 2）`,
      suggestion: '先撰写限定该比特流的编码方法权利要求，再以该编码方法限定存储/传输比特流的方法或存储介质权利要求',
    }
  }
  return undefined
}

/**
 * Disclosure rules that read the specification: whether a model-training
 * statement names its data, whether a mentioned model is reproducible, and
 * whether an abbreviation is defined before it is used.
 * @param text - the specification text; blank input is not checked.
 * @param techDomain - the declared technical domain; only `software` is checked.
 * @returns the disclosure violations, in rule order.
 */
export function checkSoftwareDisclosure(text: string, techDomain: TechDomain | undefined): SpecViolation[] {
  if (techDomain !== 'software') return []
  if (text.trim().length === 0) return []
  return [
    ...trainingDataViolation(text),
    ...modelStructureViolation(text),
    ...abbreviationViolations(text),
  ]
}

/**
 * A specification that trains a model must name the training data's source,
 * scale, or labelling; otherwise the model cannot be reproduced from it.
 * @param text - the specification text.
 * @returns one warning when a training context appears with no data detail.
 */
function trainingDataViolation(text: string): SpecViolation[] {
  if (!TRAINING_MODEL_SENTENCE.test(text)) return []
  if (TRAINING_DATA_TERMS.some(term => text.includes(term))) return []
  return [{
    rule: 'software_training_data_disclosure',
    family: 'description',
    severity: 'warning',
    section: '具体实施方式',
    message: '说明书涉及模型训练，但未记载训练数据的来源、规模或标注方式：所属领域技术人员无法据此复现该模型（《专利法》第二十六条第三款；《专利审查指南》第二部分第九章 5.1）',
    suggestion: '补充训练数据的来源与采集方式、规模（样本量与类别数）、训练/验证/测试划分比例，以及标注规则',
  }]
}

/**
 * A specification that mentions a learned model must describe its structure;
 * otherwise the algorithm is disclosed as a name only.
 * @param text - the specification text.
 * @returns one warning when the model's structure terms are all absent.
 */
function modelStructureViolation(text: string): SpecViolation[] {
  if (!MODEL_MENTION.test(text)) return []
  if (STRUCTURE_TERMS.some(term => text.includes(term))) return []
  return [{
    rule: 'software_model_structure_disclosure',
    family: 'description',
    severity: 'warning',
    section: '具体实施方式',
    message: '说明书提及神经网络或机器学习模型，但未记载其结构（层数与类型、连接方式、激活函数、关键参数）：算法披露过于概括（《专利法》第二十六条第三款；《专利审查指南》第二部分第九章 5.1）',
    suggestion: '补充模型结构（如「编码器-解码器结构，编码器 12 层 Transformer 块，每块包含多头注意力与前馈层」）、输入输出维度，以及训练超参数的范围',
  }]
}

/**
 * An uppercase abbreviation used without a Chinese definition. A26.3 requires
 * the description to enable the skilled person; an abbreviation introduced by
 * name only does not. Abbreviations a skilled person knows are skipped.
 * @param text - the specification text.
 * @returns one warning listing up to three undefined abbreviations.
 */
function abbreviationViolations(text: string): SpecViolation[] {
  const undefinedTokens: string[] = []
  for (const match of text.matchAll(ABBREVIATION)) {
    const token = match[0]
    if (KNOWN_ABBREVIATIONS.has(token)) continue
    if (/\d/.test(token)) continue
    if (undefinedTokens.includes(token)) continue
    if (isDefined(text, token)) continue
    undefinedTokens.push(token)
    if (undefinedTokens.length >= MAX_ABBREVIATIONS) break
  }
  if (undefinedTokens.length === 0) return []
  return [{
    rule: 'software_abbreviation_undefined',
    family: 'prohibitions',
    severity: 'warning',
    message: `说明书使用缩写「${undefinedTokens.join('」「')}」但未给出中文全称：说明书应当清楚、完整，足以使所属领域技术人员实现（《专利法》第二十六条第三款）`,
    suggestion: '在缩写首次出现处写成「中文全称（缩写）」，并在权利要求书、说明书与附图中统一使用同一名称',
  }]
}

/** Chinese nouns that end a technical full name, so a bare word before a token is not one. */
const DEFINITION_NOUNS = '网络|模型|算法|系统|单元|机制|框架|引擎|模块|装置|设备|机器|树|机|器|法|块|层'

/**
 * Whether the text introduces the abbreviation next to its Chinese name:
 * 「长短期记忆网络（LSTM）」「长短期记忆网络 LSTM」「LSTM（长短期记忆网络）」.
 * A bracketed English-only expansion (「LSTM(Long Short-Term Memory)」) and a
 * Chinese word that is not part of a technical name (「采用 LSTM」) do not count.
 * @param text - the specification text.
 * @param token - the abbreviation to look for.
 * @returns true when any definition form occurs.
 */
function isDefined(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const chineseThenToken = new RegExp(`[\\u4e00-\\u9fff]{2,}(?:${DEFINITION_NOUNS})\\s*[（(]?\\s*${escaped}(?![A-Za-z0-9])`)
  const tokenThenChinese = new RegExp(`${escaped}\\s*[（(][^）)]{0,40}[\\u4e00-\\u9fff][^）)]{0,40}[）)]`)
  return chineseThenToken.test(text) || tokenThenChinese.test(text)
}
