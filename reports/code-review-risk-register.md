# 代码审阅风险登记册（初版）

> 对应 D1 基线快照 v1。状态：`待验证` / `已确认` / `修复中` / `已关闭`。
> 级别：P0 = 领域正确性或数据一致性风险，必须先处理；P1 = 结构性或证据缺口；P2 = 架构债或流程限制；P3 = 卫生问题。

## 1. 汇总

| 级别 | 数量 | 主题 |
|---|---:|---|
| P0 | 2 | 法律引用门与证据引擎的同构分叉 |
| P1 | 14 | 超长文件、类型逃逸、测试缺口、并发语义、A33/无附图/月级日期误判、证据门缺口 |
| P2 | 18 | 跨域依赖、环境版本、通知书自指、IPC 误分类、文献号与黑板别名、claim-chart 校验缺口、模板草案未知键、CNIPR 取消映射、检索上限与 NUL 检索词、款数未核验 |
| P3 | 16 | TODO 归并、报告换行、项号/年份/日期边界、引用区间与目标配置回退、权项编号切分、必填字段双报、检索行静默丢弃、启动失败无错误码、主题词空白 |

## 2. 明细

### R-01 法律引用门存在两套已分叉的实现（P0）

- **域**：legal + patent
- **证据**：`legal-law` 与 `patent-law` 的 `reference.ts`、`verify.ts`、`tool/law-verify.ts`、`baseline.ts`、`asset-location.ts`、`index.ts`、`types.ts` 同构；`reference.ts` 差异约 146 增 / 144 删，`verify.ts` 约 339 增 / 59 删，`law-verify.ts` 约 111 增 / 114 删。
- **风险**：同一法条、同一引用集合在两个领域可能得到不同判定；修复只落在一侧时另一侧继续漂移。
- **动作**：D18 建立行为等价性矩阵（同索引、同引用、逐条判定对比），把差异归类为「数据差异」或「逻辑差异」；逻辑部分抽共享核心，领域包只保留数据源与工具名。
- **验证**：两侧判定逐条一致；差异项有来源与决策记录；既有测试零改动通过。
- **负责人**：C + A
- **状态**：待验证

### R-02 证据评分引擎与规则表重复（P0）

- **域**：legal + patent
- **证据**：重复基线中的跨域配对 `legal-evidence/src/engine.ts` ↔ `patent-core/src/evidence/engine.ts`、`legal-evidence/src/rule-set.ts` ↔ `patent-core/src/evidence/rule-set.ts`。
- **风险**：三性评分与专利证据规则各自演化，规则修正可能只落一边；评分结果不可比。
- **动作**：先做同一输入的双引擎差异测试；共享引擎与规则表，legal 只保留评估器、法域规则与工具输出。
- **验证**：规则表 diff 审计；同一输入重复评分确定性；两域输出结构兼容。
- **负责人**：C + A
- **状态**：待验证

### R-03 `statutes.ts` 超长且内部重复（P1）

- **域**：patent-deadline
- **证据**：单文件 1,304 行；重复基线中存在 `statutes.ts|statutes.ts` 自配对。
- **风险**：法规数据、期限计算与查询混排，修改一处易漏另一处；边界测试难以定位。
- **动作**：D10 拆为「数据 / 计算 / 查询」三层，先消除文件内重复块；数据改动必须附来源。
- **验证**：月末、闰年、节假日顺延、送达日边界测试；文件行数 ≤ 800。
- **负责人**：A
- **状态**：待验证

### R-04 `adversary` 模块以骨架实现承载「完整版」语义（P1）

- **域**：patent-core
- **证据**：10 处 TODO 集中在 `patent-core/src/adversary/` 与 `atoms/handlers/builtin/adversary-review.ts`，均说明当前为确定性骨架、完整版需模型注入。
- **风险**：能力声明与实现不一致；模型或用户可能把骨架评估当成完整评估。
- **动作**：合并为一条明确的能力限制（README 的 Known Limitations + Agent Note），并检查模型可见工具描述是否需要标注降级；不要保留 10 条互相重复的 TODO。
- **验证**：工具描述与快照；限制条目可检索。
- **负责人**：A
- **状态**：待验证

### R-05 源码类型逃逸集中在 `patent-tools`（P1）

- **域**：patent-tools（其余为长尾）
- **证据**：源码 `as unknown` 65 处，其中 51 处在 `patent-tools`；`tool-literature` 4、`patent-teams` 4、`patent-core` 4、`document-deliver` 2。源码 `: any` 3 处。
- **风险**：工具参数、JSON 边界与持久化读取失去类型保护；违反仓库「不新增 unknown 断言」规则。
- **动作**：D11 按边界分类：工具参数、外部 JSON、持久化、子进程输出；用 schema 或类型守卫替换，优先处理公共导出与模型可见路径。
- **验证**：源码 `as unknown` 计数下降；`typecheck` 通过。
- **负责人**：B
- **状态**：待验证

### R-06 视频预算门不是预留（P1）

- **域**：video
- **证据**：`video-mode` README 的 Known Limitations 明示：两次生成在结算前都对比同一账本，并发提交可能超支；跨进程写入仍可能丢失。
- **风险**：成本超支；并发下账本与项目文件不一致。
- **动作**：D26 补并发提交与重启测试固定当前语义；若改为预留，需同时更新工具描述与限制条目。
- **验证**：并发测试；账本不重复计费；冲突错误码可复现。
- **负责人**：D
- **状态**：待验证

### R-07 视频运行时单文件职责过载（P1）

- **域**：video
- **证据**：`media.ts` 1,250 行、`comfyui.ts` 910 行；前者同时承担 provider 选择、任务保留、journal/ledger、等待与取消。
- **风险**：provider 契约与台账逻辑耦合，新增 provider 时回归面扩大。
- **动作**：D26–D27 按「选择 / 台账 / 执行」与「提交 / 轮询 / 取消」拆分，保持工具与 provider 契约不变。
- **验证**：provider 契约测试、重启恢复测试、快照零差异。
- **负责人**：D
- **状态**：待验证

### R-08 关键包测试密度偏低（P1）

- **域**：legal + document + video client
- **证据**：`legal-evidence` 5 个测试文件 / 1,695 行源码；`legal-law` 5 / 1,505；`document-deliver` 2 / 1,789；`docx-kit` 测试比 0.61；`patent-index-asset` 0.27。
- **风险**：高风险的引用判定、交付记录与 DOCX 边界缺少失败路径证据。
- **动作**：先补 P0/P1 路径的失败测试，再做精简；不为凑比例写重复测试。
- **验证**：新增测试覆盖拒绝/超限/缺失/冲突路径；周度覆盖率不低于基线。
- **负责人**：C + B
- **状态**：待验证

### R-09 `patent-tools` 公共面过宽（P1）

- **域**：patent-tools
- **证据**：`src/index.ts` 129 个导出；`patent-core` 89 个。
- **风险**：审查面过大；无消费者导出增加维护成本与误用面。
- **动作**：D11 做导出审计：删除无当前消费者的导出，内部模块改为包内引用；公共 API 变更按仓库 pre-stable 规则同步更新消费者。
- **验证**：全仓引用搜索 + `change-scope` + `typecheck`。
- **负责人**：B
- **状态**：待验证

### R-10 legal 域依赖 patent-core（P2）

- **域**：legal
- **证据**：`legal-law`、`legal-knowledge` 的 `dependencies` 含 `@deepseek-ai/dsh-patent-core`；三个 shared 文件是对 patent-core 的再导出垫片。
- **风险**：领域边界倒置；法律域的共享工具被专利库的发布节奏绑定。
- **动作**：与 R-01/R-02 一起评估：把引用/FTS 的通用核心迁到中性共享包（现有 `patent-index-asset` 或 util 层），再让两域都依赖它。迁移前先记录架构债，不仓促移动。
- **验证**：依赖图无新增反向依赖；迁移后两域测试与快照一致。
- **负责人**：A + C
- **状态**：待验证

### R-11 环境版本与仓库要求不一致（P2）

- **域**：流程
- **证据**：`package.json` 要求 node ≥ 24.9.0；当前 sandbox 为 v24.1.0，安装与门禁均给出 engines 警告。
- **风险**：本地通过但 CI 或构建产物不一致；某些工具在 24.1 上可能行为不同。
- **动作**：D2 确认 CI 版本；本地尽量切换到 24.9+；若无法切换，记录哪些门禁在 24.1 上运行过。
- **验证**：`pnpm run build:check` 与定向测试在记录版本上通过。
- **负责人**：R
- **状态**：已确认

### R-12 无 churn 历史可用于排序（P2）

- **域**：流程
- **证据**：仓库仅 2 个提交。
- **风险**：无法用改动频率识别真实热点，采样可能偏向「大文件」而非「高风险文件」。
- **动作**：改用静态权重：公共导出面、跨域重复、测试密度、领域正确性；D20 用审阅发现反向校准。
- **验证**：采样清单与实际 P0/P1 分布对照。
- **负责人**：R
- **状态**：已确认

### R-13 分散 TODO 缺少统一出口（P3）

- **域**：patent-core
- **证据**：10 处真实 TODO 与 R-04 同源，但不构成独立缺陷。
- **动作**：合并进 R-04 的限制条目；不保留重复 TODO。
- **验证**：TODO 计数降到 ≤ 20 且无同主题重复。
- **负责人**：A
- **状态**：待验证

### R-14 A33 修改依据把数字符号当作标点剥除（P1）

- **域**：patent-core
- **证据**：`amendment-basis.ts:282-289` 的 `normalize` 用 `[^\p{L}\p{N}]` 删除所有非字母数字字符；`1.0%` 与 `10%` 归一化后都为 `10`，`5℃` 与 `-5℃` 都为 `5`。
- **风险**：修改稿改变数值、符号或单位时，`amendment_basis_passed` 仍可能为 true，A33 超范围检查被绕过。
- **动作**：保留数字相关字符（`.`、`-`、`+`、`%`、`℃` 等），补“1.0%→10%”“5℃→-5℃”失败测试；现有 `tests/amendment-basis-atom.spec.ts` 未覆盖这类改动。
- **验证**：新增用例修复前失败、修复后通过；原有汉字改写用例不回归。
- **负责人**：A
- **状态**：已确认

### R-15 无附图草案被校验器无条件拒绝（P1）

- **域**：patent-core
- **证据**：`draft/validate.ts:362-363` 注释声明“无附图发明的 figureFiles 可以是空数组”，调用 `readStringList(..., undefined)`；但 `readStringList:133` 的空数组错误文案默认值为 `至少一项`，传 `undefined` 会触发默认参数。`tests/draft.spec.ts:193-196` 反而断言空数组被拒绝。
- **风险**：合法的无附图申请无法通过草案校验；注释与测试互相矛盾。
- **最小复现**：`figureFiles: []` 且 `drawingDescriptions: []` 的合法草案抛出“figureFiles 至少一项”。`readStringList` 的默认参数在显式传 `undefined` 时仍生效，注释声明的可空语义没有落地。
- **动作**：改为显式可空参数或改用底层读取，同步修正测试预期。
- **验证**：`figureFiles: []` 通过、`figureFiles: [' ']` 仍拒绝；测试行为与注释一致。
- **负责人**：A
- **状态**：已确认

### R-16 通知书自身号码排除规则覆盖不全（P2）

- **域**：patent-core
- **证据**：`notice/office-action.ts:128` 的 `SELF_REFERENCE_BEFORE` 在“公开号/申请号”后只允许括号、右括号与空白，不允许 `：`、`:` 或 `为`；`380-386` 依赖该正则。输入“本申请（申请号：CN117000000A）与对比文件CN112345678A…”时，自身号码会进入 `citations`。
- **风险**：下游把本申请当作对比文件；权利要求共现解析可能把本申请的权利要求错误关联。
- **动作**：允许标记与号码之间出现冒号与“号为”；补“申请号：”“申请号为”两种写法用例，现 `tests/notice/office-action.spec.ts:91-99` 只覆盖“（申请号CN…）”。
- **验证**：自身号码不进入 citations；对比文件仍正常解析。
- **负责人**：A
- **状态**：已确认

### R-17 IPC 单字关键词按子串匹配导致跨部误分类（P2）

- **域**：patent-core
- **证据**：`ipc/ipc-classifier.ts:240-269` 的 E 部关键词含 `结构`、`门`；`matchKeywordsInText:799-807` 用 `text.includes(kw)` 纯子串匹配。“一种高温阀门，包括阀体和密封结构”会命中 E 部。
- **风险**：机械、阀门类申请被分到固定建筑物；分类结果影响创造性检索与审查策略。
- **最小复现**：`classifyIpcTop('一种高温阀门，包括阀体和密封结构')` 返回 E 部，命中词为 `结构`、`门`。
- **动作**：单字关键词改为复合词（门窗、门体、床架等），或对单字汉字增加词边界；补“阀门/结构”碰撞用例。
- **验证**：该输入归入 F 部（F16K）或按预期部；既有 IPC 用例不回归。
- **负责人**：A
- **状态**：已确认

### R-18 规则检查“全部通过”报告缺少换行（P3）

- **域**：patent-core
- **证据**：`checker/engine.ts:441-444` 在空结果分支用 `lines.join('')`，与失败结果分支的 `join('\n')` 不对称。
- **风险**：生成 `## 规则引擎检查检查结论: ✅ 通过所有规则检查均通过。` 粘连文本，模型与用户可读性下降。
- **动作**：统一为 `join('\n')`；测试从子串匹配改为结构断言。
- **验证**：单测或快照校验标题、结论、正文分行。
- **负责人**：A
- **状态**：已确认

### R-19 权项项号正则误判行首小数（P3）

- **域**：patent-core
- **证据**：`draft/validate.ts:59` 的 `CLAIM_NUMBER_PREFIX` 为 `^\s*\d+\s*[.、．]`，不区分 `1.` 与 `1.5`；`354-359` 据此报“自带项号”。
- **风险**：以数值开头的权利要求（如“1.5wt%的乙醇溶液…”）被错误拒绝。
- **最小复现**：`claims: ['1.5wt%的乙醇溶液，其特征在于，用于清洗阀体。']` 被判“自带项号”并抛出 `DraftValidationError`。
- **动作**：分隔符后加数字否定前瞻，如 `^\s*\d+\s*[.、．](?!\d)`；补小数用例。
- **验证**：`1.5wt%…` 通过；`1. 一种装置` 仍被拒绝。
- **负责人**：A
- **状态**：已确认

### R-20 4 位年份 0001–0099 被静默映射到 19xx（P3）

- **域**：patent-core
- **证据**：`evidence/date.ts:159-162` 接受 `year >= 1` 后用 `Date.UTC(year, ...)` 构造日期，`Date.UTC(50, ...)` 解释为 1950；月份/日校验未回读年份。`parseDateFlexible('Jan 2, 0050')` 返回 1950-01-02。
- **风险**：早期文献日期被伪造为 1950 年，影响现有技术时间线。
- **动作**：构造后校验 `date.getUTCFullYear() === year`，中文月级分支同样处理；补 `<100` 年份用例。
- **验证**：`0050` 返回 null；正常年份不回归。
- **负责人**：A
- **状态**：已确认

### R-21 非法中文日期降级为月级并遮蔽后续合法日期（P3）

- **域**：patent-core
- **证据**：`evidence/date.ts:341-351` 先取第一个完整中文日期，解析失败后按 `(\d{4})年(\d{1,2})月` 取同一前缀，不继续寻找后续完整日期。“2023年2月30日公布，2024年3月1日再次公布”返回 `2023年2月`，再被推定为 2023-02-28。
- **风险**：证据公开日被错误提前，且丢失后一个合法日期。
- **动作**：用 `matchAll` 遍历完整日期并跳过非法项；仅当“年-月”后不跟“日”时才作月级回退。
- **验证**：上述输入返回 `2024年3月1日`；单月级用例仍返回年-月。
- **负责人**：A
- **状态**：已确认

### R-22 月级公开日被按月末推定并直接阻断现有技术（P1）

- **域**：patent-core
- **证据**：`atoms/handlers/builtin/evidence-check.ts:445-471` 用 `publication.date` 与截止日做 `>=` 比较；月级日期由 `evidence/date.ts:305-308` 推定为月末。`tests/evidence-check-atom.spec.ts:270-277` 已把该行为写成预期。
- **风险**：公开日仅精确到月时，月末推定会把“月初至截止日之间公开”的文献判为不构成现有技术，直接阻断。
- **动作**：月级日期返回不确定区间；仅当区间整体不早于截止日（月初 ≥ 截止日）才阻断，跨越截止日转 `pending` 待核。
- **验证**：`publicationDate: '2024-06'`、截止日 `2024-06-15` 返回待核而非 `EVID-TIME-NOT-PRIOR-ART`。
- **负责人**：A
- **状态**：已确认

### R-23 月级公开日被静默剔除出现有技术集合（P1）

- **域**：patent-core
- **证据**：`atoms/handlers/builtin/prior-art-filter.ts:583-594` 用 `isBeforeReferenceDate(publication.date, referenceDate)` 直接剔除；月级日期同样按月末推定，`tests/prior-art-filter-atom.spec.ts:338-344` 只覆盖截止日为月初的情形。
- **风险**：`2024-06` 公开、`2024-06-20` 截止时，文献被标为 `not-prior-art` 并排除，实际可能属于现有技术；模块声明“避免把未知状态误判为非现有技术”。
- **动作**：识别月级日期并返回区间不确定，调用方放入 `prior_art_undated` 保留待核。
- **验证**：`publicationDate: '2024-06'`、截止日 `2024-06-20` 不进入 `prior_art_excluded`。
- **负责人**：A
- **状态**：已确认

### R-24 非 D 类文献号按子串匹配，编造编号可通过校验（P2）

- **域**：patent-core
- **证据**：`atoms/handlers/builtin/claim-strategy.ts:232-238` 仅对 `D_REFERENCE` 加词边界，其余编号用 `includes`；`450-455` 据此校验 `prior_art_ref`。
- **风险**：`prior_art_ref: 'CN123'` 命中 `CN123456A` 的子串，编造编号被接受，且 `prior_art_text` 回填为另一篇文献。
- **动作**：所有文献号统一整词匹配，或仅在完全相等时命中；补前缀/子串用例。
- **验证**：`CN123` 对 `CN123456A` 被拒绝；完整编号仍通过。
- **负责人**：A
- **状态**：已确认

### R-25 FactBlackboard 锁定后仍可通过共享引用修改（P2）

- **域**：patent-core
- **证据**：`reasoning/fact-blackboard.ts:309-322` 的 `setArticleJudgment` 直接保存调用方对象，`getArticleJudgment` 直接返回内部对象；`236-240` 的 `addReasoningChain` 同样保存原对象。
- **风险**：`lock()` 只拦截方法调用，调用方修改先前传入或取出的对象仍会改变黑板状态，检查点内容随之漂移。
- **动作**：写入与读取统一深拷贝（与 `allFacts/activeFacts` 的 `structuredClone` 对称）。
- **验证**：锁定后修改 `getArticleJudgment(...).confidence` 不影响 `toJSON()`。
- **负责人**：A
- **状态**：已确认

### R-26 创造性子图忽略解析出的 filing_date（P2）

- **域**：patent-core
- **证据**：`graph/domains/inventiveness.ts` 中 `filing_date` 只出现在 schema 与提示词（43、142 行），没有写入执行态；`closest` 节点未按日期过滤候选。
- **风险**：申请日后公开的文献可进入 `【现有技术候选】` 并被选作 D1，三步法在非现有技术基础上继续。
- **动作**：在检索与 `closest` 之间复用现有技术过滤；超期候选降级并写入说明。
- **验证**：`filing_date: 2024-01-01`、候选公开日 `2025-05-01` 不进入最近现有技术候选。
- **负责人**：A
- **状态**：已确认

### R-27 非法 reference_basis 静默按申请日处理（P3）

- **域**：patent-core
- **证据**：`prior-art-filter.ts:522-523,596-597` 只识别 `priority-date`，其余非空值一律按 `filing-date` 渲染与计算。
- **风险**：配置写成 `priority` 时，报告与 A24 基准错位，宽限期判断可能反向。
- **最小复现**：`reference_basis: 'priority'`、`reference_date` 与 `filing_date` 同为 `2024-06-01` 时，报告标注“申请日”，无 `_error` 或降级。
- **动作**：白名单校验，非法值标记 `degraded`，不静默改写法律基准。
- **验证**：`reference_basis: 'priority'` 返回降级错误而非按申请日计算。
- **负责人**：A
- **状态**：已确认

### R-28 证据身份字段包含内部 id（P3）

- **域**：patent-core
- **证据**：`evidence-check.ts:120-123,247-249` 的身份字段集合含 `id/evidenceId/label`，仅带内部序号的条目通过形式要件。
- **风险**：“证据没有可识别的名称或来源”门失效，无法定位与核对。
- **最小复现**：条目仅有 `id: 'E1'` 与日期、理由，`evidence_check_passed=true`，违规列表无 `EVID-FORM-IDENTITY`。
- **动作**：身份检查只保留名称与来源字段，排除内部标识。
- **验证**：仅 `id: 'E1'` 的条目产生 `EVID-FORM-IDENTITY`。
- **负责人**：A
- **状态**：已确认

### R-29 缺少举证期限时跳过提交日解析（P3）

- **域**：patent-core
- **证据**：`evidence-check.ts:630-643` 在期限缺失时提前返回，不再解析 `submittedAt`。
- **风险**：`2024-13-01` 这类非法提交日被静默放过，结果仍为通过。
- **最小复现**：`evidence_deadline` 留空、`submittedAt: '2024-13-01'` 时，`_error` 为 `undefined`，`evidence_check_passed=true`。
- **动作**：先解析提交日再判断期限缺失；解析失败始终降级。
- **验证**：无期限且提交日非法时产出 `_error`。
- **负责人**：A
- **状态**：已确认

### R-30 有源文目标上空 pin-cite 被二次校验拒绝（P1）

- **域**：patent-core
- **证据**：`atoms/handlers/builtin/chart.ts:287-303` 注释与 290-291 行声明空 pin-cite 放行，但 302 行对可读源文无条件调用 `validatePinCite('')`；`pin-cite-validator.ts:65-70` 在段号缺失时返回格式非法。
- **风险**：`not-found` 行按提示词要求留空 pin-cite，却在有 `source_path` 时必然报错，重做两次后降级；模型为通过校验被迫编造段号。
- **动作**：302 行前增加 `row.pinCite.trim().length > 0` 前置判断，与 290-291 行保持同一条件。
- **验证**：有源文 + `not-found` + 空 pin-cite 通过；非法非空 pin-cite 仍报错。
- **负责人**：A
- **状态**：已确认

### R-31 覆盖映射允许空 quote，零引用证据可判全覆盖（P1）

- **域**：patent-core
- **证据**：`chart.ts:304` 调用 `verifyQuoteInSource`，该函数在 `pin-cite-validator.ts:90-93` 对空串直接放行；`mapping-machine.ts:10,27` 的 `COVERED_MAPPINGS` 只看 mapping，`validateRowMapping:37-46` 不检查 quote。
- **风险**：`literal`/`anticipation` 行不写 quote 也计入覆盖，全部要素“覆盖”后输出“单篇全覆盖成立”，实际没有任何引用证据。
- **动作**：源文可读时，覆盖类 mapping 必须带非空 quote；`not-found` 行仍允许空 quote。
- **验证**：`literal` + 空 quote 被拒；`not-found` + 空 quote 通过。
- **负责人**：A
- **状态**：已确认

### R-32 所引权项无任何要素仍判全覆盖（P1）

- **域**：patent-core
- **证据**：`mapping-machine.ts:87-109` 以 `elements` 出现的权项为集合；`claims` 中权 1 无要素时，权 2 的 scope 仍包含权 1，`missing` 只过滤已存在要素，结果 `covered: true`；`invalidity-conclusion.ts:57` 直接使用该结果。
- **风险**：从属权项被判“单篇全覆盖成立（已并入所引用权项全部要素）”，而所引权项实际未评估。
- **动作**：区分“无要素可评估”与“全覆盖”；scope 内零要素的权项记入 `missing` 或降级为无法判定。
- **验证**：`claims=[{1,[],{2,[1]}]` 且仅 `2a` 有 literal 映射时，权 2 不判全覆盖。
- **负责人**：A
- **状态**：已确认

### R-33 quote 与源文全文比对，可挂到错误段落（P2）

- **域**：patent-core
- **证据**：`pin-cite-validator.ts:75-81` 只校验段号存在，`90-94` 用源文全文做子串核对，二者独立，未验证 quote 属于所引段落。
- **风险**：`[D1 段[0032]]` 配 `[0034]` 段的 quote 仍通过，引用定位与证据内容错位。
- **动作**：按段号切出对应段落（区间取起止段），在该段内核对 quote。
- **验证**：quote 来自其他段落时报错；同段 quote 通过。
- **负责人**：A
- **状态**：已确认

### R-34 claimNo 无对应段落时回退全文，跨权项借用通过（P2）

- **域**：patent-core
- **证据**：`element-validator.ts:99-105` 在 `segments.get(claimNo)` 未命中时回退整篇 claim 文本；注释只为兼容无编号单条 claim。
- **风险**：`claimNo: 5` 的要素文本取自权 1 仍通过，`chart.ts` 随后把权 5 计入覆盖并渲染“权利要求 5 全覆盖”，凭空生成权项。
- **动作**：`segments.size > 0` 且目标段缺失时报错；仅在没有任何分段时才回退全文。
- **验证**：权 5 借用权 1 文本被拒；无编号单条 claim 仍可用。
- **负责人**：A
- **状态**：已确认

### R-35 从权专员返回子集时静默丢权（P2）

- **域**：patent-core
- **证据**：`atoms/handlers/builtin/draft.ts:268-278,430-432` 只校验从 2 起连续，返回 1 条也合法；整体替换后权 3 及其附加特征消失。`tests/claim-draft-atom.spec.ts:156` 走到该分支但只断言 `specialist: applied`。
- **最小复现**：策略表含确定性从权 2、3，专员仅返回权 2；实际 `claims_draft` 只剩权 1、2，`specialist: applied`，`violations` 与 `lint` 均为空。
- **风险**：确定性子权被模型输出覆盖而无声丢失，校验与 lint 仍全部通过。
- **动作**：要求从权结果覆盖确定性从权的全部特征或数量不少于其数量，否则回退确定性结果。
- **验证**：返回少一条从权时回退，`claims_draft` 保留权 3。
- **负责人**：A
- **状态**：已确认

### R-36 claim-breadth 必填字段缺失仍判通过（P2）

- **域**：patent-core
- **证据**：`claim-breadth.ts:217-218,248-250` 用 `parseOptionalJsonStringArray`，`undefined` 变空数组；schema 在 `156-164` 将 `parallel_lower_levels` 列为必填。
- **最小复现**：模型记录省略 `parallel_lower_levels`；实际 `claim_breadth_passed=true`，报告写“未列出并列下位；效果一致：是”。
- **风险**：字段缺失时以空洞真值通过 A26.4，报告写“未列出并列下位；效果一致：是”。
- **动作**：改用必填解析，缺失即降级。
- **验证**：缺 `parallel_lower_levels` 时 `claim_breadth_passed=false`。
- **负责人**：A
- **状态**：已确认

### R-37 同格重复映射行导致结论自相矛盾（P2）

- **域**：patent-core
- **证据**：`chart.ts:278-307` 未按 `(elementId,targetId)` 查重；`gap-detector.ts:79-84` 与结论各自消费行，`chart.ts:468-477` 的指纹按整串比较。
- **最小复现**：同一 `1a→D1` 格同时给出 `literal` 与 `not-found`；实际通过校验，`gap_list` 报“未找到对应内容”，`invalidityConclusion` 判权 1 `covered=true`。
- **风险**：同格同时出现 `literal` 与 `not-found` 时，gap 列表说“未找到”，结论说“全覆盖”，交付件互相矛盾。
- **动作**：校验阶段按要素与目标去重，重复直接报错。
- **验证**：重复行被拒；单行结果不变。
- **负责人**：A
- **状态**：已确认

### R-38 引用区间超限或倒序时降级为独立权项（P3）

- **域**：patent-core
- **证据**：`claim-refs.ts:76-83,101-106` 区间跨度过大或起止倒序时返回空集合，`deriveClaimRefs` 随即判 `independent`。
- **最小复现**：`parseReferenceNumbers('1-35')` 与 `('3-1')` 均返回 `[]`；权 2 的“根据权利要求1-35所述”、权 3 的“根据权利要求3-1所述”实际均判为 `independent`、`refersTo=[]`。
- **风险**：`1-35`、`3-1` 引用失效，从属权项被当作独立权项评估，区别特征与覆盖范围失真。
- **动作**：区间被丢弃时返回失败信号并产出引用缺陷，不降级为独立。
- **验证**：`1-35` 产生引用缺陷而非 `independent`。
- **负责人**：A
- **状态**：已确认

### R-39 非法 primaryTargetId 静默丢弃并产生矛盾文案（P3）

- **域**：patent-core
- **证据**：`invalidity-conclusion.ts:60-64` 对非 prior-art 目标把 `primaryTargetId` 置空；`192,224-225` 的渲染同时出现“参与判定的对比文件 1 篇”与“无对比文件目标”。
- **最小复现**：图表含 `D1`（prior-art）与 `产品A`（accused-product），调用 `deriveInvalidityConclusion(chart, { primaryTargetId: '产品A' })`；实际结论无 `primaryTargetId`，渲染为“主对比文件: （无对比文件目标）；参与判定的对比文件 1 篇”。
- **风险**：调用方指定的主目标无效却无错误，报告口径自相矛盾。
- **动作**：显式指定非对比文件目标时报错；文案依据目标类型而非区别特征数量。
- **验证**：`primaryTargetId: '产品A'` 返回错误。
- **负责人**：A
- **状态**：已确认

### R-40 重复 target id 静默覆盖（P3）

- **域**：patent-core
- **证据**：`chart.ts:128-154` 解析目标时不查重；`270,410-412` 的 `targetById` 后者覆盖前者。
- **最小复现**：`chart_targets` 含两个 `id: 'D1'`（标题分别为“甲”“乙”）；实际通过校验并落盘 `targets` 两项，行校验只命中后者的源文。
- **风险**：两个同名 D1 指向不同源文时，行被拿到错误文件校验，正确输出被反复打回；即使通过也会出现两个同名区块。
- **动作**：解析阶段拒绝重复 id。
- **验证**：重复 `D1` 直接报错。
- **负责人**：A
- **状态**：已确认

### R-41 重复或跳号权项号在切分时被静默接受（P3）

- **域**：patent-core
- **证据**：`element-validator.ts:38-55` 的 `splitClaimSegments` 用 `Map.set` 收集段落，重复权项号后者覆盖前者；`claim-refs.ts:94-109` 直接消费该映射，不校验编号唯一或连续。
- **最小复现**：`1. …\n1. …` 切分后只保留权 1（第二条覆盖第一条）；`1. …\n3. …` 得到 `[1,3]`，`deriveClaimRefs` 与 `validateClaimRefs` 均不报缺陷。
- **风险**：重复编号时第一条权项被静默丢弃，`claimNos`、覆盖判定与区别特征只覆盖幸存的一条；跳号被当作合法序列，报告声称覆盖全部权项。
- **动作**：在图表输入解析阶段校验权项号唯一且从 1 连续，返回可操作错误；不改共享切分函数的行为，避免影响其他调用方。
- **验证**：重复 `1.` 与 `1,3` 均被拒绝；正常编号不回归。
- **负责人**：A
- **状态**：已确认

### R-42 模板草案的 section 与 grounds 条目静默忽略未知键（P2）

- **域**：patent-core
- **证据**：`draft/validate.ts:709-778` 的模板 section 只检查 slot 内容互斥，不校验条目其余键；`646-673` 的 grounds 条目同样只读已知字段。对比 `271-281` 的规格章节与 `189` 的规格块均调用 `reportUnknownKeys` 拒绝未知键。
- **最小复现**：`validateTemplateDraft({ sections: [{ id: 'body', blocks: [{ kind: 'paragraph', text: 'x' }], extra: true }] })` 与 grounds 条目追加 `extra` 均不抛错。
- **风险**：模型把 `blocks` 写成 `block` 并同时保留一个合法字段时，未知键被静默忽略；同一校验器对规格草案与模板草案的未知键策略不一致，模型无法从错误信息学习正确字段。
- **动作**：按 slot kind 定义条目允许键（blocks 槽：`id/blocks`；rows 槽：`id/rows`；grounds 槽：`id/grounds`），grounds 条目允许 `article/ground/claimNos/facts/evidence/conclusion`；不匹配即报未知键并列可用项。
- **验证**：上述两种条目带 `extra` 均被拒；正常模板草案不回归。
- **负责人**：A
- **状态**：已确认

### R-43 必填模板字段为空时同时报“为空”与“缺失”（P3）

- **域**：patent-core
- **证据**：`draft/validate.ts:466-499` 先校验每个已提供字段，校验失败时不把字段写入 `fields`；`492-499` 再按 `Object.hasOwn(fields, id)` 判定必填缺失，于是同一个键得到两条矛盾提示。
- **最小复现**：schema 将 `title` 设为必填文本，草案传 `fields: { title: '' }`、`sections: []`；违规为 `['fields.title 为空', 'fields.title 缺失']`。
- **风险**：模型收到“缺失”后可能新增重复字段而不是修正空值；错误信息自相矛盾。
- **动作**：用独立的“已提供键集合”判断必填，字段存在但值非法时只报值错误。
- **验证**：空值只报“为空”一条；真正缺键仍报“缺失”。
- **负责人**：A
- **状态**：已确认

### R-44 CNIPR 调用方取消在运行中不被识别（P2）

- **域**：patent-data
- **证据**：`cnipr-channel.ts:143` 只在拿到执行权后、启动脚本前检查取消，`149-166` 消费运行结果时不再检查；`ego-session.ts:140-143` 把所有运行异常统一包装成“failed to start”；`subprocess-runner.ts:49-51,65-74` 把调用方取消转成 `exitCode: null, timedOut: false`。
- **最小复现**：脚本启动后触发取消，假会话返回空输出时通道报 `receipt_missing`；返回合法收据时通道照常返回 1 条结果；运行器因取消而拒绝时，会话包装成 `ego-browser failed to start: This operation was aborted`。
- **风险**：取消被报告为“收据缺失”，调用方可能据此重试；已取消的运行仍会写回结果；取消异常失去 `AbortError` 身份，无法与真正的启动失败区分。
- **动作**：`CniprChannel.run` 在 `runScript` 返回后、超时与收据判定前调用 `options.signal?.throwIfAborted()`；`EgoBrowserSession.runScript` 的 `catch` 先重抛取消原因，再包装其余启动失败；补三条对应测试。
- **验证**：三种复现均抛 `AbortError`；正常超时仍抛 `timeout`，收据缺失仍抛 `receipt_missing`。
- **负责人**：A
- **状态**：已关闭

### R-45 检索收据静默丢弃缺号结果行（P3）

- **域**：patent-data
- **证据**：`cnipr-receipt.ts:322-329` 丢弃非对象条目，`393-397` 丢弃没有公开号的行；`412-417` 的总数来自分类导航，与保留的命中数独立。
- **最小复现**：`readCniprSearchPayload({ header: '全部2件专利', items: [有效行, { cursor: 1 }] })` 返回 `total: 2`、`hits` 长度 1，无失败标记。
- **风险**：页面行结构变化时，结果被静默截短而总数仍声称覆盖全部；检索阶段可能把缺失命中当作现有技术已检索完。
- **动作**：统计被丢弃行数；在总数与命中数不一致且存在丢弃行时报 `page_state`，或把丢弃计数作为结果字段暴露，供检索阶段告警。
- **验证**：上述输入产生失败标记或丢弃计数；正常两行输入不变化。
- **负责人**：A
- **状态**：已关闭

### R-46 CNIPR 启动失败不抛通道错误码（P3）

- **域**：patent-data
- **证据**：`cnipr-channel.ts:46-49` 声明通道级失败抛 `CniprChannelError`，但 `149-153` 未包装 `session.runScript` 的拒绝；`ego-session.ts:140-143` 抛出普通 `Error`。
- **最小复现**：假会话 `runScript` 拒绝 `Error('spawn EACCES')`，`CniprChannel.pdfLinks` 以普通 `Error` 拒绝，没有 `code` 与 `detail`。
- **风险**：调用方按 `CniprChannelError.code` 路由时会漏掉启动失败，只能按消息文本判断；与“通道级失败统一分类”的契约不一致。
- **动作**：在取消检查之后捕获运行异常，抛 `CniprChannelError`；新增 `spawn_failed` 或复用 `setup_required` 并在 `detail` 区分，保留原始 `cause`。
- **验证**：启动失败返回带 `code` 的通道错误，取消仍返回 `AbortError`。
- **负责人**：A
- **状态**：已关闭

### R-47 FTS 检索条数上限未规范化（P2）

- **域**：patent-knowledge
- **证据**：`knowledge-law-search.ts:271-274`（修复前 `options.limit ?? 10`）；`case-law-search.ts:216-218` 的 `Math.min(Math.max(...))` 既不取整也不挡 NaN/Infinity；`kg-store.ts:180-183` 的 `searchByKeyword` 把 limit 直接绑进 SQL。工具层原本另有一份同构实现 `patent-tools/src/tool/internal/query-limit.ts`。
- **最小复现**：`KnowledgeLawSearch.search('专利审查', { limit: 2.5 })` 与 `CaseLawSearchEngine.search('创造性', { limit: 2.5 })` 均抛 SQLite 原始错误 `datatype mismatch`；`KnowledgeLawSearch.search(kw, { limit: Number.NaN })` 抛同一错误并把 `ftsAvailable` 从 true 变成 false（检索阶梯把输入错误当作 FTS 故障粘性降级，后续检索全部走 LIKE）；`limit: -1` 绑定为 `LIMIT -1`（SQLite 语义为不限制），KG 关键词检索直接返回全表命中。
- **风险**：小数/NaN 传入时调用方收到原始 SQLite 错误而不是限定结果；一次 NaN 让长生命周期服务永久失去 FTS；负值让“上限”失效。
- **动作**：把工具层已有的上限归一上移到 `patent-core/src/knowledge/result-limit.ts` 的 `resolveResultLimit`（非有限值回退默认值、小数截断、夹在 `[1, max]`），参数显式传入；`patent-tools` 的 `query-limit.ts` 改为再导出，法规、判例、KG 三个检索入口改用共享实现；判例保留引擎上限 50，法规/KG 不设上限。
- **验证**：`knowledge-law-search.spec.ts`、`case-law-search.spec.ts`、`kg-store.spec.ts` 新增小数、0、负数、NaN 用例，均返回限定条数且 `ftsAvailable` 保持 true；`patent-core/tests/knowledge-query.spec.ts` 直接固定共享函数的边界；`duplication-gate.spec.ts` 不再出现 `query-input.ts|query-limit.ts` 克隆对。
- **负责人**：A
- **状态**：已关闭

### R-48 FTS 检索词含 NUL 触发粘性降级或原始错误（P2）

- **域**：patent-knowledge
- **证据**：`knowledge-fts.ts:71-73`（修复前只 `keyword.trim()`）；`kg-store.ts:180-181` 同样只 trim；`patent-core/src/knowledge/fts.ts:37` 的 `escapeFtsPhrase` 只转义双引号，不处理 NUL。
- **最小复现**：`search('创造性\u0000判断')` 在法规与判例引擎中令 FTS5 抛 `unterminated string`，被阶梯捕获后 `ftsAvailable=false`；`KgStore.searchByKeyword('创造性\u0000判断')` 把 `unterminated string` 直接抛给调用方；`KgStore.searchByKeyword('\u0000')` 走 LIKE 返回 1 条（NUL 模式在 LIKE 下匹配到首行）。
- **风险**：一个含 NUL 的检索词让整个服务实例永久降级到 LIKE；KG 路径把原始 SQLite 错误暴露给工具层。
- **动作**：在 `patent-core/src/knowledge/fts.ts:50` 新增 `sanitizeSearchText` 去掉 NUL（经 `patent-knowledge/src/shared/fts.ts` 再导出），在 `KnowledgeFtsSearchBase.runSearch` 与 `KgStore.searchByKeyword` 入口应用；NUL-only 查询归一为空词，返回空结果。
- **验证**：三个 spec 新增 NUL 用例，断言不降级、不抛原始错误、后续正常查询仍走 FTS；`patent-core/tests/knowledge-query.spec.ts` 直接固定清洗函数。
- **负责人**：A
- **状态**：已关闭

### R-49 主题词首尾空白导致永不命中（P3）

- **域**：patent-index-asset
- **证据**：`entries.ts:59-68` 原先返回 `topic` 原值；`patent-core/src/knowledge/text-overlap.ts:95-99` 的 `topicOverlap` 用原文 `includes`，不做空白归一。
- **最小复现**：资产条目写 `topics: [" 新颖性 "]`、`text: null`，命题「该方案具备新颖性」→ `topicOverlap` 为 false，引用被判 `unmatched`，而它本应命中主题词。
- **风险**：手工编辑的 YAML 带首尾空白时主题词永不生效，且错误信息不指向索引格式。
- **动作**：`readEntryTopics` 返回 `topic.trim()`；英文与中文 README 同步说明。
- **验证**：`entries.spec.ts` 断言 `[' 创造性 ', '新颖性']` → `['创造性', '新颖性']`。
- **负责人**：A
- **状态**：已关闭

### R-50 款数未声明的条目跳过款号窄化（P2）

- **域**：patent-index-asset + patent-core（消费方）
- **证据**：`entries.ts:21,33-45` 的 `paragraphs` 是可选字段；`article-decision.ts:174-178` 在 `entry.paragraphs === undefined` 时直接返回 null（跳过窄化）；`patent-law/assets/law/cn-patent-law.yaml` 中 13 条已转录条目（第 13、32、33、34、37、38、39、40、43、45、62、67、77 条）没有 `paragraphs`。
- **最小复现**：`decideArticleCitation({ article: 33, paragraph: 99 }, baseline, entry)` → `valid`，理由为「与《专利法》第 33 条一致（来源：…官方全文）」；同一索引第 22 条第 9 款 → `mismatch`（载明共 5 款，不含第 9 款）。
- **风险**：款号窄化门对约三分之一的已转录法条静默失效；不存在的款号被判 `valid` 并附来源，读者会当成已核对。
- **动作**：先对照官方文本补录这 13 条的款数（数据动作）；或让判定在 `paragraphs` 缺失时返回 `unverified`（跨 patent-core / patent-law / legal-law 的语义决策，`patent-law/tests/verify.spec.ts:156` 现固定了“跳过”行为）。本条只登记，留 D18/D19 决策。
- **验证**：补录后第 33 条第 99 款应报 `mismatch`；未补录时若改判定，应报 `unverified` 而非 `valid`。
- **负责人**：A
- **状态**：已确认

## 3. 处理顺序

1. **先验证后动手**：R-01、R-02 先做行为对比；R-03、R-06 先补边界/并发测试。
2. **P0 完成后**：R-05、R-08、R-09 并行；R-04 与 R-13 合并处理。
3. **结构拆分**：R-07、R-03 在测试就位后进行；R-10 跟随 R-01/R-02 的共享核心决策。
4. **每项关闭条件**：有可执行验证证据、受影响文档与快照同步、PR 单一意图。

## 4. 与日程的映射

| 风险 | 计划日 |
|---|---|
| R-01 | D18–D20 |
| R-02 | D21–D23 |
| R-03 | D10 |
| R-04 / R-13 | D4–D6 |
| R-05 | D11 |
| R-06 / R-07 | D26–D28 |
| R-08 | D21–D25 |
| R-09 | D11 |
| R-10 | D19–D20 |
| R-11 / R-12 | D2 |
| R-14 / R-16 / R-18 / R-20 / R-21 | D4 |
| R-15 / R-17 / R-19 | D6 |
| R-22 / R-23 / R-24 / R-25 / R-26 | D4 |
| R-27 / R-28 / R-29 | D6 |
| R-30 / R-31 / R-32 / R-33 / R-34 | D4 |
| R-35 / R-36 / R-37 | D4 |
| R-38 / R-39 / R-40 / R-41 | D5 |
| R-42 | D6 |
| R-43 | D6 |
| R-44 / R-45 / R-46 | D7 |
| R-47 / R-48 / R-49 | D8 |
| R-50 | D18–D19 |
