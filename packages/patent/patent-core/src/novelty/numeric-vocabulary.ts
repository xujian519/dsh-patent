/**
 * src/patent/novelty — 数值范围与单位的共享词表。
 *
 * 同一句专利文本会同时进入两条生产路径：新颖性图节点（{@link ./numeric-range.ts}）
 * 与规格校验（`@deepseek-ai/dsh-patent-tools` 的 `validate-specification`）。
 * 两侧各写一份词表时，「温度 20℃ 至 90℃」会被一侧读成区间、另一侧读成两个数值点，
 * 同一句文本因此得到互相矛盾的结论。**词表**（连接符、可写单位、单位归一、量纲与换算
 * 比例）在这里单点定义；**规则**差异留在各自实现里——规格校验要求尾随单位，因为它要用
 * 同单位的单值比对端点与中点，而新颖性判定只关心区间本身。
 *
 * 换算只覆盖同量纲的比例单位。温度按摄氏刻度同基准比较，不做 °C/°F 仿射换算：温标
 * 换算需要明确的换算依据，猜错偏置会把「不重叠」翻成「重叠」。表外单位只在两侧写法
 * 完全相同时可比——词表漏项只会让结论更保守，误认量纲会把结论推向错误方向。
 */

/**
 * 范围连接符的字符类内容：连字符、en dash、em dash、波浪号、全角波浪号，以及「至」「到」。
 * 供两侧以 `[...]` 嵌入正则；连字符放末位，避免被读成字符范围。
 */
export const NUMERIC_RANGE_SEPARATOR_CLASS = '~～至到–—-'

/**
 * 可写单位的备选串（长者在前，否则交替会把 "5mg" 截成 "m"、"0.1-2MPa" 截成 "m"）。
 * 摄氏度含 `℃`／`°C`／`°c`／`°` 四种写法，规格校验侧曾漏掉小写 `°c`。
 */
export const NUMERIC_UNIT_ALTERNATION =
  '°C|℃|°c|MPa|kPa|Pa|rpm|min|mol|mm|cm|kg|mg|ml|mL|％|°|m|g|L|h|s|%'

/**
 * 汉字单位的备选串（两字单位在前、单字在后），与 {@link NUMERIC_UNIT_SCALES} 的汉字键一致。
 *
 * 新颖性轨先把数值匹配出来、再从片段末尾读单位，汉字单位因而读得到；需要「单位必须
 * 写在数值后面」的路径（规格校验的端点/中点比对、权利要求特征覆盖）只有本串才能匹配
 * 中文写法。不含月、年、倍、次、转：其长度不固定或不是量，见 {@link NUMERIC_UNIT_SCALES}。
 */
export const NUMERIC_HAN_UNIT_ALTERNATION =
  '毫米|厘米|千米|微米|纳米|分钟|小时|毫升|千克|毫克|千帕|兆帕|摩尔|米|克|吨|升|秒|天|日|周|度|帕'

/** 拉丁与汉字单位写法的合并备选串；两组之间没有前缀重叠，前者的长优先顺序得以保留。 */
export const NUMERIC_ANY_UNIT_ALTERNATION = `${NUMERIC_HAN_UNIT_ALTERNATION}|${NUMERIC_UNIT_ALTERNATION}`

/** 数值单位所属量纲。 */
type NumericUnitDimension = 'length' | 'mass' | 'volume' | 'time' | 'temperature' | 'pressure' | 'ratio' | 'amount'

/** 单位到量纲基单位的换算比例。 */
type NumericUnitScale = {
  dimension: NumericUnitDimension
  /** 1 个该单位对应的基单位数。 */
  factor: number
}

/**
 * 可换算单位表：键为归一后的单位写法（拉丁单位小写，摄氏度统一为 `°`）。
 *
 * 基单位：长度 m、质量 g、体积 L、时间 s、温度 °C 刻度、压力 Pa、比例 1、物质的量 mol。
 * 月、年等日历单位不入表：其长度不固定，不能按比例换算。
 */
const NUMERIC_UNIT_SCALES: Readonly<Record<string, NumericUnitScale>> = {
  m: { dimension: 'length', factor: 1 },
  mm: { dimension: 'length', factor: 0.001 },
  cm: { dimension: 'length', factor: 0.01 },
  km: { dimension: 'length', factor: 1000 },
  μm: { dimension: 'length', factor: 1e-6 },
  um: { dimension: 'length', factor: 1e-6 },
  nm: { dimension: 'length', factor: 1e-9 },
  米: { dimension: 'length', factor: 1 },
  毫米: { dimension: 'length', factor: 0.001 },
  厘米: { dimension: 'length', factor: 0.01 },
  千米: { dimension: 'length', factor: 1000 },
  微米: { dimension: 'length', factor: 1e-6 },
  纳米: { dimension: 'length', factor: 1e-9 },
  g: { dimension: 'mass', factor: 1 },
  mg: { dimension: 'mass', factor: 0.001 },
  kg: { dimension: 'mass', factor: 1000 },
  t: { dimension: 'mass', factor: 1e6 },
  克: { dimension: 'mass', factor: 1 },
  毫克: { dimension: 'mass', factor: 0.001 },
  千克: { dimension: 'mass', factor: 1000 },
  吨: { dimension: 'mass', factor: 1e6 },
  l: { dimension: 'volume', factor: 1 },
  ml: { dimension: 'volume', factor: 0.001 },
  升: { dimension: 'volume', factor: 1 },
  毫升: { dimension: 'volume', factor: 0.001 },
  s: { dimension: 'time', factor: 1 },
  min: { dimension: 'time', factor: 60 },
  h: { dimension: 'time', factor: 3600 },
  秒: { dimension: 'time', factor: 1 },
  分钟: { dimension: 'time', factor: 60 },
  小时: { dimension: 'time', factor: 3600 },
  天: { dimension: 'time', factor: 86400 },
  日: { dimension: 'time', factor: 86400 },
  周: { dimension: 'time', factor: 604800 },
  '°': { dimension: 'temperature', factor: 1 },
  度: { dimension: 'temperature', factor: 1 },
  pa: { dimension: 'pressure', factor: 1 },
  kpa: { dimension: 'pressure', factor: 1000 },
  mpa: { dimension: 'pressure', factor: 1e6 },
  帕: { dimension: 'pressure', factor: 1 },
  千帕: { dimension: 'pressure', factor: 1000 },
  兆帕: { dimension: 'pressure', factor: 1e6 },
  '%': { dimension: 'ratio', factor: 1 },
  mol: { dimension: 'amount', factor: 1 },
  摩尔: { dimension: 'amount', factor: 1 },
}

/**
 * 单位归一：摄氏度四种写法统一为 `°`，全角百分号 `％` 统一为 `%`，其余原样返回。
 * @param unit - 待归一的单位文本（大小写均可）。
 * @returns 归一后的单位。
 */
export function normalizeNumericUnit(unit: string): string {
  if (unit === '℃' || unit.toLowerCase() === '°c') return '°'
  return unit === '％' ? '%' : unit
}

/**
 * 查询归一后单位的量纲与换算比例。
 * @param unit - 归一后的单位文本。
 * @returns 单位换算信息；表外单位返回 undefined。
 */
export function resolveNumericUnit(unit: string): NumericUnitScale | undefined {
  return NUMERIC_UNIT_SCALES[unit]
}

/**
 * 各单位写法对应的规范键：同一单位的中英文写法归到同一个键（`毫米`→`mm`、`度`→`°`）。
 *
 * 键只表示「写的是同一个单位」，不做量纲换算：`米` 与 `毫米` 仍是两个键，换比例由
 * {@link resolveNumericUnit} 给出。用于比较两处文本是否写了相同单位的相同数值
 * （权利要求特征覆盖、端点/中点比对），不能用于判断两个量是否相等。
 */
const CANONICAL_UNIT_KEYS: Readonly<Record<string, string>> = {
  毫米: 'mm',
  厘米: 'cm',
  千米: 'km',
  微米: 'um',
  纳米: 'nm',
  米: 'm',
  毫克: 'mg',
  千克: 'kg',
  克: 'g',
  吨: 't',
  毫升: 'ml',
  升: 'l',
  分钟: 'min',
  小时: 'h',
  秒: 's',
  天: 'd',
  日: 'd',
  度: '°',
  千帕: 'kpa',
  兆帕: 'mpa',
  帕: 'pa',
  摩尔: 'mol',
}

/**
 * 单位的规范键：先按 {@link normalizeNumericUnit} 归一并统一小写，再映射为跨写法相同的键。
 * @param unit - 原文单位写法（大小写均可）。
 * @returns 规范键；表外写法返回归一后的小写写法。
 */
export function canonicalNumericUnit(unit: string): string {
  const normalized = normalizeNumericUnit(unit.trim().toLowerCase())
  return CANONICAL_UNIT_KEYS[normalized] ?? normalized
}
