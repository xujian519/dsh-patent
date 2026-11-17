/**
 * claim-chart 协议层：权利要求要素级证据网格（Claim Chart）的数据契约。
 *
 * 行业标准依据（见 spec）：两列表（左=要素编号 verbatim，右=证据 pin-cite）、
 * mapping 状态机、gap list 第一优先输出、draft notice 免责声明。
 */

import type { ClaimReferenceDefect } from '../../claim-lint/references.ts'

/** 权利要求要素在图表中的角色：前序、过渡、限定、手段加功能或马库什成员。 */
export type ElementKind = 'preamble' | 'transitional' | 'limitation' | 'means-plus-function' | 'markush-member'

/** 单个权利要求要素：从权利要求原文连续子串拆出的最小映射单元。 */
export interface ClaimElement {
  /** 稳定编号（表脊），如 "1a"/"1b"/"2a"；格式：数字+小写字母。 */
  id: string
  /** 权利要求序号（与 id 前缀一致）。 */
  claimNo: number
  /** 要素原文，必须是权利要求原文的连续子串（element-validator 强制）。 */
  text: string
  kind: ElementKind
  /** 需 claim construction 的争议术语（可选）。 */
  disputedTerm?: string
}

/** 图表分析模式：侵权/无效/OA 答复/复审/可专利性。 */
export type ChartMode = 'infringement' | 'invalidity' | 'oa-response' | 'reexamination' | 'patentability'

/** 映射目标类型：对比文件或涉嫌侵权产品。 */
export type TargetKind = 'prior-art' | 'accused-product'

/** 映射目标（对比文件/产品证据）：id、类型与可选源文路径。 */
export interface ChartTarget {
  /** "D1"/"D2"/"产品A"。 */
  id: string
  kind: TargetKind
  /** 对比文件 converted 全文 / 产品材料文件路径（pin-cite 校验数据源，可选）。 */
  sourcePath?: string
  title?: string
}

/** 行级映射结论（mapping 状态机的取值全集）。 */
export type Mapping =
  | 'literal'
  | 'literal-construction-dependent'
  | 'doe'
  | 'anticipation'
  | 'obviousness-combination'
  | 'partial'
  | 'not-found'
  | 'needs-evidence'
  | 'construction-dependent'

/**
 * 全部映射结论取值（运行时校验与 JSON schema 枚举共用）。
 *
 * 新增映射时与 {@link Mapping} 联合类型一起维护。
 */
export const MAPPINGS: readonly Mapping[] = [
  'literal',
  'literal-construction-dependent',
  'doe',
  'anticipation',
  'obviousness-combination',
  'partial',
  'not-found',
  'needs-evidence',
  'construction-dependent',
]

/**
 * 判定映射结论是否为已知取值。
 * @param value - 待判定的值。
 * @returns 值是否为 `Mapping`。
 */
export function isMapping(value: unknown): value is Mapping {
  return typeof value === 'string' && MAPPINGS.some(entry => entry === value)
}

/** 行状态：与 Mapping 同值，承载行的当前映射结论。 */
export type RowState = Mapping

/** 单行映射：要素 id + 目标 id + verbatim 引用 + pin-cite + 映射结论。 */
export interface ChartRow {
  elementId: string
  targetId: string
  /** 目标（对比文件/产品证据）verbatim 引用。 */
  quote: string
  /**
   * "[D1 段[0032] 图3]" 形式（pin-cite-validator 强制格式；目标 id 可含空格、
   * 段号可写范围、可多图）。源文带 `[xxxx]` 段号标记时必须能在源文定位，源文
   * 没有这种标记（如 Google Patents 转存文本）时段号存在性不核对。
   */
  pinCite: string
  mapping: Mapping
  state: RowState
  /** HITL 核验标记；重跑时保留已核验行。 */
  verified: boolean
  note?: string
}

/**
 * 缺口类别：`Mapping` 中证据薄弱的取值，加上"要素与目标的组合没有映射行"（unevaluated）。
 *
 * `unevaluated` 与 `not-found` 不是同一件事：前者是分析没有触及该组合（图表对该格的结论
 * 无从复核），后者是分析触及了并得出"未找到对应内容"。两者的补救动作也不同。
 */
export type GapKind = 'unevaluated' | 'not-found' | 'needs-evidence' | 'partial'

/** 缺口条目：证据薄弱或未被评估的要素/目标组合，附原因与建议动作。 */
export interface GapEntry {
  elementId: string
  targetId: string
  kind: GapKind
  /** 缺口原因说明。 */
  reason: string
  /** 建议动作（补充检索/证据固化/等同分析）。 */
  suggestion: string
}

/** 草稿免责声明：随交付物顶部与表格上方输出。 */
export const DRAFT_NOTICE =
  '本表为分析草稿，供代理人与律师核验使用，不构成正式法律意见或诉讼主张。每一行映射均须对照源文件人工复核。'

/** 权利要求类型。 */
export type ClaimType = 'independent' | 'dependent'

/**
 * 一条权利要求的类型与引用关系。
 *
 * 由权利要求书原文推出（`deriveClaimRefs`），不由模型填报：从属权项的比对范围是所引用
 * 权利要求的全部技术特征与附加技术特征的组合，因此覆盖判定必须知道引用关系。
 */
export interface ClaimRef {
  /** 权利要求序号。 */
  claimNo: number
  claimType: ClaimType
  /** 所引用的权利要求序号（升序去重）；独立权利要求为空数组。 */
  refersTo: number[]
  /** 引用区间写法的缺陷（倒序或跨度超限）；没有缺陷时省略。 */
  referenceDefects?: ClaimReferenceDefect[]
}

/**
 * 单条权利要求在一篇对比文件上的单篇全覆盖判定。
 *
 * 声明为类型别名而非接口：结论要作为工具输出值交给 JSON 边界（`JsonValue`），而接口没有
 * 隐式索引签名，值无法直接赋给 `JsonValue`，只能靠断言绕开。
 */
export type ClaimNoveltyCoverage = {
  /** 权利要求序号。 */
  claimNo: number
  /** 构成该权项技术方案的全部要素是否都被这一篇公开；多项从属权项任一替代方案全覆盖即为 true。 */
  covered: boolean
  /** 未覆盖的要素 id（含所引用权项的要素）；多项从属权项取缺口最少的替代方案。 */
  missing: string[]
  /** 判定是否已并入其所引用权项的要素（从属权项为 true）。 */
  includesReferredClaims: boolean
  /** 并入的所引用权项号（传递闭包）；独立权项为空数组。 */
  referredClaimNos: number[]
  /** 引用链中没有任何要素的权项号；存在时 covered 必为 false。 */
  missingReferredClaims?: number[]
  /** 多项从属权项（引用两项以上）的逐替代方案结果；单一引用或无引用时省略。 */
  alternatives?: ClaimAlternative[]
}

/** 多项从属权利要求的一个替代技术方案（每个直接引用一条）。 */
export type ClaimAlternative = {
  /** 该替代方案并入的所引用权项号（含传递闭包），升序。 */
  referredClaimNos: number[]
  /** 该替代方案的全部要素是否都被这一篇公开。 */
  covered: boolean
  /** 该替代方案未被覆盖的要素 id。 */
  missing: string[]
  /** 该替代方案引用链中没有任何要素的权项号；存在时 covered 必为 false。 */
  missingReferredClaims?: number[]
}

/** 引用关系缺陷。 */
export type ClaimRefIssue =
  | { kind: 'self-reference'; claimNo: number }
  | { kind: 'missing-reference'; claimNo: number; refersTo: number[] }
  | { kind: 'later-reference'; claimNo: number; refersTo: number[] }
  | { kind: 'reference-cycle'; claimNos: number[] }
  | { kind: 'reference-range'; claimNo: number; raw: string; problem: ClaimReferenceDefect['kind'] }

/**
 * 从属权利要求的法条路径问题：所引用权项在该篇上未被完整覆盖，而本权项自身的要素已全部
 * 被该篇覆盖——这正是"以附加技术特征被公开为由认定从属权利要求不具备新颖性"的形态。
 *
 * 该形态本身不是结论；它标记的是"若据此认定本权项不具备新颖性，则与所引用权项的结论自相
 * 矛盾"，须按所引用权项的结论改写法条路径或补足证据。
 */
export type DependentClaimPathIssue = {
  kind: 'additional-features-only'
  /** 从属权利要求序号。 */
  claimNo: number
  /** 未被完整覆盖的所引用权项号。 */
  referredClaimNo: number
  /** 该形态所在的对比文件目标 id。 */
  targetId: string
  /** 可读说明，直接进报告。 */
  detail: string
}

/** 无效／复审的确定性结论（由行级映射与引用关系算出，不调用模型）。 */
export type InvalidityConclusion = {
  /** 主对比文件 id（区别特征的比对基准）；无对比文件目标时为 undefined。 */
  primaryTargetId?: string
  /** 逐对比文件的单篇全覆盖判定（逐权利要求），按目标顺序。 */
  novelty: { targetId: string; title?: string; claims: ClaimNoveltyCoverage[] }[]
  /** 相对主对比文件的区别特征，逐权利要求；无主对比文件时为空数组。 */
  distinguishing: {
    claimNo: number
    /** 各替代方案区别特征的并集。 */
    elementIds: string[]
    /** 多项从属权项（引用两项以上）的逐替代方案区别特征；单一引用或无引用时省略。 */
    alternatives?: { referredClaimNos: number[]; elementIds: string[] }[]
  }[]
  /** 从属权项法条路径问题（逐目标逐权项）。 */
  dependentClaimIssues: DependentClaimPathIssue[]
  /** 引用关系本身的缺陷（引用不存在/不更小的权项、自引用、成环）。 */
  claimRefIssues: ClaimRefIssue[]
}

/** 权利要求对照表（Claim Chart）整体数据契约。 */
export interface ClaimChart {
  chartId: string
  mode: ChartMode
  /**
   * 无效／复审模式的确定性结论（与 `gaps` 同为图表自带的派生输出，由行级映射算出）；
   * 其余模式没有该字段。放在协议里而不是另设工作流阶段，是因为 recap 路径（调用方自己
   * 产出各阶段文本）不执行原子，多一个只能由原子产出的阶段会让每次 recap 运行都报未完成。
   */
  invalidityConclusion?: InvalidityConclusion
  caseId: string
  /** 已拆分的要素（渲染表格左列与 gap list 需要）。 */
  elements: ClaimElement[]
  claimNos: number[]
  /** 逐权利要求的类型与引用关系，按权项号升序；无法从原文推出引用关系时为空数组。 */
  claims: ClaimRef[]
  targets: ChartTarget[]
  rows: ChartRow[]
  /** 第一优先输出。 */
  gaps: GapEntry[]
  draftNotice: string
}

/** 行级映射的最小读取面：全面覆盖与等同核验只读这三列。 */
export type ChartRowMatch = Pick<ChartRow, 'elementId' | 'targetId' | 'mapping'>

/** 目标的最小读取面：全面覆盖判定只读 id 与 kind。 */
export type ChartTargetRef = Pick<ChartTarget, 'id' | 'kind'>

/** 权利要求要素的最小读取面：全面覆盖判定按 id 与所属权项号逐权项判定。 */
export type ClaimElementRef = Pick<ClaimElement, 'id' | 'claimNo'>
