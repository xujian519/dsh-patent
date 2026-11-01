/**
 * 时序图（序列图）SVG 生成（纯函数，无 IO）。
 *
 * 软件/算法类专利用时序图表达模块之间的消息交互：顶部一列参与者盒，盒底引出
 * 竖直生命线，消息画成两端落在生命线上的水平箭线（同步实心箭头 / 返回虚线箭头 /
 * 异步空心箭头），需要时在目标参与者的生命线上叠画激活条。《专利审查指南》
 * 第一部分第一章 4.3 规定附图用黑墨线条绘制、不得着色，且「流程图、框图应当
 * 作为附图，并应当在其框内给出必要的文字和符号」，故参与者名写在盒内、消息名
 * 写在箭线上方，全图只有 `#000000` 一种颜色。生命线用细实线而非虚线：该部分把
 * 虚线留给不可见轮廓，虚线生命线会被误读为轮廓线。
 *
 * 片段约定见 {@link VectorFigureSpec}：坐标单位为毫米，外壳 `<g>` 已给出描边与
 * 填充默认值，文本元素自带 `fill="#000000" stroke="none"`。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/sequence-diagram
 */

import { VectorFigureError, escapeXmlAttribute, fmt } from './vector-figure.ts'
import type { VectorFigureSpec } from './vector-figure.ts'

/** 生命线上的参与者（模块/角色）。 */
type SequenceParticipant = {
  id: string
  /** 参与者在图面上的名字（简短中文或全大写缩写）。 */
  label: string
}

/** 消息类型：'sync' 实线实心箭头 | 'return' 虚线箭头 | 'async' 实线空心箭头。 */
type MessageKind = 'sync' | 'return' | 'async'

/** 一条消息（箭线）。 */
export type SequenceMessage = {
  from: string
  to: string
  /** 消息名（简短，写在箭线上方）。 */
  label: string
  /** 消息类型：'sync' 实线实心箭头 | 'return' 虚线箭头 | 'async' 实线空心箭头，默认 'sync'。 */
  kind?: MessageKind
  /** 该消息是否在目标参与者上画激活条（细长矩形），默认 false。 */
  activate?: boolean
}

/** 时序图输入。 */
export type SequenceDiagramInput = {
  participants: readonly SequenceParticipant[]
  messages: readonly SequenceMessage[]
  /** 参与者盒宽（毫米），默认 30；盒高默认 8。 */
  boxWidthMm?: number
  /** 每条消息的垂直间距（毫米），默认 10。 */
  messageSpacingMm?: number
  /** 画布留白（毫米），默认 5。 */
  paddingMm?: number
}

/** 参与者盒默认宽度（毫米）。 */
const DEFAULT_BOX_WIDTH_MM = 30

/** 参与者盒高度（毫米）。 */
const BOX_HEIGHT_MM = 8

/** 相邻参与者盒的水平净距（毫米）：留出写箭线、箭头与消息名的横向空间。 */
const PARTICIPANT_GAP_MM = 12

/** 消息的默认垂直间距（毫米）。 */
const DEFAULT_MESSAGE_SPACING_MM = 10

/** 画布默认留白（毫米）。 */
const DEFAULT_PADDING_MM = 5

/** 主线条线宽（毫米）：参与者盒轮廓与消息箭线。 */
const MAIN_STROKE_MM = 0.35

/** 细线线宽（毫米）：生命线、箭头与激活条，比主线条细以免压过消息本身。 */
const THIN_STROKE_MM = 0.25

/** 激活条宽度（毫米）。 */
const ACTIVATION_BAR_WIDTH_MM = 2

/** 箭头长度（毫米）：自箭尖向箭尾量取，箭线画到箭尾为止。 */
const ARROW_HEAD_LENGTH_MM = 3

/** 箭头半宽（毫米）。 */
const ARROW_HEAD_HALF_WIDTH_MM = 1.2

/** 返回消息的虚线样式（毫米）：线段 1.5、间隔 1。 */
const RETURN_DASH_PATTERN = '1.5 1'

/** 图面文字字号（毫米）。 */
const TEXT_FONT_SIZE_MM = 3.5

/** 文字基线相对其垂直中线的偏移（字号比例）：替代渲染器支持不一的 dominant-baseline。 */
const TEXT_MID_RATIO = 0.35

/** 消息名基线到箭线的间距（毫米）：保证文字不压线。 */
const MESSAGE_LABEL_GAP_MM = 1.2

/** 参与者数量上限。 */
const MAX_PARTICIPANTS = 50

/** 消息数量上限。 */
const MAX_MESSAGES = 500

/** 图面文字转义：文本节点与属性值所需转义的字符集相同（&、<、>、"）。 */
const escapeText = escapeXmlAttribute

/** 箭头样式：实心与否、虚线与否各自独立。 */
type ArrowStyle = { filled: boolean; dashed: boolean }

/** 各消息类型的箭头样式；键集即合法类型清单。 */
const ARROW_STYLES: Record<MessageKind, ArrowStyle> = {
  sync: { filled: true, dashed: false },
  return: { filled: true, dashed: true },
  async: { filled: false, dashed: false },
}

/** 合法消息类型清单（自样式表派生，避免两处清单漂移）。 */
const MESSAGE_KINDS: ReadonlySet<string> = new Set(Object.keys(ARROW_STYLES))

/** 参与者列：生命线横坐标（毫米）与图面名字。 */
type Column = { x: number; label: string }

/**
 * 校验参与者并收集 id。
 * @param participants - 参与者列表。
 * @returns 参与者 id 集合（消息端点存在性据此判断）。
 * @throws VectorFigureError('empty_input') 参与者列表为空时。
 * @throws VectorFigureError('invalid_input') id 或名字为空、id 重复或数量超上限时。
 */
function collectParticipantIds(participants: readonly SequenceParticipant[]): ReadonlySet<string> {
  if (participants.length === 0) {
    throw new VectorFigureError('empty_input', '时序图的参与者列表为空')
  }
  if (participants.length > MAX_PARTICIPANTS) {
    throw new VectorFigureError('invalid_input', `参与者数量超上限（${MAX_PARTICIPANTS}）：${participants.length}`)
  }
  const ids = new Set<string>()
  for (const [position, participant] of participants.entries()) {
    const id = participant.id.trim()
    if (id === '') {
      throw new VectorFigureError('invalid_input', `参与者 id 不能为空（第 ${position + 1} 项）`)
    }
    if (participant.label.trim() === '') {
      throw new VectorFigureError('invalid_input', `参与者 "${id}" 的名字不能为空`)
    }
    if (ids.has(id)) {
      throw new VectorFigureError('invalid_input', `参与者 id 重复：${id}`)
    }
    ids.add(id)
  }
  return ids
}

/**
 * 校验消息：端点已声明、不支持自环、消息名非空、类型合法、数量不超上限。
 * @param messages - 消息列表。
 * @param ids - {@link collectParticipantIds} 的参与者 id 集合。
 * @throws VectorFigureError('invalid_input') 任一消息非法时。
 */
function validateMessages(messages: readonly SequenceMessage[], ids: ReadonlySet<string>): void {
  if (messages.length > MAX_MESSAGES) {
    throw new VectorFigureError('invalid_input', `消息数量超上限（${MAX_MESSAGES}）：${messages.length}`)
  }
  for (const [position, message] of messages.entries()) {
    const order = position + 1
    // 参与者 id 一律按去空白后的形式比对（{@link collectParticipantIds} 亦按此建档）。
    const from = message.from.trim()
    const to = message.to.trim()
    if (!ids.has(from)) {
      throw new VectorFigureError('invalid_input', `第 ${order} 条消息的起点不是已声明的参与者：${from}`)
    }
    if (!ids.has(to)) {
      throw new VectorFigureError('invalid_input', `第 ${order} 条消息的终点不是已声明的参与者：${to}`)
    }
    if (from === to) {
      throw new VectorFigureError('invalid_input', `第 ${order} 条消息的起点与终点相同，不支持自环：${from}`)
    }
    if (message.label.trim() === '') {
      throw new VectorFigureError('invalid_input', `第 ${order} 条消息的名字不能为空`)
    }
    if (message.kind !== undefined && !MESSAGE_KINDS.has(message.kind)) {
      throw new VectorFigureError('invalid_input', `第 ${order} 条消息的类型非法：${message.kind}`)
    }
  }
}

/**
 * 解析毫米尺寸选项。
 * @param value - 调用方给出的选项值；undefined 取默认值。
 * @param fallback - 默认值。
 * @param name - 选项名（写入错误消息）。
 * @returns 解析后的选项值。
 * @throws VectorFigureError('invalid_input') 解析结果非正或非有限时。
 */
function positiveOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new VectorFigureError('invalid_input', `${name} 必须为正有限数：${resolved}`)
  }
  return resolved
}

/** 第 position 列参与者盒中心的横坐标（毫米）。 */
function centerX(position: number, boxWidthMm: number, paddingMm: number): number {
  return paddingMm + position * (boxWidthMm + PARTICIPANT_GAP_MM) + boxWidthMm / 2
}

/** 取参与者列；id 已由 {@link validateMessages} 校验存在，此处仅收窄类型。 */
function columnOf(columns: ReadonlyMap<string, Column>, id: string): Column {
  return columns.get(id.trim()) as Column
}

/** 生命线片段：自参与者盒底边向下延伸的细实线。 */
function lifelineFragment(x: number, topY: number, bottomY: number): string {
  return `<line x1="${fmt(x)}" y1="${fmt(topY)}" x2="${fmt(x)}" y2="${fmt(bottomY)}" stroke="#000000" stroke-width="${fmt(THIN_STROKE_MM)}"/>`
}

/** 参与者盒片段：实线矩形与盒内居中的名字。 */
function participantFragment(x: number, boxWidthMm: number, topY: number, label: string): string[] {
  const textY = topY + BOX_HEIGHT_MM / 2 + TEXT_MID_RATIO * TEXT_FONT_SIZE_MM
  return [
    `<rect x="${fmt(x - boxWidthMm / 2)}" y="${fmt(topY)}" width="${fmt(boxWidthMm)}" height="${fmt(BOX_HEIGHT_MM)}" fill="none" stroke="#000000" stroke-width="${fmt(MAIN_STROKE_MM)}"/>`,
    `<text x="${fmt(x)}" y="${fmt(textY)}" text-anchor="middle" fill="#000000" stroke="none" font-size="${fmt(TEXT_FONT_SIZE_MM)}">${escapeText(label)}</text>`,
  ]
}

/** 激活条片段：目标生命线上覆盖该消息行上下各半格的细长矩形。 */
function activationBarFragment(x: number, y: number, messageSpacingMm: number): string {
  return `<rect x="${fmt(x - ACTIVATION_BAR_WIDTH_MM / 2)}" y="${fmt(y - messageSpacingMm / 2)}" width="${fmt(ACTIVATION_BAR_WIDTH_MM)}" height="${fmt(messageSpacingMm)}" fill="none" stroke="#000000" stroke-width="${fmt(THIN_STROKE_MM)}"/>`
}

/** 一条消息的片段：箭线（箭尾止于箭头底边）、箭头与箭线上方居中的消息名。 */
function messageFragment(x1: number, x2: number, y: number, kind: MessageKind, label: string): string[] {
  const style = ARROW_STYLES[kind]
  const baseX = x2 - (x2 > x1 ? 1 : -1) * ARROW_HEAD_LENGTH_MM
  const dash = style.dashed ? ` stroke-dasharray="${RETURN_DASH_PATTERN}"` : ''
  return [
    `<line x1="${fmt(x1)}" y1="${fmt(y)}" x2="${fmt(baseX)}" y2="${fmt(y)}" stroke="#000000" stroke-width="${fmt(MAIN_STROKE_MM)}"${dash}/>`,
    `<polygon points="${fmt(x2)},${fmt(y)} ${fmt(baseX)},${fmt(y - ARROW_HEAD_HALF_WIDTH_MM)} ${fmt(baseX)},${fmt(y + ARROW_HEAD_HALF_WIDTH_MM)}" fill="${style.filled ? '#000000' : 'none'}" stroke="#000000" stroke-width="${fmt(THIN_STROKE_MM)}"/>`,
    `<text x="${fmt((x1 + x2) / 2)}" y="${fmt(y - MESSAGE_LABEL_GAP_MM)}" text-anchor="middle" fill="#000000" stroke="none" font-size="${fmt(TEXT_FONT_SIZE_MM)}">${escapeText(label)}</text>`,
  ]
}

/**
 * 由参与者与消息构造时序图规格。
 * @param input - 参与者、消息与画布选项。
 * @returns 毫米画布尺寸、SVG 片段与图面词语。
 * @throws VectorFigureError('empty_input') 参与者列表为空时。
 * @throws VectorFigureError('invalid_input') 参与者/消息字段非法、id 重复、消息端点未声明、自环、类型非法、数量超上限或尺寸选项非正时。
 */
export function buildSequenceDiagram(input: SequenceDiagramInput): VectorFigureSpec {
  const ids = collectParticipantIds(input.participants)
  const boxWidthMm = positiveOption(input.boxWidthMm, DEFAULT_BOX_WIDTH_MM, 'boxWidthMm')
  const messageSpacingMm = positiveOption(input.messageSpacingMm, DEFAULT_MESSAGE_SPACING_MM, 'messageSpacingMm')
  const paddingMm = positiveOption(input.paddingMm, DEFAULT_PADDING_MM, 'paddingMm')
  validateMessages(input.messages, ids)

  const columns = new Map<string, Column>()
  const columnList: Column[] = []
  input.participants.forEach((participant, position) => {
    const column: Column = { x: centerX(position, boxWidthMm, paddingMm), label: participant.label.trim() }
    columns.set(participant.id.trim(), column)
    columnList.push(column)
  })

  const boxTop = paddingMm
  const boxBottom = boxTop + BOX_HEIGHT_MM
  // 生命线纵向盖住全部消息行，并下探半格留出收尾余量；无消息时至少一格。
  const lifelineBottom = boxBottom
    + Math.max(input.messages.length, 1) * messageSpacingMm
    + messageSpacingMm / 2
  const fragments: string[] = [
    ...columnList.map(column => lifelineFragment(column.x, boxBottom, lifelineBottom)),
    ...columnList.flatMap(column => participantFragment(column.x, boxWidthMm, boxTop, column.label)),
  ]
  for (const [position, message] of input.messages.entries()) {
    const y = boxBottom + (position + 1) * messageSpacingMm
    const target = columnOf(columns, message.to)
    // 激活条先入片段表：箭线随后覆盖在其上，避免条边压住箭头。
    if (message.activate === true) fragments.push(activationBarFragment(target.x, y, messageSpacingMm))
    fragments.push(...messageFragment(columnOf(columns, message.from).x, target.x, y, message.kind ?? 'sync', message.label.trim()))
  }

  const widthMm = 2 * paddingMm
    + columnList.length * boxWidthMm
    + (columnList.length - 1) * PARTICIPANT_GAP_MM
  const heightMm = lifelineBottom + paddingMm
  const labels = [
    ...columnList.map(column => column.label),
    ...input.messages.map(message => message.label.trim()),
  ]
  return { widthMm, heightMm, body: fragments.join('\n'), labels }
}
