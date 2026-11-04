/**
 * 声明式「团队角色 → Worker 契约」映射（移植自 sati 团队角色表）。
 *
 * 团队角色（case-manager / researcher / …）是作业立场单元，与专业处理单元
 * （defaultPatentWorkers 的 worker）是「多对多」：一个角色承接一到多个 worker。
 * 本文件只保留薄映射：角色元信息（立场/职责/越界/是否触发 HITL）+ workers 引用，
 * 供 patent-teams 在成员 persona 注入与任务完成验收时解析。不改工具白名单、不改分派。
 */

import { defaultPatentWorkers, type WorkerContract } from './worker-contract.ts'

/** 团队角色立场纪律：用于越界判断与角色简报。 */
export type RoleStance =
  | 'neutral'
  | 'agent-side'
  | 'examiner'
  | 'applicant'
  | 'defense'
  | 'attacker'
  | 'judge'

/** 一个团队角色对应的职责契约（引用 defaultPatentWorkers 的 worker 名）。 */
export interface RoleContract {
  /** SKILL.md 角色 id（case-manager / researcher / drafter / …）。 */
  role: string
  /** 展示名（案件管理员 / 检索员 / …）。 */
  name: string
  /** 立场纪律：裁判不参与任一方起草、技术专家不评法律、案件管理员不评技术内容。 */
  stance: RoleStance
  /** 一句话职责。 */
  description: string
  /** 该角色承接的处理单元（引用 defaultPatentWorkers 的 worker 名）。 */
  workers: string[]
  /** 越界禁止（人话，进 persona）。 */
  forbiddenActions: string[]
  /** 涉及人工确认时是否触发 HITL。 */
  triggersHITL: boolean
}

/**
 * 内置团队角色目录（14 角色，与 patent-team-composition SKILL 角色总表一一对应）。
 * @returns 全部 14 个角色契约。
 */
export function defaultRoleContracts(): RoleContract[] {
  return [
    {
      role: 'case-manager',
      name: '案件管理员',
      stance: 'neutral',
      description: '立案登记与案卷目录、交底书接收、反馈申请人补充资料循环、期限/节点监控、补充合格判定',
      workers: ['case-manager'],
      forbiddenActions: ['不评技术或法律实体内容', '不代写任何文书'],
      triggersHITL: false,
    },
    {
      role: 'researcher',
      name: '检索员',
      stance: 'neutral',
      description: '证据/现有技术检索与核实：先按功能产出命名族清单（同一功能 ≥3 个不同成词族）与正交维度计划，再调用 patent_analysis_report 做 IPC 分类取得建议检索策略，据此构造含 IPC 限定的布尔检索式以收窄结果（避免命中过多），并核实公开内容、参数数值、来源可得性；覆盖度评估；可专利性初判',
      workers: ['patent-search-commander'],
      forbiddenActions: ['不擅自下新颖性/创造性实体结论（检索只提供证据与初判）'],
      triggersHITL: false,
    },
    {
      role: 'drafter',
      name: '撰写员',
      stance: 'agent-side',
      description: '案件理解（PFIE 四元组）、文书起草（申请文件/答复稿/补正书/复审请求书/请求书/诉状）、逐特征比对；撰写与答复场景复核 manifest 产出的策略表与确定性权利要求草稿，指出越界或漏特征，不重写',
      workers: ['patent-technical-analyzer', 'patent-oa-writer'],
      forbiddenActions: ['不代对方起草（对抗场景反之立场）', '不重写策略表或确定性渲染的权利要求草稿（改动走重跑 manifest）'],
      triggersHITL: true,
    },
    {
      role: 'technical-expert',
      name: '技术专家',
      stance: 'agent-side',
      description: '技术真实性核验：交底书可实施性、实施例与效果数据、参数合理性；识别夸大/虚构技术陈述',
      workers: ['patent-technical-analyzer'],
      forbiddenActions: ['不评法律论证'],
      triggersHITL: false,
    },
    {
      role: 'adversarial-reviewer',
      name: '对立审查员',
      stance: 'examiner',
      description: '授权审查视角红队评审：区别特征认定、技术启示、效果证据、程序表述、法条核验；撰写场景复核换位审查（draft_review）与 A26.3/A26.4 判定，答复场景复核答复计划薄弱点（adversary-model）与定稿复评（adversary-review）',
      workers: ['patent-novelty-analyzer', 'patent-inventiveness-analyzer'],
      forbiddenActions: ['不代任一方起草'],
      triggersHITL: true,
    },
    {
      role: 'applicant-counsel',
      name: '申请人代理',
      stance: 'applicant',
      description: '权利要求范围最大化：扩张机会、从权布局、合并修改备选、争辩策略；撰写场景只读复核 manifest 的策略表与从权树，建议交 HITL，不直接改策略表',
      workers: ['applicant-counsel'],
      forbiddenActions: ['不代对方起草'],
      triggersHITL: true,
    },
    {
      role: 'formal-examiner',
      name: '形式审查员',
      stance: 'examiner',
      description: '形式缺陷清单核验：文件齐全性、格式规范、附图清晰度、著录项目、签字盖章；权利要求编号结构核验（claim_lint：编号连续、引用方向、多项从属引用基础）；补正彻底性判定',
      workers: ['formal-examiner'],
      forbiddenActions: ['不评实体内容', '不代写文书'],
      triggersHITL: false,
    },
    {
      role: 'invalidity-petitioner',
      name: '无效请求人',
      stance: 'attacker',
      description: '无效理由地图（A22.2/22.3/22.4/26.3/26.4/33、A2/A5/A25、细则23.2/49、A9）、证据组合与成功率最大化、预判专利权人应对',
      workers: ['invalidity-petitioner'],
      forbiddenActions: ['不代专利权人答辩'],
      triggersHITL: true,
    },
    {
      role: 'patentee-defender',
      name: '专利权人',
      stance: 'defense',
      description: '无效：质证请求人证据三性、提交反证、修改权利要求缩小范围换维持；诉讼：全面覆盖+等同主张、判赔计算；质证发现无效理由存在根本缺陷（自相矛盾、法条路径错误）时，须给出「撤销/改换法条路径/保留」三选一裁定，不得只作措辞修补',
      workers: ['patentee-defender'],
      forbiddenActions: ['不代请求人主张'],
      triggersHITL: true,
    },
    {
      role: 'adjudicator',
      name: '合议组/裁判',
      stance: 'judge',
      description: '程序规则核验（前置审查/口审/庭审/举证期限/证据规则）、双方论点对抗评估、证据采信、结果预判与理由；发现无效理由存在根本缺陷（自相矛盾、法条路径错误）时，须给出「撤销/改换法条路径/保留」三选一裁定，不得只作措辞修补',
      workers: ['adjudicator'],
      forbiddenActions: ['不参与任一方策略起草'],
      triggersHITL: true,
    },
    {
      role: 'defendant-counsel',
      name: '被告代理人',
      stance: 'defense',
      description: '不侵权/现有技术抗辩、禁反言与捐献排除等同、提无效反制、豁免抗辩',
      workers: ['defendant-counsel'],
      forbiddenActions: ['不代原告主张'],
      triggersHITL: true,
    },
    {
      role: 'tech-investigator',
      name: '技术调查官',
      stance: 'neutral',
      description: '实施例/特征比对/等同的技术维度独立判断，与"技术专家"的我方立场区分',
      workers: ['tech-investigator'],
      forbiddenActions: ['不评法律结论', '不代任一方主张'],
      triggersHITL: false,
    },
    {
      role: 'illustrator',
      name: '制图员',
      stance: 'neutral',
      description:
        '附图的唯一权威产出与核验：按案情出图（结构示意图/流程图/框图/层级图/状态图/电路图/曲线图/剖视图/时序图/外观设计视图排布，三维模型走结构线稿）、维护附图标记表（细则第二十一条第二款双向一致的唯一标记源）、标号回填、图文双向一致性核验、形式要件核验（图号正下方、除必需词语外无注释、色彩与落版尺寸）、答复/补正/复审场景的附图修改执行',
      workers: ['patent-illustrator'],
      forbiddenActions: ['不改权利要求布局与保护范围', '不改说明书与答复稿的实体内容（只负责图面与标号）', '不评新颖性/创造性'],
      triggersHITL: true,
    },
    {
      role: 'document-specialist',
      name: '文档专员',
      stance: 'neutral',
      description:
        '按场景输出正式交付文档：场景→模板映射（专利性意见/检索报告/OA答复/权利要求书+说明书/补正书/复审请求书/无效意见/侵权比对意见/诉讼文书）、矫正（术语一致性/法条引用格式与出处/数字日期期限/编号层级/文书称谓）、美化（模板渲染/品牌注入/A4 版式/md 起草→html/pdf 或 docx）',
      workers: ['patent-document-renderer'],
      forbiddenActions: ['不改实体结论（权利要求布局/无效理由组合/诉请金额等）', '不代任一立场起草策略内容'],
      triggersHITL: true,
    },
  ]
}

/**
 * 按角色 id 查询职责契约。
 * @param role - SKILL.md 角色 id（如 `researcher`）。
 * @returns 对应职责契约；未注册角色时为 undefined。
 */
export function roleContract(role: string): RoleContract | undefined {
  return defaultRoleContracts().find(contract => contract.role === role)
}

/**
 * 解析一个角色实际承接的 worker 契约对象列表。
 * @param role - SKILL.md 角色 id。
 * @returns 该角色引用的 worker 契约；未注册角色时为空数组。
 */
export function roleWorkers(role: string): WorkerContract[] {
  const contract = roleContract(role)
  if (contract === undefined) return []
  const byName = new Map(defaultPatentWorkers().map(worker => [worker.name, worker]))
  return contract.workers.map((name) => {
    const worker = byName.get(name)
    /* v8 ignore next -- defaultRoleContracts references only registered workers */
    if (worker === undefined) throw new Error(`role "${role}" references unknown patent worker "${name}"`)
    return worker
  })
}

/**
 * Join all required deliverable fields across the workers a role resolves to.
 * @param role - SKILL.md role id.
 * @returns the '、'-joined required-field list, or '' when the role is unregistered
 *   or a worker declares no required fields.
 */
export function workerDeliverables(role: string): string {
  // The nullish fallbacks are defensive only: WorkerRegistry.verify() enforces
  // outputs + requiredFields on every registered worker, so the `??` branches
  // are unreachable for the shipped catalog; the join contract is asserted by
  // the role-contracts spec.
  /* v8 ignore next -- shipped workers always declare outputs.requiredFields */
  return roleWorkers(role)
    .flatMap(worker => (worker.outputs ?? []).flatMap(output => output.requiredFields ?? []))
    .join('、')
}

/**
 * Join the tools a role's workers declare, deduplicated in declaration order.
 *
 * The member persona renders this list, so a member learns which tools its role
 * owns. Nothing enforces it: `allowedTools` has no runtime consumer, and the
 * only restriction path is the `deny` filter that hides captain-only team tools.
 * @param role - SKILL.md role id.
 * @returns the '、'-joined tool list, or '' when the role is unregistered or its
 *   workers declare no tools.
 */
export function workerTools(role: string): string {
  /* v8 ignore next -- every registered worker declares allowedTools; the field is optional only for external contracts */
  return [...new Set(roleWorkers(role).flatMap(worker => worker.allowedTools ?? []))].join('、')
}

/**
 * 按 worker 名解析其契约。
 * @param name - worker 契约名（如 `patent-search-commander`）。
 * @returns worker 契约；未注册时 undefined。
 */
export function workerContract(name: string): WorkerContract | undefined {
  return defaultPatentWorkers().find(worker => worker.name === name)
}
