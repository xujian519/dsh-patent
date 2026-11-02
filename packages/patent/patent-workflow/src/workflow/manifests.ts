/**
 * src/patent/workflow — 内置 manifest 数据（8 个 + 目录）。
 *
 * 纯数据常量，零执行依赖。类型契约（WorkflowManifest）来自 dsh-patent-core。
 *
 * 收口（未声明 atom）阶段一律用 `consumes` 列出其数据依赖的上游阶段：阶段描述与 guidance
 * 都不携带上游产出，未声明即读不到（如三步法第二步须看到第一步选定的最接近现有技术）。
 * 无效宣告与复审共用 `buildContestedManifest`：阶段骨架相同，程序口径（理由表、图表模式）
 * 由选项给定。
 */

import type { ChartMode, GroundProgram, WorkflowManifest, WorkflowStage } from '@deepseek-ai/dsh-patent-core'

/** 现有技术时间基准阶段：新颖性、披露与可专利性工作流共用。 */
const TIME_BASELINE_STAGE: WorkflowStage = {
  id: 'time_baseline',
  strategy: 'chain',
  description: '确定现有技术时间基准（申请日与优先权日较早者，A22.5/A29）',
  atom: 'time-baseline',
}

/**
 * 争议粗定位阶段：放在 parse 之前，只收集候选法条与涉及权项，让后续解析带
 * 争议过滤器。确定性原子，不调用模型。
 */
const DISPUTE_FRAMING_STAGE: WorkflowStage = {
  id: 'dispute-framing',
  strategy: 'chain',
  description: '争议粗定位（确定性）：从程序文书/已解析通知书/程序理由收集候选法条与涉及权项，不判断实体结论',
  atom: 'dispute-framing',
}

/**
 * 争议定位修正阶段：时间基准或程序理由确定后标注时间依据。原子阶段直接读共享
 * state（`reference_date` / `grounds`），不声明 `consumes`；阶段顺序保证依赖已产出。
 * @returns 修正阶段定义。
 */
function disputeFramingRefineStage(): WorkflowStage {
  return {
    id: 'dispute-framing-refine',
    strategy: 'chain',
    description: '争议定位修正（确定性）：读取已确定的时间基准/程序理由，标注候选法条的时间依据，不改写已锁定的时间基准',
    atom: 'dispute-framing-refine',
  }
}

/** 可专利客体筛查阶段：披露与可专利性工作流共用。 */
const ELIGIBILITY_STAGE: WorkflowStage = {
  id: 'eligibility',
  strategy: 'chain',
  description: '可专利客体筛查（A2/A5/A25）：纯智力活动规则、疾病诊断治疗方法、动植物品种与核变换客体',
  atom: 'eligibility',
}

/** 检索关键词阶段：新颖性、创造性与可专利性的原子检索取检索词，审查意见答复取检索策略。 */
const SEARCH_KEYWORDS_STAGE: WorkflowStage = {
  id: 'generate_keywords',
  strategy: 'chain',
  description: '生成检索关键词（上位/下位/同义词）',
  atom: 'keywords',
}

/** 公开日过滤阶段：新颖性、创造性与可专利性共用。 */
const PRIOR_ART_FILTER_STAGE: WorkflowStage = {
  id: 'prior_art_filter',
  strategy: 'chain',
  description: '按公开日过滤检索结果（A22.5）；A24 宽限期内的首次公开不构成现有技术',
  atom: 'prior-art-filter',
}

/**
 * 附图分析阶段：披露与可专利性共用。sub_agent 逐图调用 `analyze_patent_figure`，
 * 输出 JSON 数组或 `[SKIP] 原因`；随后的确定性原子把文本收口到 `figure_analysis`。
 */
const FIGURE_ANALYSIS_STAGES: readonly WorkflowStage[] = [
  {
    id: 'figure_analysis',
    strategy: 'sub_agent',
    description: '逐图分析附图（调用 analyze_patent_figure），输出 {figureNumber, usable, components:[{refNumber}]} 的 JSON 数组；无附图或视觉能力不可用时只输出 [SKIP] 原因',
    guidance: [
      '读取 state.figure_files（附图路径数组）。为空时只输出 `[SKIP] 无附图`，不得编造分析结果。',
      '对每个路径调用 `analyze_patent_figure`（参数 svg_path 或 image_path 按文件扩展名选择），逐图记录 figureNumber（1 起）、usable 与 components[].refNumber。',
      '只输出 JSON 数组本身，不要 Markdown 代码块、解释或前后缀。',
      '工具报 model_cannot_accept_image（当前模型不支持图像输入）时，只输出 `[SKIP] 视觉能力不可用`。',
    ].join('\n'),
  },
  {
    id: 'figure_analysis_parse',
    strategy: 'chain',
    description: '附图分析结果收口（确定性）：解析上一步的 JSON，写入 figure_analysis；无附图/未产出/视觉不可用时写 figure_analysis_skipped',
    atom: 'figure-analysis',
    params: { source_key: 'figure_analysis' },
  },
]

/** 说明书草案阶段：披露与可专利性共用，为 spec-check 的 spec 模式提供五部分文本。 */
const DRAFT_SPECIFICATION_STAGE: WorkflowStage = {
  id: 'draft_specification',
  strategy: 'chain',
  description: '生成五部分说明书草案（技术领域/背景技术/发明内容/附图说明/具体实施方式，确定性）',
  atom: 'draft-specification',
}

/** 引用真实性校验阶段：新颖性与创造性共用。 */
const CITATION_CHECK_STAGE: WorkflowStage = {
  id: 'citation_check',
  strategy: 'chain',
  description: '引用真实性校验（确定性）：结论引用的 D 标号/专利号须出现在过滤后的现有技术中',
  atom: 'citation-check',
}

/**
 * Revision of 《专利审查指南》 the built-in manifests target. Keep it equal to
 * `revision` in `packages/patent/patent-law/assets/law/cn-examination-guidelines.yaml`;
 * a deployment running a different shipped asset sets the patent-tools plugin's
 * `guidelineRevision` to that asset's revision so the mismatch fails at load.
 */
export const SHIPPED_GUIDELINE_REVISION = '2023 年修订版（2024-01-20 施行）'

/**
 * 内置：专利新颖性分析 manifest（镜像 Mady patent_novelty.yaml 与 novelty_chain 模板）。
 */
export const patentNoveltyManifest: WorkflowManifest = {
  id: 'patent_novelty_v1',
  guidelineRevision: SHIPPED_GUIDELINE_REVISION,
  name: '专利新颖性分析',
  caseType: 'novelty_search',
  stages: [
    DISPUTE_FRAMING_STAGE,
    {
      id: 'parse',
      strategy: 'chain',
      description: '解析技术交底书，提取技术特征（按争议粗定位只提取相关事实）',
      consumes: ['dispute-framing'],
    },
    TIME_BASELINE_STAGE,
    disputeFramingRefineStage(),
    SEARCH_KEYWORDS_STAGE,
    {
      id: 'search',
      strategy: 'react',
      description: '检索现有技术文献',
      atom: 'search',
    },
    PRIOR_ART_FILTER_STAGE,
    {
      id: 'conflicting_application',
      strategy: 'chain',
      description: '排查抵触申请（A22.2 第二句：申请日以前提出、申请日以后公布、同样的发明或者实用新型）',
      atom: 'conflicting-application',
    },
    {
      id: 'compare',
      strategy: 'chain',
      description: '逐项对比技术特征与现有技术（单独对比原则）',
      consumes: ['dispute-framing-refine', 'parse', 'time_baseline', 'search', 'prior_art_filter'],
    },
    {
      id: 'numeric_range',
      strategy: 'chain',
      description: '数值范围专项核验（指南第二部分第三章：重叠或共同端点破坏新颖性）',
      atom: 'numeric-range',
    },
    {
      id: 'conclude',
      strategy: 'chain',
      description: '生成新颖性分析结论（附置信度）',
      consumes: ['dispute-framing-refine', 'time_baseline', 'search', 'prior_art_filter', 'compare', 'conflicting_application', 'numeric_range'],
    },
    CITATION_CHECK_STAGE,
    {
      id: 'legal_gaps',
      strategy: 'chain',
      description: '法条缺口汇总：时间基准、抵触申请与新颖性结论对应法条的通过/未通过/未评估状态',
      atom: 'legal-gaps',
      params: { profile: 'novelty' },
    },
    {
      id: 'approval',
      strategy: 'chain',
      description: '人工确认分析结论',
      atom: 'approval-gate',
      params: { review_context: '新颖性分析结论需人工确认后方可交付' },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
}

/**
 * 内置：技术交底书披露分析 manifest（移植 Mady disclosure/graph.go 的 PFIE 管线）。
 */
export const patentDisclosureManifest: WorkflowManifest = {
  id: 'patent_disclosure_v1',
  guidelineRevision: SHIPPED_GUIDELINE_REVISION,
  name: '技术交底书披露分析',
  caseType: 'disclosure_analysis',
  stages: [
    { id: 'preprocess', strategy: 'chain', description: '预处理技术交底书，分段与去噪' },
    ELIGIBILITY_STAGE,
    {
      id: 'extract_problem',
      strategy: 'sub_agent',
      description: '一次性提取待解决的技术问题及其对应的发明认知（配对输出）',
      atom: 'extract',
      params: {
        extraction_type: '提取待解决的技术问题并提炼对应的发明认知',
        output_mode: 'problem_insight',
      },
    },
    {
      id: 'extract_features',
      strategy: 'sub_agent',
      description: '提取技术特征',
      atom: 'extract',
      params: { extraction_type: '提取技术特征（严格输出 features 数组）', output_key: 'features' },
    },
    {
      id: 'extract_effects',
      strategy: 'sub_agent',
      description: '提取技术效果',
      atom: 'extract',
      params: { extraction_type: '提取技术效果（严格输出 effects 数组）', output_key: 'effects' },
    },
    { id: 'merge', strategy: 'chain', description: '融合 PFIE 四元组（问题↔发明认知↔特征↔效果）', atom: 'merge' },
    {
      id: 'groundedness',
      strategy: 'chain',
      description: '评估提取特征在原文中的依据（低分特征反馈）',
      atom: 'groundedness',
    },
    {
      id: 'consistency',
      strategy: 'chain',
      description: 'PFIE 一致性检查（问题与发明认知均有特征承接、问题表述未绑定解决手段）',
      atom: 'pfe-consistency',
      retry: {
        whenOutputMatches: '不一致|矛盾|缺少|孤立',
        rewindTo: 'extract_problem',
        maxRetries: 1,
      },
    },
    { id: 'generate_keywords', strategy: 'chain', description: '生成检索关键词（上位/下位/同义词）', atom: 'keywords' },
    TIME_BASELINE_STAGE,
    { id: 'search', strategy: 'react', description: '检索现有技术文献（证据片段注入新颖性评估）', atom: 'search' },
    {
      id: 'prior_art_filter',
      strategy: 'chain',
      description: '按公开日过滤检索结果（A22.5；A24 宽限期内的首次公开不破坏新颖性）',
      atom: 'prior-art-filter',
    },
    {
      id: 'novelty',
      strategy: 'chain',
      description: '逐特征新颖性初判（单独对比原则 + 证据引用）',
      atom: 'novelty',
    },
    {
      id: 'citation_check',
      strategy: 'chain',
      description: '引用真实性校验（确定性）：新颖性结论引用的 D 标号/专利号须出现在检索结果中',
      atom: 'citation-check',
    },
    {
      id: 'report',
      strategy: 'chain',
      description: '生成披露分析报告（创新点/保护建议）',
      consumes: ['merge', 'novelty', 'citation_check', 'eligibility'],
    },
    {
      id: 'draft_claims',
      strategy: 'chain',
      description: '基于 PFE 与新颖性结果直出权利要求草稿（独立+从属）',
      atom: 'draft-claims',
    },
    ...FIGURE_ANALYSIS_STAGES,
    DRAFT_SPECIFICATION_STAGE,
    {
      id: 'spec_check',
      strategy: 'chain',
      description: '说明书与权利要求合规检查（A26.3/A26.4）：五部分章节、充分公开与权项特征支持',
      atom: 'spec-check',
      params: { mode: 'spec', text_key: 'specification', claims_key: 'claims_draft' },
    },
    {
      id: 'enablement_report',
      strategy: 'chain',
      description: '充分公开实体判定（A26.3）：逐独权特征在说明书中定位实施例摘录，并复核原文锚点',
      atom: 'enablement-report',
    },
    {
      id: 'claim_breadth',
      strategy: 'chain',
      description: '概括范围实体判定（A26.4，warn 级）：逐条列出上位概括，复核说明书支撑摘录的原文锚点与并列下位效果',
      atom: 'claim-breadth',
    },
    {
      id: 'slop_clean',
      strategy: 'chain',
      description: '反套话评分门（未通过自动带证据提示回退权利要求修订）',
      atom: 'slop-gate',
      retry: {
        whenOutputMatches: '需修订',
        rewindTo: 'draft_claims',
        maxRetries: 1,
      },
    },
    {
      id: 'legal_gaps',
      strategy: 'chain',
      description: '法条缺口汇总：客体、时间基准、宽限期、新颖性、权利要求支持与充分公开对应法条的覆盖状态',
      atom: 'legal-gaps',
      params: { profile: 'disclosure' },
      // 未评估项反哺采集：回退到提取链重新抽取，最多一轮（legal_gaps 共执行两次）。
      retry: { whenRevisionRequested: true, rewindTo: 'extract_problem', maxRetries: 1 },
    },
    {
      // 审批门放在反哺回路之后：legal_gaps 回退会重做报告、权利要求与说明书，
      // 门若在上游，回退就会绕过人工复核。manifest 校验禁止回退跨过审批门。
      id: 'review_gate',
      strategy: 'chain',
      description: '人工复核披露分析报告、权利要求与说明书草案（中断等待确认）',
      atom: 'approval-gate',
      params: { review_context: '披露分析报告、权利要求与说明书草案需人工复核后方可交付' },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
}

/**
 * 内置：专利创造性分析 manifest（专利法 A22.3，三步法）。
 */
export const patentInventivenessManifest: WorkflowManifest = {
  id: 'patent_inventiveness_v1',
  guidelineRevision: SHIPPED_GUIDELINE_REVISION,
  name: '专利创造性分析',
  caseType: 'inventiveness_analysis',
  stages: [
    DISPUTE_FRAMING_STAGE,
    {
      id: 'parse',
      strategy: 'chain',
      description: '解析权利要求/技术方案，构建所属领域技术人员画像，确定申请日/优先权日时间基准（按争议粗定位只提取相关事实）',
      consumes: ['dispute-framing'],
    },
    TIME_BASELINE_STAGE,
    disputeFramingRefineStage(),
    SEARCH_KEYWORDS_STAGE,
    {
      id: 'search',
      strategy: 'react',
      description: '检索现有技术文献，筛选最接近现有技术候选（技术领域→技术问题→发明构思）',
      atom: 'search',
    },
    PRIOR_ART_FILTER_STAGE,
    {
      id: 'closest',
      strategy: 'chain',
      description: '三步法 Step1：确定最接近的现有技术（候选多时逐个试判）',
      consumes: ['dispute-framing-refine', 'parse', 'time_baseline', 'search', 'prior_art_filter'],
      guidance:
        '边界条件：现有技术证据缺失时，基于技术领域与权利要求主题推断合理的最接近现有技术作为对比基准，并明示其公开了哪些特征；不得仅凭方案复杂或参数特殊直接断定具备创造性——已知手段的简单变体且无预料不到效果时，倾向不具备创造性。',
    },
    {
      id: 'diff',
      strategy: 'chain',
      description: '三步法 Step2：实质对比确定区别技术特征，客观确定实际解决的技术问题（不得包含解决手段）',
      consumes: ['closest'],
      guidance:
        '实际解决的技术问题基于区别特征的客观作用重新确定，区别于说明书记载的发明目的；技术问题不得是区别特征本身，也不得包含对该特征的指引。',
    },
    {
      id: 'problem_check',
      strategy: 'chain',
      description: '校验实际解决的技术问题（A22.3 第二步：不得写成区别特征自身或包含解决手段）',
      atom: 'problem-check',
    },
    {
      id: 'hint',
      strategy: 'chain',
      description: '三步法 Step3：技术启示判断（改进动机/结合启示/公知常识/发明构思/逻辑推理与有限试验）',
      consumes: ['diff', 'problem_check'],
      guidance:
        '边界条件：①软件/算法/网络方案——区别特征仅为已知逻辑或流程的简单重组且无显著技术效果，或对标准协议的非标准修改但未克服技术障碍时，倾向不具备创造性；不得把非标准或看似复杂的配置误认为创造性特征。②组合方案——依次判断：区别特征是否属于公知常识、本领域技术人员是否有动机将其结合到最接近现有技术、是否存在阻止结合的相反教导；存在相反教导或结合并非显而易见时，倾向具备创造性。',
    },
    {
      id: 'secondary',
      strategy: 'chain',
      description: '辅助判断因素复核（预料不到的技术效果/长期渴望难题/克服技术偏见/商业成功）',
      consumes: ['diff'],
    },
    {
      id: 'conclude',
      strategy: 'chain',
      description: '生成创造性结论（高/中/低/无，附置信度）+ 反事后诸葛亮自检',
      consumes: ['dispute-framing-refine', 'diff', 'problem_check', 'hint', 'secondary', 'prior_art_filter'],
    },
    CITATION_CHECK_STAGE,
    {
      id: 'legal_gaps',
      strategy: 'chain',
      description: '法条缺口汇总：技术问题确定与创造性结论对应法条的通过/未通过/未评估状态',
      atom: 'legal-gaps',
      params: { profile: 'inventiveness' },
    },
    {
      id: 'approval',
      strategy: 'chain',
      description: '人工确认分析结论（HITL）',
      atom: 'approval-gate',
      params: { review_context: '创造性分析结论需人工确认后方可交付' },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
}

/**
 * 内置：可专利性检索与布局 manifest（撰写场景）。
 */
export const patentPatentabilityManifest: WorkflowManifest = {
  id: 'patent_patentability_v1',
  guidelineRevision: SHIPPED_GUIDELINE_REVISION,
  name: '可专利性检索与权利要求布局',
  caseType: 'novelty_search',
  stages: [
    DISPUTE_FRAMING_STAGE,
    {
      id: 'parse',
      strategy: 'chain',
      description: '解析技术方案与权利要求（按争议粗定位只提取相关事实）',
      consumes: ['dispute-framing'],
    },
    TIME_BASELINE_STAGE,
    disputeFramingRefineStage(),
    ELIGIBILITY_STAGE,
    SEARCH_KEYWORDS_STAGE,
    {
      id: 'search',
      strategy: 'react',
      description: '检索现有技术文献（为 claim chart 提供对比文件）',
      atom: 'search',
    },
    PRIOR_ART_FILTER_STAGE,
    {
      id: 'claim-chart',
      strategy: 'chain',
      description: '权利要求要素级映射到最接近现有技术（mode=patentability；未显式传 chart_targets 时取过滤后的 prior_art）',
      atom: 'claim-chart',
      params: { chart_mode: 'patentability' },
    },
    {
      id: 'draft',
      strategy: 'chain',
      description: '基于区别特征布局权利要求（规避 D1）（原子路径不支持，收口模式）',
      consumes: ['dispute-framing-refine', 'parse', 'time_baseline', 'eligibility', 'prior_art_filter', 'claim-chart'],
    },
    ...FIGURE_ANALYSIS_STAGES,
    DRAFT_SPECIFICATION_STAGE,
    {
      id: 'spec_check',
      strategy: 'chain',
      description: '说明书与权利要求合规检查（A26.3/A26.4）：五部分章节、充分公开与布局后的权项特征支持',
      atom: 'spec-check',
      params: { mode: 'spec', text_key: 'specification', claims_key: 'draft' },
    },
    {
      id: 'legal_gaps',
      strategy: 'chain',
      description: '法条缺口汇总：客体、时间基准、宽限期与权利要求支持对应法条的通过/未通过/未评估状态',
      atom: 'legal-gaps',
      params: { profile: 'patentability' },
    },
    {
      id: 'approval',
      strategy: 'chain',
      description: '人工确认权利要求布局',
      atom: 'approval-gate',
      params: { review_context: '权利要求布局需人工确认后方可交付' },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
}

/**
 * 审查意见答复正文的篇幅预算，供 `patent_oa_response_v1` 的 draft 指引插值。
 *
 * 计数口径为去掉空白后的可见字符，不含表格与权利要求全文；该口径由 `patent-tools` 的
 * `visibleChars` 执行，`slop-gate`、`tighten` 与评测的篇幅观测吃的是同一份实现。
 *
 * 数值由 10 份真实答复稿定标（2026-10-31，样本与分布见计划的 P2-07）：散文 P50 = 1918、
 * P90 = 3938、最大 5955，按「P90 > 4000 上调、P90 ≤ 2500 下调、其余保持」的规则落回
 * **保持 4000**。这份预算对中位数的稿子约有一倍余量，对复杂案（3000–6000 字）刚好够用；
 * 若将来要再动，只改这里，指引文字随之更新，不会出现「文案写 4000、校验按 5000」的漂移。
 *
 * `packages/patent/patent-document` 的 `OA_RESPONSE_SLOT_QUOTAS` 按本表 × 1.25 另存了一份
 * 槽位上限（渲染前 fail-closed，只拦明显失控的草案）。两处须手工同步——该包不依赖本包，
 * 改本表不会连带改那边。
 */
export const OA_RESPONSE_DRAFT_BUDGET = {
  /** 正文总量。 */
  total: 4000,
  /** 一、总体立场。 */
  position: 200,
  /** 三、本案事实：每小节条目数、每项句数。 */
  factItems: 5,
  factSentences: 2,
  /** 四、适用规则：R 条数。 */
  ruleItems: 6,
  /** 五、意见陈述：新颖性、创造性各节字数。 */
  argumentNovelty: 1200,
  argumentInventiveness: 1200,
  /** 五、5.3 其他争点：条数。 */
  otherIssues: 3,
  /** 八、结论与请求。 */
  conclusion: 150,
} as const

/**
 * 内置：审查意见答复 manifest（OA 答复场景）。
 */
export const patentOaResponseManifest: WorkflowManifest = {
  id: 'patent_oa_response_v1',
  guidelineRevision: SHIPPED_GUIDELINE_REVISION,
  name: '审查意见答复',
  caseType: 'oa_response',
  stages: [
    DISPUTE_FRAMING_STAGE,
    {
      id: 'parse',
      strategy: 'chain',
      description: '解析审查意见通知书（确定性）：驳回类型、引用文献、涉及权项、审查员论点',
      atom: 'oa-parse',
    },
    disputeFramingRefineStage(),
    {
      id: 'claim-chart',
      strategy: 'chain',
      description: '权利要求要素级映射到审查员引用对比文件（mode=oa-response；目标由解析产出自动派生）',
      atom: 'claim-chart',
      params: { chart_mode: 'oa-response' },
    },
    {
      id: 'response-plan',
      strategy: 'chain',
      description: '答复计划骨架（逐理由策略与必答段落、逐权项修改对照、缺口；确定性）',
      atom: 'response-plan',
    },
    {
      id: 'adversary-model',
      strategy: 'chain',
      description: '对立审查员模型：独立评估答复计划的薄弱环节（确定性骨架，完整版调用模型）',
      atom: 'adversary-model',
    },
    SEARCH_KEYWORDS_STAGE,
    {
      id: 'draft',
      strategy: 'chain',
      description: '撰写意见陈述书（新颖性陈述 + 三步法，消费解析摘要、对照表结论行、答复计划、对立检验报告与检索关键词）',
      // 结构化上游只取投影：对照表的格式化 JSON 有四千多字，要素原文与结论行才是撰写
      // 需要的部分，逐行引用与 pin-cite 留在 run 记录里按要素编号回指；解析结果同理，
      // 取它自己产出的中文摘要。其余四个上游是短文本，全文注入。
      consumes: ['dispute-framing-refine', 'parse#oa-summary', 'claim-chart#rows', 'response-plan', 'adversary-model', 'generate_keywords'],
      guidance: [
        '驳回类型对照表（先按解析结果定主策略，再逐类处理；多种类型并存时以最核心的驳回理由确定主策略）：',
        '- A-充分公开（专利法26.3）：说明书未清楚完整说明 → 举证实施例、实验数据与本领域可实现性',
        '- B-不清楚/不支持（26.4）：权利要求不清楚或得不到说明书支持 → 从说明书中找对应记载做支持性论证',
        '- C-新颖性（22.2）：被单篇对比文件公开 → 找出未公开的区别特征，坚持单篇单独对比',
        '- D-创造性（22.3）：现有技术组合显而易见 → 走三步法论证非显而易见性',
        '- E-修改超范围（33 条）：修改超出原说明书与权利要求书记载的范围 → 说明修改依据与直接毫无疑义的确定',
        '- F-形式缺陷：形式/格式/书写/明显错误 → 逐项更正并在答复中说明',
        '- G-未识别条款：解析未命中具体条款时不替文书定条款，按正文人工归类后答复；正文提到解析器不单列类型的理由（实用性 22.4、不授权客体 25 条或第 5 条）时同样按正文归类（实用性 → 举证工业化实施可能性；客体 → 论证构成技术方案并产生技术效果）',
        '',
        '答复方向四选一并说明理由：①纯争辩（不修改）——事实认定有误/结合无技术启示/区别特征认定错误；②修改+争辩——将从属特征并入独权即可克服；③混合策略——重写权利要求（增补区别特征/重新划界）并争辩剩余争议；④放弃答复——缺陷无法克服（如公开不充分涉及全部实施例），须明示当事人。',
        '层级说明：上游 response-plan 产出的策略表是逐项理由的机器默认——争辩／修改／未识别条款时的争辩+修改；四选一是本案层面的方向判断，两者不一致时以本案判断为准，并在意见陈述中说明理由。',
        '三步法争辩：第一步锁定最接近现有技术；第二步逐条列出区别特征，按其客观作用确定实际解决的技术问题（不得包含区别特征自身的指引）；第三步反驳结合启示与公知常识认定，强调预料不到的技术效果。',
        '检索策略：把 generate_keywords 阶段产出的关键词落到「证据与引用」一节，写成可执行的检索方案——逐组列出关键词（含上位、下位与同义词）、拟用的 IPC/CPC 分类号、拟检索的数据库，并说明每组检索要核验什么（区别特征是否属公知常识、对比文件之间是否存在结合启示）。本节只陈述检索方案，不冒充已完成的检索：未实际检索到的文献不得写成对比文件，不得编造文献号与公开日。',
        '撰写规范：论证按「事实 → 规则 → 论证」三层组织、按争点分节（新颖性／创造性／其他争点），不以通知书审查意见项号铺陈；事实只陈述、逐项编号（F1…／P1…）并注明出处（权项号／说明书节次／对比文件段落），评价一律归入论证；修改时在答复书中列出修改后权利要求全文且不得超出原记载范围（A33）；禁止编造实验数据，禁止无逻辑链的空泛断言。',
        '输出顺序：总体立场 → 本次修改（修改对照表＋修改后独立权利要求全文）→ 本案事实 → 适用规则 → 意见陈述 → 其他缺陷的处理 → 证据与引用 → 结论与请求（与 oa-response 模板八节一致）。',
        '',
        `篇幅预算（正文总量 ≤ ${OA_RESPONSE_DRAFT_BUDGET.total} 字，不含表格与权利要求全文；超预算时删内容，不是把句子压短）：`,
        `- 一、总体立场 ≤ ${OA_RESPONSE_DRAFT_BUDGET.position} 字：只说争什么、改不改、请求什么，不在此铺陈理由。`,
        `- 三、本案事实：3.1 与 3.2 各 ≤ ${OA_RESPONSE_DRAFT_BUDGET.factItems} 项，每项 ≤ ${OA_RESPONSE_DRAFT_BUDGET.factSentences} 句，只留与争点相关的特征。`,
        `- 四、适用规则：R 条 ≤ ${OA_RESPONSE_DRAFT_BUDGET.ruleItems} 条，一条一句话，只列本案论证实际用到的规则。`,
        `- 五、意见陈述：5.1 ≤ ${OA_RESPONSE_DRAFT_BUDGET.argumentNovelty} 字，5.2 ≤ ${OA_RESPONSE_DRAFT_BUDGET.argumentInventiveness} 字；5.3 ≤ ${OA_RESPONSE_DRAFT_BUDGET.otherIssues} 条，无其他争点则整节留空，不写「无」。`,
        '- 七、证据与引用：证据清单与检索方案各用表格或逐行检索式，一组一行，不逐篇复述对比文件内容。',
        `- 八、结论与请求 ≤ ${OA_RESPONSE_DRAFT_BUDGET.conclusion} 字：只写请求与依据条款，不重复论证过程。`,
        '删减三禁令：',
        '- 不复述上游产物：要素对照表的逐特征比对、答复计划的逐理由策略、对立模型的弱点清单一律不进正文；只写由它们得出的结论，需要时以「见对照表 F2」「按答复计划第 3 项」回指。',
        '- 同一结论不在三处改写：「总体立场」「论证末句」「结论与请求」各出现一次为限，后两处只写结论与请求，不换词重述理由。',
        '- 同一段原文只整段引用一次：其后以「见前述引文」或事实编号（P3、D1 段 [0042]）指代，不再重复引述。',
        '审查意见未提出的争点不设节：写一句「审查意见未就新颖性提出异议」即可，不展开、不设小节标题，对应槽位置空（例如 5.1 或第六节整节）——置空的槽位由模板折叠，不会在成品里留下空标题。',
      ].join('\n'),
    },
    {
      id: 'tighten',
      strategy: 'chain',
      description: '删减阶段（模型）：按篇幅预算删除复述、重复与无关事实，产出删减后正文与逐条删除清单；仍超预算即降级',
      atom: 'tighten',
      // 原子阶段不声明 consumes（那是链式执行器的提示词投影，原子自己读 state）；
      // 只读范围由原子契约的 inputSchema 记录：draft 与答复计划的决策段。
      params: { text_key: 'draft', plan_key: 'response-plan', char_budget: OA_RESPONSE_DRAFT_BUDGET.total },
    },
    {
      id: 'slop_gate',
      strategy: 'chain',
      description: '反套话评分门（答复正文：套话表述、结构性问题与相对篇幅预算的精简度；未通过自动带证据提示回退重写）',
      atom: 'slop-gate',
      // 判删减后的正文：门要判的是交付稿，不是删减前的原稿。回退目标仍是 draft
      // ——套话与结构问题只能靠重写解决，删减阶段只会删，改不了开头套话。
      params: { text_keys: ['draft_tightened'], char_budget: OA_RESPONSE_DRAFT_BUDGET.total },
      retry: {
        whenOutputMatches: '需修订',
        rewindTo: 'draft',
        maxRetries: 1,
      },
    },
    {
      id: 'adversary-review',
      strategy: 'chain',
      description: '换位重跑：从对立审查员视角评估最终意见陈述书的论证强度（确定性，不调用模型）',
      atom: 'adversary-review',
    },
    {
      id: 'response_check',
      strategy: 'chain',
      description: '答复合规检查（PR-OA-007/008/009：26.3 判准落位、驳回理由覆盖、未提条款引用）',
      atom: 'response-check',
      // 检的是删减后的正文：删减可能删掉驳回理由的回应，必须按交付稿判。
      // 原子读不到 `draft_tightened` 时回落到 `draft`——删减阶段降级（仍超预算）时
      // 检查不能跟着失效，否则一份超预算但漏答理由的答复会安静通过。
      params: { response_key: 'draft_tightened' },
    },
    {
      id: 'amendment_basis',
      strategy: 'chain',
      description: '修改依据检查（A33：修改后权利要求的新增技术特征须记载于原说明书或原权利要求书）',
      atom: 'amendment-basis',
    },
    {
      id: 'legal_gaps',
      strategy: 'chain',
      description: '法条缺口汇总：答复规范检查与修改依据检查对应法条的通过/未通过/未评估状态',
      atom: 'legal-gaps',
      params: { profile: 'oa-response' },
    },
    {
      id: 'approval',
      strategy: 'chain',
      description: '人工确认答复书',
      atom: 'approval-gate',
      params: { review_context: '答复书需人工确认后方可交付' },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
}

/** 无效宣告与复审答复共用的阶段骨架选项。 */
type ContestedManifestOptions = {
  /** manifest id。 */
  id: string
  /** manifest 名称（进 run 摘要）。 */
  name: string
  /** 案由。 */
  caseType: string
  /** 程序中称（无效宣告 / 复审），进阶段描述与人工确认提示。 */
  label: string
  /** 理由表口径：无效宣告用无效理由表，复审用复审理由表（多一项实用新型客体缺陷）。 */
  program: GroundProgram
  /** 图表模式：决定提示词里的场景模式与落盘 chartId（同案不同模式互不覆盖）。 */
  chartMode: ChartMode
  /** `grounds` 阶段描述：两种程序的理由表不同，描述须各自点名。 */
  groundsDescription: string
  /** legal-gaps 清单：与程序一一对应，新增程序时须显式给出。 */
  legalGapProfile: 'invalidation' | 'reexamination'
}

/**
 * 构建无效宣告/复审 manifest：两种程序的阶段骨架相同，差异只在确定性阶段的程序口径。
 *
 * 共用一处阶段列表，避免两份清单各自漂移（如补了 `consumes` 只补一边）。
 * @param options - 程序口径（id、名称、案由、程序中称、理由表、图表模式、理由阶段描述）。
 * @returns 该程序的 manifest。
 */
function buildContestedManifest(options: ContestedManifestOptions): WorkflowManifest {
  return {
    id: options.id,
    guidelineRevision: SHIPPED_GUIDELINE_REVISION,
    name: options.name,
    caseType: options.caseType,
    stages: [
      DISPUTE_FRAMING_STAGE,
      {
        id: 'parse',
        strategy: 'chain',
        description: `解析${options.label}程序文书与权利要求（按争议粗定位只提取相关事实）`,
        consumes: ['dispute-framing'],
      },
      {
        id: 'grounds',
        strategy: 'chain',
        description: options.groundsDescription,
        atom: 'grounds',
        params: { ground_program: options.program },
      },
      disputeFramingRefineStage(),
      {
        id: 'claim-chart',
        strategy: 'chain',
        description: `权利要求要素级映射到证据组合（mode=${options.chartMode}）`,
        atom: 'claim-chart',
        params: { chart_mode: options.chartMode },
      },
      {
        id: 'novelty',
        strategy: 'chain',
        description: '新颖性单独对比（单篇全覆盖）',
        consumes: ['dispute-framing-refine', 'grounds', 'claim-chart'],
        guidance: [
          '单独对比原则：一项权利要求的新颖性只能由**一篇**现有技术单独否定，不得把两篇（或多篇）的内容拼合起来认定"已公开"。',
          '判定对象是该权利要求的全部技术特征；从属权利要求的全部技术特征 = 所引用权利要求的全部技术特征 + 本权项的附加技术特征。要素级映射用 claim_chart_build（mode=invalidity / reexamination）：它的 invalidity_conclusion 按引用链并入所引用权项的全部要素后给出逐权项"单篇全覆盖成立／未全覆盖"，直接采用该结论，不得与它相反。',
          '不得以"附加技术特征已被该篇公开"为由认定从属权利要求不具备新颖性：所引用权利要求相对同一篇未全覆盖时，从属权利要求（含其全部特征）相对该篇同样未全覆盖；invalidity_conclusion 的 dependentClaimIssues 报出该形态时必须先改法条路径或补足证据。',
          '只有判定为全覆盖时才写"不具备新颖性"；未全覆盖的写"具备新颖性"并列出缺项要素，不得改写成"公开不充分""前景有限"一类己方评估。',
          '缺项要素即三步法第二步骤的区别技术特征输入，与 invalidity_conclusion 的 distinguishing 清单保持一致。',
        ].join('\n'),
      },
      {
        id: 'inventiveness',
        strategy: 'chain',
        description: '三步法创造性分析',
        consumes: ['dispute-framing-refine', 'grounds', 'claim-chart'],
        guidance: [
          '三步法：第一步确定最接近的现有技术（以 invalidity_conclusion 的 primaryTargetId 为基准，不得中途换基准而不说明）；第二步以 distinguishing 列出的区别技术特征为输入，按该区别特征在要求保护的发明中的客观作用确定实际解决的技术问题——技术问题不得是区别特征本身，也不得包含指向该区别特征的手段；第三步判断现有技术整体上是否给出将该区别特征应用到最接近现有技术以解决其技术问题的启示（结合启示、公知常识、有限试验、逻辑推理）。',
          '区别特征只在主对比文件上提取；换用另一篇作最接近现有技术时须重跑 claim_chart_build 或说明，不得沿用上一基准的区别特征清单。',
          '从属权利要求与所引用的权利要求使用同一法条路径：所引用权利要求以 A22.3 主张的，从属权利要求以 A22.3 承接，结论写"在引用权利要求不具备创造性的基础上，权利要求 X 不具有创造性"，不得替换成以附加技术特征单独评价的另一条路径。',
          'invalidity_conclusion 检出的"仅附加特征被覆盖"形态必须在本阶段处理：或把主张改写到所引用权利要求的同一路径，或补足该篇对所引用权利要求全部特征的公开，不得回避。',
          '发明构思与公知常识的论证按"事实 → 规则 → 论证"三层组织；不以"本领域常规技术选择"这类无事实支撑的断言代替论证。',
        ].join('\n'),
      },
      {
        id: 'evidence-check',
        strategy: 'chain',
        description:
          '证据审查（形式/期限/关联性）：举证期限内提交、外文/域外证据形式完备、公开日早于现有技术截止日、与理由或权项关联',
        atom: 'evidence-check',
      },
      {
        id: 'citation-check',
        strategy: 'chain',
        description: '引用真实性校验（确定性）：新颖性/创造性结论引用的 D 标号与专利号须在证据清单中接地',
        atom: 'citation-check',
        params: { ref_text_keys: ['novelty', 'inventiveness'] },
      },
      {
        id: 'legal_gaps',
        strategy: 'chain',
        description: '法条缺口汇总：证据审查、新颖性与创造性理由对应法条的通过/未通过/未评估状态',
        atom: 'legal-gaps',
        params: { profile: options.legalGapProfile },
      },
      {
        id: 'approval',
        strategy: 'chain',
        description: '人工确认分析结论',
        atom: 'approval-gate',
        params: { review_context: `${options.label}分析结论需人工确认后方可交付` },
      },
    ],
    validation: { requireAllSteps: true, maxRetries: 2 },
  }
}

/** 内置：无效宣告分析 manifest（请求人侧的无效理由组合或专利权人侧的答复）。 */
export const patentInvalidationManifest: WorkflowManifest = buildContestedManifest({
  id: 'patent_invalidation_v1',
  name: '无效宣告分析',
  caseType: 'invalidation_analysis',
  label: '无效宣告',
  program: 'invalidation',
  chartMode: 'invalidity',
  groundsDescription: '识别请求援引的法定理由（确定性，无效理由表）',
  legalGapProfile: 'invalidation',
})

/**
 * 内置：复审答复 manifest（驳回复审）。
 *
 * 与无效宣告同骨架、程序口径不同：理由表取复审表（多一项实用新型客体缺陷，《专利法》
 * 第 2 条第 3 款），`grounds` 另输出专利权类型；图表模式取 `reexamination`。实用新型是否
 * 判创造性见 `notice/grounds.ts` 的口径——保留命中的创造性理由、专利权类型单独输出。
 */
export const patentReexaminationManifest: WorkflowManifest = buildContestedManifest({
  id: 'patent_reexamination_v1',
  name: '复审答复',
  caseType: 'reexamination_analysis',
  label: '复审',
  program: 'reexamination',
  chartMode: 'reexamination',
  groundsDescription: '识别驳回决定援引的理由（确定性，复审理由表含实用新型客体缺陷）',
  legalGapProfile: 'reexamination',
})

/**
 * 内置：侵权比对 manifest（侵权场景）。
 */
export const patentInfringementManifest: WorkflowManifest = {
  id: 'patent_infringement_v1',
  guidelineRevision: SHIPPED_GUIDELINE_REVISION,
  name: '侵权比对分析',
  caseType: 'infringement_analysis',
  stages: [
    DISPUTE_FRAMING_STAGE,
    {
      id: 'parse',
      strategy: 'chain',
      description: '解析权利要求与被控产品材料（按争议粗定位只提取相关事实）',
      consumes: ['dispute-framing'],
    },
    disputeFramingRefineStage(),
    {
      id: 'claim-chart',
      strategy: 'chain',
      description: '权利要求要素级映射到被控产品（mode=infringement，支持等同 doe 行）',
      atom: 'claim-chart',
      params: { chart_mode: 'infringement' },
    },
    {
      id: 'coverage',
      strategy: 'chain',
      description: '全面覆盖与等同一致性核验（确定性）：逐被控产品逐权项判定、整体取覆盖最佳权项 + 等同未认定清单',
      atom: 'coverage',
    },
    {
      id: 'report',
      strategy: 'chain',
      description: '生成侵权比对报告（全面覆盖 + 等同 + 现有技术抗辩）',
      consumes: ['dispute-framing-refine', 'parse', 'claim-chart', 'coverage'],
      guidance: [
        '报告结构：权利要求解释与保护范围界定 → 逐项特征比对表 → 全面覆盖判断 → 等同分析（仅在有差异特征时）→ 结论。',
        '等同按手段-功能-效果三要素逐项检验，并核查三项限制：①禁止反悔——审查历史中放弃的内容不得以等同重新纳入；②捐献规则——说明书有记载但未写入权利要求的方案视为捐献；③现有技术抗辩成立时不构成侵权。',
        '方法专利从严：步骤顺序变化或触发条件不同往往导致手段或效果实质不同；省略特征致技术效果实质变化的不认定等同。',
        '结论必须包含风险等级（高/中/低）与置信度；风险等级只能引用确定性结论（coverage 阶段的全面覆盖/等同矛盾、claim_chart_build 的 risk 评分），本 run 的输入没有评分事实时写明"未计算风险等级"，不得自行编造等级。',
      ].join('\n'),
    },
    {
      id: 'legal_gaps',
      strategy: 'chain',
      description: '法条缺口汇总：保护范围、全面覆盖与现有技术抗辩对应法条的通过/未通过/未评估状态',
      atom: 'legal-gaps',
      params: { profile: 'infringement' },
    },
    {
      id: 'approval',
      strategy: 'chain',
      description: '人工确认比对结论',
      atom: 'approval-gate',
      params: { review_context: '侵权比对结论需人工确认后方可交付' },
    },
  ],
  validation: { requireAllSteps: true, maxRetries: 2 },
}

/** 内置 patent workflow manifest 实例清单（单一数据源）。 */
export const builtinPatentManifests: readonly WorkflowManifest[] = [
  patentNoveltyManifest,
  patentDisclosureManifest,
  patentInventivenessManifest,
  patentPatentabilityManifest,
  patentOaResponseManifest,
  patentInvalidationManifest,
  patentReexaminationManifest,
  patentInfringementManifest,
]
