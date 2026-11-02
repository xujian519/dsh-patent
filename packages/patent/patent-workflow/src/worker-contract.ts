/**
 * 声明式 Worker 契约系统（移植自 Mady agentcore/worker/contract.go + catalog.go）。
 *
 * Worker 是带显式 Input/Output 契约的专利专业子任务单元：
 *   - 五层 tier 分类（work/provision/reasoning/domain/checker）
 *   - Input/Output 契约声明（contentSchema 字段必须出现）
 *   - ContractLevel（hard 必须满足 / soft 可协商 / structured 结构化格式）
 *   - 校验失败写降级标记（DegradationMark）而非中断执行
 *   - Registry 注册完备性校验 + 懒激活
 */

import { CASE_ROOT_REL, caseOutputsDir } from '@deepseek-ai/dsh-patent-core'

/** Worker 分层：work 工序 / provision 条款 / reasoning 推理 / domain 领域 / checker 复核。 */
export type WorkerTier = 'work' | 'provision' | 'reasoning' | 'domain' | 'checker'

/** 契约严格度：hard 必须满足 / soft 可协商 / structured 结构化格式。 */
export type ContractLevel = 'hard' | 'soft' | 'structured'

/** Worker 输入契约（路径/内容模式/质量检查/可选性）。 */
export type WorkerInputContract = {
  /** 期望输入（路径或描述，可含 {caseId} 占位） */
  path: string
  /** 输入中必须出现的字段/内容模式 */
  contentSchema?: string[]
  /** 关联质量检查 ID */
  qualityGate?: string
  /** 是否可选输入（默认 false） */
  optional?: boolean
  description?: string
}

/** Worker 输出契约（路径/格式/必需字段/严格度）。 */
export type WorkerOutputContract = {
  /** 期望输出路径（可含 {caseId} 占位） */
  path: string
  /** 输出格式："markdown" | "json" */
  format?: 'markdown' | 'json'
  /** 输出中必须出现的字段（contentSchema 的硬性版本） */
  requiredFields?: string[]
  /** 契约严格度 */
  contractLevel?: ContractLevel
}

/** 声明式 Worker 契约（名称、分层、描述、输入输出契约、工具与委派、HITL、注册时机）。 */
export type WorkerContract = {
  name: string
  tier: WorkerTier
  description: string
  /** 允许调用的工具（空 = 不限制） */
  allowedTools?: string[]
  inputs?: WorkerInputContract[]
  outputs?: WorkerOutputContract[]
  /** 禁止行为 */
  forbiddenActions?: string[]
  /** 可委派的其他 worker */
  canInvoke?: string[]
  /** 输出是否要求人工审批 */
  triggersHITL?: boolean
  /** 是否启动时注册（false = 懒激活） */
  preRegister?: boolean
}

/** Worker 输出校验结果（硬/软缺失字段、是否降级及原因）。 */
export type WorkerOutputValidation = {
  workerName: string
  valid: boolean
  /** 硬性契约缺失字段（contractLevel=hard 或 requiredFields 未满足） */
  missingHardFields: string[]
  /** 软性契约缺失字段 */
  missingSoftFields: string[]
  /** 输出是否被降级标记（不中断执行） */
  degraded: boolean
  degradationReason?: string | undefined
}

/**
 * Worker 单次执行记录（输入输出有效性、是否降级、起止与耗时）。
 * 经包入口 `export *` 挂在 `@deepseek-ai/dsh-patent-workflow` 公开面上，供外部编排读取 worker 遥测。
 */
export type WorkerExecutionRecord = {
  workerName: string
  inputValid: boolean
  outputValid: boolean
  degraded: boolean
  startedAt: number
  durationMs: number
  note?: string
}

/** Worker 注册表错误（重复注册 / 缺失字段）。 */
export class WorkerRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerRegistryError'
  }
}

/** Worker 注册表：注册、查询、完整性校验、懒激活。 */
export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerContract>()
  private readonly active = new Set<string>()

  /**
   * 注册 worker（重复注册或缺失 name/tier/description 时抛错；preRegister 默认激活）。
   * @param definition - worker 契约。
   */
  register(definition: WorkerContract): void {
    if (this.workers.has(definition.name)) {
      throw new WorkerRegistryError(`Worker "${definition.name}" already registered`)
    }
    if (!definition.name.trim() || !definition.description.trim()) {
      throw new WorkerRegistryError(`Worker "${definition.name}" missing name/tier/description`)
    }
    this.workers.set(definition.name, definition)
    if (definition.preRegister !== false) {
      this.active.add(definition.name)
    }
  }

  /**
   * 按名称查询 worker。
   * @param name - worker 名称。
   * @returns worker 契约；未注册时为 undefined。
   */
  get(name: string): WorkerContract | undefined {
    return this.workers.get(name)
  }

  /**
   * 懒激活：首次使用时注册（未预注册的 worker）。
   * @param name - worker 名称。
   * @returns 对应 worker 契约，未注册时为 undefined。
   */
  activate(name: string): WorkerContract | undefined {
    const def = this.workers.get(name)
    if (def) this.active.add(name)
    return def
  }

  /**
   * 判断 worker 是否已激活。
   * @param name - worker 名称。
   * @returns 是否已激活。
   */
  isActive(name: string): boolean {
    return this.active.has(name)
  }

  /**
   * 按分层列出 worker。
   * @param tier - worker 分层。
   * @returns 该分层下的 worker 契约列表。
   */
  listByTier(tier: WorkerTier): WorkerContract[] {
    return [...this.workers.values()].filter(w => w.tier === tier)
  }

  /**
   * 列出全部已注册 worker。
   * @returns worker 契约列表。
   */
  list(): WorkerContract[] {
    return [...this.workers.values()]
  }

  /**
   * 注册完备性校验：返回所有 worker 的契约缺陷（不抛出）。
   * @returns 契约缺陷清单（outputs 缺失或 hard 输出缺 requiredFields）。
   */
  verify(): string[] {
    const issues: string[] = []
    for (const w of this.workers.values()) {
      if (!w.outputs || w.outputs.length === 0) {
        issues.push(`Worker "${w.name}" 未声明 outputs 契约`)
      }
      const hardOutputs = (w.outputs ?? []).filter(o => o.contractLevel === 'hard' || o.contractLevel === undefined)
      for (const o of hardOutputs) {
        if (!o.requiredFields || o.requiredFields.length === 0) {
          issues.push(`Worker "${w.name}" 的 hard 输出契约缺少 requiredFields（${o.path}）`)
        }
      }
    }
    return issues
  }
}

/**
 * 校验 worker 输出：按契约检查 requiredFields 是否以子串形式出现在输出文本中。
 * 硬性缺失 → 降级标记（degraded），不抛错不中断。
 * @param worker - worker 契约。
 * @param outputText - 输出文本。
 * @param outputPath - 可选输出路径（用于降级原因描述）。
 * @returns 输出校验结果。
 */
export function validateWorkerOutput(
  worker: WorkerContract,
  outputText: string,
  outputPath?: string,
): WorkerOutputValidation {
  const missingHard: string[] = []
  const missingSoft: string[] = []

  for (const out of worker.outputs ?? []) {
    const fields = out.requiredFields ?? []
    if (out.contractLevel === 'soft') {
      missingSoft.push(...fields.filter(f => !outputText.includes(f)))
      continue
    }
    // hard / structured（默认）都必须出现
    missingHard.push(...fields.filter(f => !outputText.includes(f)))
  }

  const degraded = missingHard.length > 0
  return {
    workerName: worker.name,
    valid: missingHard.length === 0,
    missingHardFields: missingHard,
    missingSoftFields: missingSoft,
    degraded,
    degradationReason: degraded
      ? `硬性契约字段缺失: ${missingHard.join('、')}（输出 ${outputPath ?? '?'}）`
      : undefined,
  }
}

/**
 * 内置专利 worker 目录（移植 Mady DefaultWorkers 的专利相关条目，工具名适配 Sati）。
 * @returns 内置专利 worker 契约列表。
 */
export function defaultPatentWorkers(): WorkerContract[] {
  return [
    ...analysisWorkers(),
    ...prosecutionWorkers(),
    ...disputeWorkers(),
    ...deliverableWorkers(),
  ]
}

/**
 * 前端分析 worker：技术交底书分析、检索策略与执行、新颖性与创造性判断。
 * @returns 分析阶段的内置 worker 契约。
 */
function analysisWorkers(): WorkerContract[] {
  return [
    {
      name: 'patent-technical-analyzer',
      tier: 'work',
      description: '分析技术交底书，提取 PFIE 四元组（技术问题/发明认知/技术特征/技术效果）',
      allowedTools: ['read', 'web_fetch'],
      inputs: [{ path: `${CASE_ROOT_REL}/{caseId}/disclosure/*.md`, description: '技术交底书' }],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/technical-analysis.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['技术问题', '技术特征', '技术效果'],
        },
      ],
      forbiddenActions: ['claim_strategy', 'draft_claims', 'draft_specification'],
      triggersHITL: false,
    },
    {
      name: 'patent-search-commander',
      tier: 'domain',
      description: '制定检索策略并执行专利检索：先按功能产出命名族清单（同一功能 ≥3 个不同成词族）与正交维度计划，再经 patent_analysis_report 做 IPC 分类并取得建议检索策略，据此构造含 IPC 限定的布尔检索式，输出检索报告',
      allowedTools: [
        'patent_search',
        'patent_metadata',
        'patent_legal_status',
        'web_search',
        'web_fetch',
        'patent_analysis_report',
        'patent_eval',
      ],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/search-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          // 命名族清单与正交维度是检索完备性的前置声明：锚点若只从发明方案术语推导，
          // 会系统性漏掉用不同词表述同一功能的在先文献；只跑关键词而不跑 IPC/引证/同族等
          // 正交维度，同义词再多也覆盖不了分类号体系。两者都由完成的合成门禁校验。
          requiredFields: ['检索式', '对比文件', '公开日', '命名族清单', '正交维度'],
        },
      ],
      triggersHITL: false,
    },
    {
      name: 'patent-novelty-analyzer',
      tier: 'reasoning',
      description: '新颖性（A22.2）逐特征比对，输出结论与置信度',
      allowedTools: ['patent_eval', 'read'],
      canInvoke: ['patent-search-commander', 'patent-technical-analyzer'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/novelty-analysis.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['新颖性结论', '置信度'],
        },
      ],
      triggersHITL: true,
    },
    {
      name: 'patent-inventiveness-analyzer',
      tier: 'reasoning',
      description: '创造性（A22.3）三步法分析：最接近现有技术→区别技术特征→技术启示，输出结论与置信度',
      allowedTools: ['patent_eval', 'read'],
      canInvoke: ['patent-search-commander', 'patent-technical-analyzer'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/inventiveness-analysis.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: [
            '最接近的现有技术',
            '区别技术特征',
            '实际解决的技术问题',
            '技术启示',
            '创造性结论',
            '置信度',
          ],
        },
      ],
      triggersHITL: true,
    },
  ]
}

/**
 * 申请与审查阶段 worker：意见陈述撰写、产出质量复核、案件流程管理、申请人代理、形式审查。
 * @returns 申请审查阶段的内置 worker 契约。
 */
function prosecutionWorkers(): WorkerContract[] {
  return [
    {
      /**
       * 口径锚点（2026-10-16 审阅甲6）：确定性执行面＝manifest
       * `patent_oa_response_v1`（`patent_workflow_run` 的阶段记录＝收口依据）；
       * `patent-oa-writer`＝团队组装面作业角色（产出按 requiredFields 校验）。
       * 两者并行、互不派发：worker 不派发 manifest，manifest 不派发 worker。
       */
      name: 'patent-oa-writer',
      tier: 'work',
      description: '审查意见答复：解析 OA、制定策略、撰写意见陈述书',
      allowedTools: ['read', 'write', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/oa-response.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['意见陈述', '修改对照'],
        },
      ],
      triggersHITL: true,
    },
    {
      name: 'quality_checker',
      tier: 'checker',
      description: '专利产出质量复核：patent_eval 预检 + 评分判定',
      allowedTools: ['patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/quality-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['质量评分', '通过'],
        },
      ],
      triggersHITL: false,
    },
    {
      name: 'case-manager',
      tier: 'work',
      description:
        '案件管理员（流程中立）：立案登记与案卷目录、交底书接收、反馈申请人补充资料循环、期限/节点监控、补充合格判定',
      allowedTools: ['read', 'write', 'patent_case_search'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/case-manager-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['案卷目录', '期限节点', '补充清单'],
        },
      ],
      forbiddenActions: ['claim_strategy', 'draft_claims', 'draft_specification', 'novelty_analysis', 'inventiveness_analysis'],
      triggersHITL: false,
    },
    {
      name: 'applicant-counsel',
      tier: 'provision',
      description:
        '申请人代理（申请人方）：权利要求范围最大化、扩张机会识别、从权布局、合并修改备选、争辩策略',
      allowedTools: ['read', 'write', 'patent_case_search', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/applicant-counsel-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['范围扩张机会', '从权布局', '争辩策略'],
        },
      ],
      forbiddenActions: ['claim_strategy', 'draft_claims', 'draft_specification'],
      triggersHITL: true,
    },
    {
      name: 'formal-examiner',
      tier: 'checker',
      description:
        '形式审查员（初步审查方）：形式缺陷清单核验、文件齐全性、格式规范、附图清晰度、著录项目、签字盖章、补正彻底性判定',
      allowedTools: ['read', 'write', 'patent_case_search', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/formal-examiner-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['形式缺陷清单', '完善性判定'],
        },
      ],
      forbiddenActions: ['claim_strategy', 'draft_claims', 'draft_specification', 'novelty_analysis', 'inventiveness_analysis'],
      triggersHITL: false,
    },
  ]
}

/**
 * 无效与诉讼程序 worker：无效请求人、专利权人、被告代理人、合议组。
 * @returns 争议阶段的内置 worker 契约。
 */
function disputeWorkers(): WorkerContract[] {
  return [
    {
      name: 'invalidity-petitioner',
      tier: 'reasoning',
      description:
        '无效请求人（攻击方）：无效理由地图（A22.2/22.3/22.4/26.3/26.4/33、A2/A5/A25、细则23.2/49、A9）、证据组合与成功率最大化、预判专利权人应对',
      allowedTools: ['patent_search', 'patent_case_search', 'patent_legal_status', 'read', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/invalidity-petitioner-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['无效理由', '证据组合', '成功率评估'],
        },
      ],
      forbiddenActions: ['draft_specification'],
      triggersHITL: true,
    },
    {
      name: 'patentee-defender',
      tier: 'reasoning',
      description:
        '专利权人（防御/主张方）：无效时质证请求人证据三性、提交反证、修改权利要求缩小范围换维持；诉讼时全面覆盖+等同主张、判赔计算',
      allowedTools: ['read', 'write', 'patent_case_search', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/patentee-defender-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['质证意见', '反证清单', '修改权利要求方案'],
        },
      ],
      triggersHITL: true,
    },
    {
      name: 'defendant-counsel',
      tier: 'provision',
      description:
        '被告代理人（抗辩方）：不侵权/现有技术抗辩、禁反言与捐献排除等同、提无效反制、豁免抗辩',
      allowedTools: ['read', 'patent_case_search', 'patent_search', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/defendant-counsel-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['不侵权主张', '现有技术抗辩', '等同排除理由'],
        },
      ],
      triggersHITL: true,
    },
    {
      name: 'adjudicator',
      tier: 'reasoning',
      description:
        '合议组/裁判（中立裁判）：程序规则核验（前置审查/口审/庭审/举证期限/证据规则）、双方论点对抗评估、证据采信、结果预判与理由',
      allowedTools: ['read', 'patent_case_search', 'patent_legal_status', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/adjudicator-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['程序核验', '对抗评估', '结果预判'],
        },
      ],
      forbiddenActions: ['claim_strategy', 'draft_claims', 'draft_specification', 'novelty_analysis', 'inventiveness_analysis'],
      triggersHITL: true,
    },
  ]
}

/**
 * 中立技术与交付 worker：技术调查、附图产出、正式文档渲染。
 * @returns 交付阶段的内置 worker 契约。
 */
function deliverableWorkers(): WorkerContract[] {
  return [
    {
      name: 'tech-investigator',
      tier: 'reasoning',
      description:
        '技术调查官（中立技术查明）：实施例/特征比对/等同的技术维度独立判断，与"技术专家"的我方立场区分',
      allowedTools: ['read', 'patent_eval'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/tech-investigator-report.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['特征比对技术意见', '等同技术维度'],
        },
      ],
      forbiddenActions: ['claim_strategy', 'draft_claims', 'draft_specification', 'novelty_analysis', 'inventiveness_analysis'],
      triggersHITL: false,
    },
    {
      name: 'patent-illustrator',
      tier: 'work',
      description:
        '制图员（流程中立）：附图的唯一权威产出与核验——按案情出图（结构示意图/流程图/框图/层级图/状态图/电路图/曲线图/剖视图/时序图/外观设计视图排布，三维模型走结构线稿），维护附图标记表（细则第二十一条第二款图文双向一致的唯一标记源），标号回填，图文双向一致性核验，形式要件核验（图号位于附图正下方、除必需词语外无注释、色彩与落版尺寸）',
      allowedTools: [
        'read',
        'write',
        'generate_patent_figure',
        'generate_structure_figure',
        'add_patent_figure_references',
        'analyze_patent_figure',
        'search_patent_figure',
        'validate_specification',
      ],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/figure-deliverable.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['附图文件', '附图标记表', '图文一致性', '形式要件核验'],
        },
      ],
      forbiddenActions: ['不改实体结论（权利要求布局/保护范围/修改方案）', '不评新颖性/创造性', '不代任一立场起草策略内容'],
      triggersHITL: true,
    },
    {
      name: 'patent-document-renderer',
      tier: 'work',
      description:
        '文档专员（流程中立）：按场景把已定稿内容组织成正式交付文档——选择场景模板（专利性意见/检索报告/OA答复/权利要求书+说明书/补正书/复审请求书/无效意见/侵权比对意见/诉讼文书），矫正（术语一致性、法条引用格式与出处、数字/日期/期限、编号层级、文书称谓），美化（模板渲染、品牌注入、A4 版式、md 起草→html/pdf 或 docx 交付）',
      allowedTools: ['read', 'write', 'render_patent_document'],
      outputs: [
        {
          path: `${caseOutputsDir('{caseId}')}/document-deliverable.md`,
          format: 'markdown',
          contractLevel: 'hard',
          requiredFields: ['交付场景', '矫正清单', '渲染产物'],
        },
      ],
      forbiddenActions: ['不改实体结论（权利要求布局/无效理由组合/诉请金额等）', '不代任一立场起草策略内容'],
      triggersHITL: true,
    },
  ]
}
