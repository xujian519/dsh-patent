# 代码审阅风险登记册（初版）

> 对应 D1 基线快照 v1。状态：`待验证` / `已确认` / `修复中` / `已关闭`。
> 级别：P0 = 领域正确性或数据一致性风险，必须先处理；P1 = 结构性或证据缺口；P2 = 架构债或流程限制；P3 = 卫生问题。

## 1. 汇总

| 级别 | 数量 | 主题 |
|---|---:|---|
| P0 | 2 | 法律引用门与证据引擎的同构分叉 |
| P1 | 17 | 超长文件、类型逃逸、测试缺口、并发语义、A33/无附图/月级日期误判、证据门缺口、待补输入仍给合计、缺款判有效、默认部署可由模型自报审批放行 |
| P2 | 42 | 跨域依赖、环境版本、通知书自指、IPC 误分类、文献号与黑板别名、claim-chart 校验缺口、模板草案未知键、CNIPR 取消映射、检索上限与 NUL 检索词、款数未核验、滞纳金规则缺失、未知修订版回退、款/项数字降级、工具检索错误码误映射、上游抛错无稳定码、`total` 语义漂移、`json` 输出契约、DOT 节点 id 合并、复核实体宽度、引线标号歧义、缺字体静默降级、虚线/剖面线/多边形规模上限、审批门恢复非续接、审批门并行取决策、plantask 状态只在内存、空计划锁死 caseId、倒排索引按位置建密集数组、TRIZ signal 元素未校验、空白查询透传文献源、PDF 下载无字节上限、验收 DOCX 读取无归档预算 |
| P3 | 27 | TODO 归并、报告换行、项号/年份/日期边界、引用区间与目标配置回退、权项编号切分、必填字段双报、检索行静默丢弃、启动失败无错误码、主题词空白、减缴备案提示、重复款号、limit 截断静默、上下文截断、未知 `node_type`、空 `patents` 成功、数值参数未校验、DOT 负边距、电路自连/同格、文字度量多份实现、放行名单拼错静默忽略 |

## 2. 明细

### R-01 法律引用门存在两套已分叉的实现（P0）

- **域**：legal + patent
- **证据**：`legal-law` 与 `patent-law` 的 `reference.ts`、`verify.ts`、`tool/law-verify.ts`、`baseline.ts`、`asset-location.ts`、`index.ts`、`types.ts` 同构；`reference.ts` 差异约 146 增 / 144 删，`verify.ts` 约 339 增 / 59 删，`law-verify.ts` 约 111 增 / 114 删。
- **风险**：同一法条、同一引用集合在两个领域可能得到不同判定；修复只落在一侧时另一侧继续漂移。
- **动作**：D18 用 `tests/fixtures/citation-samples.ts` 锁住两侧判定与理由（缺索引走 `missingIndexReason`），并把判定表、处置查找、判定计数收进 `law-core`。引用语法、索引、工具名和表后说明留在各域。审查指南、`A22.3`、沿革与动态法律名归为语法/数据，不抽。
- **验证**：两侧 `citation-conformance.spec.ts` 对同一样例断言判定与理由；`CONFORMANCE_POLICIES` 固定默认策略差异；`pnpm exec tsx scripts/duplication-gate.ts` 通过，既有跨域克隆对仍在基线内。
- **负责人**：C + A
- **状态**：已关闭

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
- **证据**：D1 基线为单文件 1,304 行，重复基线中存在 `statutes.ts|statutes.ts` 自配对。D10 后拆为 `types.ts`（192 行）、`statutes-data.ts`（132 行）、`deadline-entries.ts`（737 行）、`statutes.ts`（230 行），最大文件 737 行；该自配对已从 `scripts/duplication-baseline.json` 移除，仓库级 `duplication` 0 克隆。
- **风险**：法规数据、期限计算与查询混排，修改一处易漏另一处；边界测试难以定位。
- **动作**：D10 拆为「数据 / 计算 / 查询」三层，先消除文件内重复块；数据改动必须附来源。
- **验证**：月末、闰年、节假日顺延、送达日边界测试；文件行数 ≤ 800。
- **负责人**：A
- **状态**：已关闭

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
- **证据**：源码 `as unknown` 65 处，其中 51 处在 `patent-tools`；`tool-literature` 4、`patent-teams` 4、`patent-core` 4、`document-deliver` 2。源码 `: any` 3 处。D11 复核 `patent-tools` 的 51 处：11 处是 render 取值、28 处是输出值转 `JsonValue`、5 处是入参断言、7 处是 render 内部的域类型转换；前两类共 39 处与 R-61 的 `type:'json'` 输出同根。
- **风险**：工具参数、JSON 边界与持久化读取失去类型保护；违反仓库「不新增 unknown 断言」规则。
- **动作**：D11 已按边界分类；按 C-16 先给固定结构输出写具体 schema（R-61），再删 28+11 处断言；入参 5 处按 `defineTool` 已校验的类型直接收窄。
- **验证**：源码 `as unknown` 计数下降；`typecheck` 通过；模型可见渲染零差异。
- **负责人**：B
- **状态**：已确认

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
- **证据**：`src/index.ts` 131 条 `export` 语句、373 个导出名（含类型）；D11 按包外引用扫描（`packages/`、`apps/`、`scripts/`、`snapshots/`，排除本包与 `lib/`）得 352 个无引用、9 个单消费者、12 个多消费者。`wiring.ts:2` 写「35 个工具」、`index.ts:2` 写「36 个」，实际注册 37 个 `create*Tool` 工厂。`patent-core` 89 个。
- **风险**：审查面过大；无当前消费者的导出增加维护成本与误用面；注释计数与工厂数漂移。
- **动作**：D11 已给导出审计与候选清单（C-17）；删除/降级另立 PR，需 owner 决策与 `change-scope`，不与工具契约修复混做。
- **验证**：全仓引用搜索 + `change-scope` + `typecheck`；下游集成方清单人工确认。
- **负责人**：B
- **状态**：已确认

### R-10 legal 域依赖 patent-core（P2）

- **域**：legal
- **证据**：`legal-law`、`legal-knowledge` 的 `dependencies` 含 `@deepseek-ai/dsh-patent-core`；三个 shared 文件是对 patent-core 的再导出垫片。
- **风险**：领域边界倒置；法律域的共享工具被专利库的发布节奏绑定。
- **动作**：D19 先对齐入口（法律引擎调用 `patent-core` 已有的清洗与夹取），D20 把共用部分搬进领域中立包 `@deepseek-ai/dsh-knowledge-core`：FTS5 文本准备、检索降级阶梯、长查询切词、结果上限夹取、法条效力规则与知识库安装辅助（含 `resolveRealPath`）。`patent-core` 保留同名再导出，公开面不缩减；`legal-knowledge` 的 `dependencies` 去掉 `@deepseek-ai/dsh-patent-core`。`patent-index-asset` 是 YAML 字段读取器，仍不承接 FTS。
- **验证**：执行卡 §60–§62。`legal-knowledge` 中 `@deepseek-ai/dsh-patent-core` 引用归零；两侧检索 spec（`legal-search.spec.ts`、`sqlite-search.spec.ts`、专利侧 `fts.spec.ts`、`legal-validity.spec.ts`）在迁移前后同样通过；新包 `src/**` 逐文件覆盖率 100%。依赖方向未新增反向边。
- **负责人**：A + C
- **状态**：已关闭

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
- **动作**：D18 决定不改判定，D19 确认。`legal-law` 的 7,910 个 YAML、339,217 条都没有 `paragraphs`，默认策略会拦截 `unverified`，把缺列表改成 `unverified` 会拦截每一条点了款号的法律引用。专利侧这 13 条的款数补录需要官方文本，另立数据 PR，不在审查轮猜测款数。一致性样例「named paragraph while the entry lists no paragraphs」把两侧都锁在 `valid`。
- **验证**：补录后第 33 条第 99 款应报 `mismatch`；在补录之前保持 `valid`。`citation-conformance.spec.ts` 覆盖缺列表这一行。
- **负责人**：A
- **状态**：已确认

### R-51 待补输入不参与合计完整性（P1）

- **域**：patent-fees
- **证据**：`compute.ts:388-415` 的 `totalOf` 只读 `lines`，`compute.ts:86-104` 收集的 `pending` 从未参与 `complete`；`types.ts:236-247` 的 `complete` 文案却声称“every applicable line”。修复前 `computeFees(loadFeeTable(), { patentType: 'invention', triggers: ['annual-fee'] }, { policy: DEFAULT_FEE_POLICY })` 返回 `amount: '0.00', complete: true`，而同一报告的 `pending` 正列着 `annual-fee`；`triggers: ['filing'], specificationPages: 20` 返回 `amount: '950.00', complete: true`，而 `claims-surcharge`、`priority-claim-fee` 都在待补输入里。
- **最小复现**：上一年费查询 → 期望合计 withheld、`complete: false`，实际 `0.00` 且 `complete: true`。
- **风险**：模型或用户把“合计（全部已核验）”读成案件总价，缺失的费种被当成零；这正是本包拒绝未核验金额要防的失败。
- **动作**：`totalOf` 接收待补项 id，`complete` 同时要求无待补项；`unverifiedIds` 同时列出待补项；README、`FeeTotal` JSDoc 与工具描述同步。
- **验证**：`compute.spec.ts` “keeps the total incomplete for a pending item beside verified lines”“asks for the patent years…”；`tool.spec.ts` “withholds the total while an applicable item is waiting for a case fact”。
- **负责人**：A
- **状态**：已关闭

### R-52 年费滞纳金规则缺失时按零处理（P2）

- **域**：patent-fees
- **证据**：`compute.ts:237-240`（修复前 `rule === undefined` 直接 `return []`）；`FeeItem.latePayment` 是可选字段，`fees.ts` 只禁止非年费条目携带它，不要求年费条目必须携带。
- **最小复现**：年费条目 `amount: '900'`、`verifiedOn: '2026-01-01'`、无 `latePayment`；查询 `annuityYears: [4], lateMonths: 3` → 修复前只有年费一行，`total: { amount: '900.00', complete: true }`。修复后追加 `annual-fee-4-late-payment` 行，`status: 'unrecorded'`、无金额，合计 withheld。
- **风险**：已超期的年费按按时缴纳报价，法定滞纳金被静默省略；未转录的规则被当成零。
- **动作**：规则缺失时输出“比例未登记”的未定价滞纳金行；严格策略扣住合计，宽松策略只给已核验部分并标 incomplete。
- **验证**：`compute.spec.ts` “reports a surcharge the index has no rule for as unpriced and withholds the total”。
- **负责人**：A
- **状态**：已关闭

### R-53 rule-lock 对不存在的款号判现行有效（P1）

- **域**：patent-law
- **证据**：`citator.ts:108-172`（修复前找到条目后直接返回 `active` 或沿革状态，不比对 `entry.paragraphs`）；同包的 `patent-core/src/knowledge/article-decision.ts:173-178` 已在 `law_verify` 路径按 `entry.paragraphs` 判 `mismatch`。
- **最小复现**：`lockProvisions(['专利法第22条第9款'], testBaselines())`，第 22 条载明 3 款 → 修复前 `validityStatus: 'active'`、`unverified: []`；修复后 `unverified` 并给出“共 3 款，不含第 9 款”。随包索引第 22 条载明 5 款，结果相同。
- **风险**：工作流规则锁定门把一个不存在的款当成现行有效条款，与 `law_verify` 对同一输入的 `mismatch` 判定相反；下游据此认为该款已核对。
- **动作**：普通路径与沿革 `active` 路径都先做款号存在性检查，缺款返回 `unverified`；非 `active` 的沿革状态（`repealed`/`revised`）仍优先。`RuleLockEntry` 结构与工作流输入不变。
- **验证**：`citator.spec.ts` 新增 2 条；`rule-lock.spec.ts` 新增 1 条；`verify.spec.ts` 的 `mismatch` 行为不变。
- **负责人**：A
- **状态**：已关闭

### R-54 citator 对显式未知修订版回退基线（P2）

- **域**：patent-law
- **证据**：`citator.ts:286-294`（修复前 `targetIndex < 0` 无条件返回 `baseline`）；`verify.ts:246-280` 的 `buildGuidelineView` 对显式未知版本返回 `null`，随后判 `unverified`。
- **最小复现**：`queryValidity({ provision: '审查指南第二部分第四章3.2', revision: '2025 年修订版' }, shippedBaselines())` → 修复前按基线文本 + `supersededBy` 判 `revised`；修复后 `unverified`，理由点名该版本。
- **风险**：同一条引用在 `law_verify` 与 rule-lock/citator 下结论不同；按一个索引没有的版本给出有效性状态。
- **动作**：显式命名且未收录的版本返回 `null` 并由 `decideSectionValidity` 判 `unverified`；未命名版本仍按“最新已转录覆盖”或 `supersededBy` 回退，保持原行为。
- **验证**：`citator.spec.ts` “returns unverified for a named revision the index does not carry”；`verify.spec.ts` 的同名行为已有用例。
- **负责人**：A
- **状态**：已关闭

### R-55 款/项数字不可解析时引用被静默降级为条级（P2）

- **域**：patent-core（patent-law / legal-law 共用解析器）
- **证据**：`patent-core/src/knowledge/citation-extract.ts:34-53` 的 `readStatuteArticleCandidate` 只用 `parseCnNumber` 校验条号；`patent-core/src/knowledge/citation-text.ts:72-82` 的 `narrowed` 对不可解析的款/项直接省略字段。
- **最小复现**：`parseLawReference('专利法第22条第十十款')` 返回第 22 条且无款号，`verifyCitation` 判 `valid`，`scanUnrecognizedCitations` 为空（识别到的 `raw` 覆盖了该片段）。`专利法第22条第3款第十十项` 与 `专利法第22条第3款第（十十）项` 同样降级为款级/条级引用。
- **风险**：款号或项号写错时引用仍显示已核验，读者以为该款被核对过；与 README“malformed numeral is rejected, not guessed”的承诺不符。
- **动作**：D18 在 `law-core` 的 `narrowed` 中拒绝非正整数的款/项，`readStatuteArticleCandidate` 与专利紧凑形式因此丢掉整条引用。两侧未识别模式补上括号项。
- **验证**：`citation-text.spec.ts`、`citation-extract.spec.ts`、两侧 `reference.spec.ts`：`专利法第22条第十十款`、`第十十项`、`第（十十）项` 与 `民法典` 同形输入返回 null，`unrecognized` 非空。两侧 `tool.spec.ts`：`text` 不产生 finding 且列出片段；`references` 报 `unparsable_reference`。相邻的已识别引用不会盖住坏引用里的同一条号。
- **负责人**：A
- **状态**：已关闭

### R-56 不要求备案的减缴仍提示未备案（P3）

- **域**：patent-fees
- **证据**：`compute.ts:350-356`（修复前 `if (!request.filed)` 无条件提示，不看 `rule.requiresFiling`）。
- **最小复现**：减缴项目 `requiresFiling: false`、请求 `filed: false` → 修复前 `notes` 含“本次减缴请求未办理费减备案。”，同时 `payable` 已按 85% 减缴、结论为“已按减缴 85% 计算适用费种”。
- **风险**：报告自相矛盾，模型会据此要求用户补办一个并不存在的备案前提。
- **动作**：只有 `requiresFiling === true` 时才输出未备案提示。
- **验证**：`compute.spec.ts` “does not report a missing filing for a programme that does not require one”。
- **负责人**：A
- **状态**：已关闭

### R-57 法条款号列表允许重复（P3）

- **域**：patent-index-asset
- **证据**：`entries.ts:33-45`（修复前只校验正整数，不查重）。
- **最小复现**：`paragraphs: [1, 1, 2]` 修复前载入成功；`law_verify` 报“共 3 款”，实际只有 2 个不同款号。修复后加载失败并点名“有重复款号”。
- **风险**：手工编辑索引时重复款号让款数断言失真，缺款判断的标准被悄悄放宽。
- **动作**：读取时拒绝重复款号。
- **验证**：`entries.spec.ts` 参数化新增“a repeated paragraph”；随包两个法条资产无重复，加载不受影响。
- **负责人**：A
- **状态**：已关闭

### R-58 检索异常被统一映射为 `setup_required`（P2）

- **域**：patent-tools（`law_search`、`patent_case_search`）
- **证据**：`law-search.ts:210-216` 与 `patent-case-search.ts:165-171` 的 catch 直接把 `deps.search` / `deps.searchLaw` 抛出的任意错误改写成 `PatentToolError('setup_required', INSTALL_GUIDANCE)`。服务缺失与 `dbPath` 不存在已有前置检查（`law-search.ts:186-191`、`patent-case-search.ts:154-159`），catch 分支只会接到检索期错误。
- **最小复现**：注入 `searchLaw: () => { throw new Error('SQLITE_BUSY: database is locked') }`（判例侧同理）→ 实际抛 `setup_required`，消息为「本地规范库不可用：knowledge.db 缺失或版本不符。请先运行 patent-knowledge-install…」。
- **风险**：瞬时锁、SQL 错误、程序错误都被读成「未安装」；模型会重复安装而不是重试或上报，按 `code` 路由的调用方也把可重试失败当配置问题。
- **动作**：只把「服务未注入 / dbPath 不存在」映射 `setup_required`；检索函数异常改抛 `tool_execution_failed` 并在 `details.cause` 保留原始错误；不新增错误码。
- **验证**：见执行卡 §31 的 R-58 行；新增「检索期异常不报安装指引」用例。
- **负责人**：B
- **状态**：已确认

### R-59 上游抛错绕过稳定错误码与有界重试（P2）

- **域**：patent-tools（`patent_search`、`patent_metadata`）
- **证据**：`patent-search.ts:305-328` 与 `patent-metadata.ts:361-382` 只把「返回结果里的可重试告警」交给 `retryBounded`（`internal/bounded-retry.ts:22-37`）；`attempt()` 抛错时直接跳出，工具在 `settled === undefined` 时原样 `throw thrown`。工具描述却承诺「瞬时上游失败重试两次；失败的报错点名通道、上游错误与尝试次数」。
- **最小复现**：`search` / `scrape` 抛 `new Error('socket hang up')`，`searchRetryDelaysMs` / `scrapeRetryDelaysMs` 为 `[1,1]` → 实际只调用 1 次，抛出裸 `Error`（无 `code`、无 channel、无 attempts）。`patent_metadata` 的 `timeout: 0` 也会原样传给抓取。
- **风险**：模型与调用方拿不到可路由的失败类别；瞬时网络栈异常没有重试；描述与实现不一致，回归测试已把裸抛写成期望（`data-tools.spec.ts` 的 “rethrows the original…”）。
- **动作**：在调用处把抛错归一为 `PatentToolError`（建议 `tool_execution_failed`，`details` 带 channel/attempts/cause）；决定可识别的网络错误是否进入同一重试预算；同步工具描述与既有用例。若保留裸抛，则删掉描述中的重试/点名承诺并注明理由，二选一。
- **验证**：见执行卡 §31 的 R-59 行；`data-tools.spec.ts` 的裸抛用例按选定行为改写。
- **负责人**：B
- **状态**：已确认

### R-60 查询工具的 `total` 语义不一致（P2）

- **域**：patent-tools（查询族）
- **证据**：`patent-search.ts:341` 返回上游 `settled.result.total`（可远大于 `hits.length`）；`patent-wiki-search.ts:153`、`patent-kg-query.ts:144,161`、`law-search.ts:234`、`patent-case-search.ts:184`、`search-patent-figure.ts:319` 返回截断后的 `results.length` / `hits.length` / `nodes.length`。`search-patent-figure` 另有 `indexedCount`，其余没有命中总数。
- **最小复现**：`patent_kg_query` 3 条 keyword 命中、`limit: 2` → `total: 2`；`patent_search` 50 条命中、上游返回 `total: 120` → `total: 120`；`patent_wiki_search` 12 张候选卡、`limit: 5` → `total: 5`。
- **风险**：模型可能把 `total` 读成「命中总数」而漏报检索完整性；同一字段在不同工具里含义相反，跨工具汇总与快照断言会漂移。
- **动作**：统一一种语义。建议 `total` 保持「命中总数」，另加 `returned`（或 `returnedCount`）表示截断后返回条数；被截断的工具要能报告总数。涉及输出 schema 与渲染，单独 PR，并更新使用方断言。
- **验证**：见执行卡 §31 的 R-60 行；查询族各补一条「命中数 > limit」用例。
- **负责人**：B
- **状态**：已确认

### R-61 固定结构输出被声明为 `type: 'json'`（P2）

- **域**：patent-tools（输出契约）
- **证据**：12 个工具文件、26 个输出字段用 `{ type: 'json' }`，包括 `evaluate-evidence.ts:174-175` 的 `judgment`/`burden`、`patent-analysis-report.ts:180-186` 的 6 个结构、`patent-eval.ts:329` 的 `details`、`claim-chart-build.ts:297` 的 `chart`、`patent-workflow-run.ts:359-361` 的 `evidenceLedger`/`graphState`、`law-search.ts:177` 与 `patent-case-search.ts:147` 的 `searchStrategy`、`parse-office-action.ts:90` 的 `parsed`、`patent-metadata.ts:334` 的 `data`、`patent-flexible-plan.ts:384-385` 的 `plan`/`run`、`patent-workflow.ts:176` 的 `interrupted`、`triz-contradiction-analysis.ts:244-246` 的三个数组项。
- **最小复现**：输出 schema 校验（`packages/core/tools/src/pipeline.ts:539` 的 `validateJsonSchemaValue`）只检查到 `type: 'json'` 这一层；把 `judgment` 换成任意对象仍通过。28 处 `as unknown as JsonValue` 因此存在（R-05）。
- **风险**：输出 schema 名存实亡；字段缺失、类型漂移只能在 render 或消费方暴露；工具契约审查无法从 schema 看出结果结构。
- **动作**：按 C-16 先给固定结构 DTO 写具体 schema（优先 `judgment`、`scores`、`details`、`searchStrategy`、`evidenceLedger`、`graphState`、`chart` 的顶层字段），再删对应输出断言；动态键映射保留 `json` 并在字段说明里写明「键由输入决定」。
- **验证**：见执行卡 §31 的 R-61 行；`typecheck`、schema 断言与模型可见渲染快照零差异。
- **负责人**：B
- **状态**：已确认

### R-62 工具层 limit 归一不统一且超限静默（P3）

- **域**：patent-tools（查询族）
- **证据**：`patent-search.ts:299` 用 `Math.min(Math.max(Math.floor(args.limit ?? 10), 1), 50)`；`patent-wiki-search.ts:148` 与 `search-patent-figure.ts:290` 用 `Math.min(Math.max(args.limit ?? d, 1), 10)`，不取整；`law_search`、`patent_case_search`、`patent_kg_query` 已用 `resolveResultLimit`（`law-search.ts:192` 等）。
- **最小复现**：`patent_search` `limit: 100` → 实际 50 条命中、`warnings: []`（CNIPR 第二通道在同类截断时会写告警）；`patent_wiki_search` `limit: 2.5` → 直接进入 `Array.slice(0, 2.5)`。
- **风险**：模型不知道结果被截断，可能把前 50 条当作全部；同一工具层的上限行为继续分叉，R-47 的归一没有覆盖这里。
- **动作**：C-14：三个入口改用 `resolveResultLimit`；`patent_search` 的超限截断补一条 warnings（与 CNIPR 分支同口径）；小数按 `Math.trunc`。
- **验证**：见执行卡 §31 的 R-62 行；新增 100 / 2.5 / 0 / 负值用例。
- **负责人**：B
- **状态**：已确认

### R-63 `analyze_patent_figure` 静默截断权利要求上下文（P3）

- **域**：patent-tools（`analyze_patent_figure`）
- **证据**：`analyze-patent-figure.ts:369` 的 `formatContext` 对 `claimContext.trim().slice(0, 4000)` 后再拼进提示词；参数说明（`:575`）只写「权利要求或技术方案文本」，没有上限或截断提示。
- **最小复现**：`claim_context` 为 5000 个字符 → 实际提示词 4033 字符（4000 正文 + 固定模板），没有「截断」标记。
- **风险**：图文对齐上下文无声丢失最后约 20%；模型无法从参数说明预估，可能以为完整上下文已参与识别。
- **动作**：截断时在提示词或 warnings 里显式标注，并把 4000 字上限写进参数说明；或在 schema 层拒绝超过上限的输入。不要静默。
- **验证**：见执行卡 §31 的 R-63 行；`formatContext` 单测覆盖 3999 / 4000 / 4001 字。
- **负责人**：B
- **状态**：已确认

### R-64 `patent_kg_query.node_type` 未知值静默返回空结果（P3）

- **域**：patent-tools（`patent_kg_query`）
- **证据**：`patent-kg-query.ts:254-255` 把 `node_type.trim()` 交给 `queryByType`；`resolveNodeTypes` 对未知值原样返回 `[trimmed]`（`patent-kg-query.ts:148-161` 随后 `listByType` 得空），description 与参数说明却逐一列出支持的类型（`patent-kg-query.ts:164,222`）。
- **最小复现**：`node_type: 'Case_typo'` → `total: 0`、`hits: []`，不抛错。
- **风险**：拼写错误被读成「库里没有该类型节点」，与真实空结果不可区分；模型会据此下「无相关节点」结论。
- **动作**：工具层维护可用类型集合（含别名），未知值抛 `invalid_tool_input` 并列出可用类型；或在 schema 用 enum。不要把未知值直接当表名查询。
- **验证**：见执行卡 §31 的 R-64 行。
- **负责人**：B
- **状态**：已确认

### R-65 `patent_legal_status` 接受空号列表并返回成功空批（P3）

- **域**：patent-tools（`patent_legal_status`）
- **证据**：`patent-legal-status.ts:233-236` 直接对 `args.patents` 求 `dropped` 与 `slice(0, 20)`，没有下界检查；参数说明写「Patent numbers (1-20)」（`:196`）。
- **最小复现**：`patents: []` → `{ results: [], warnings: [] }`，渲染 `patent_legal_status: 0 result(s)`，`isError: false`。
- **风险**：上游抽取失败、模型漏填号时得到「成功 0 条」，没有 invalid-input 信号；与 `patent_pdf_download` 对空列表抛 `invalid_tool_input` 的行为不一致。
- **动作**：空数组（或去空后为空）抛 `invalid_tool_input`，并提示至少 1 个专利号。
- **验证**：见执行卡 §31 的 R-65 行。
- **负责人**：B
- **状态**：已确认

### R-66 数值参数缺少范围校验，非法值变成超时或静默夹取（P3）

- **域**：patent-tools（`patent_metadata`、`patent_legal_status`）
- **证据**：`patent-metadata.ts:363` 把 `args.timeout ?? 30000` 原样传给 `scrape`，无整数/范围检查；`patent-legal-status.ts:236` 对 `maxConcurrency` 做 `Math.floor` + 夹取，不告知调用方。对照 `patent-pdf-download.ts:238-242,504-508` 的 `requireIntRange` 会显式拒绝非法值。
- **最小复现**：`patent_metadata({ patent, timeout: 0 })` → `scrape` 收到 `timeout: 0`（上游按 0ms 起超时，最终报 `tool_timeout`）；`patent_legal_status({ patents: [...], maxConcurrency: 0 / 2.5 })` → 实际按 1 / 2 执行，输出无提示。
- **风险**：非法输入被读成上游超时或静默夹取，模型可能用同一非法值重试；同一工具层的数值校验口径不一致。
- **动作**：工具层对 `timeout`、`maxConcurrency` 做整数与范围校验（或夹取并写 warnings），沿用 `requireIntRange` 的风格。
- **验证**：见执行卡 §31 的 R-66 行。
- **负责人**：B
- **状态**：已确认

### R-67 DOT 构建器的节点 id 冲突未拒绝（P2）

- **域**：patent-tools（`figure/dot-builder`）
- **证据**：`sanitizeId` 把 `[A-Za-z0-9_-]` 之外的字符全部替换为 `_`（`dot-builder.ts:253-257`）；流程图与框图随后直接以清洗后的 id 建 `Map`，重复键静默覆盖（`dot-builder.ts:485-486,593-594`），而层级图与状态图有重复检查（`:668,723`）。`assignNumerals` 对重复 id 也返回同一标号（`:214-246`）。
- **最小复现**：`buildFlowchartDOT([{id:'a.b',...},{id:'a_b',...}])` → 输出两行 `"a_b" [label=…]` 与 `"a_b" -> "a_b"`；`buildBlockDiagramDOT` 传两个 `id:'a'` → 同名节点两行、标号同为 100。Graphviz 把两行当作同一节点，边退化为自环。
- **风险**：模型给出的两个不同步骤/模块被静默合并成一张图上的一个节点，连线变成自环或错连，工具仍报成功；标号重复直接违反附图标记的唯一性。
- **动作**：四个 DOT 构建器在清洗后统一拒绝重复 id（`DotBuildError('invalid_id')`，消息列出冲突的原始 id 与清洗结果）；流程图/框图补上与层级图/状态图同口径的检查，抽成一个共享辅助函数。
- **验证**：见执行卡 §35 的 R-67 行；新增清洗碰撞、原始重复 id、正常输入零差异三组用例。
- **负责人**：B
- **状态**：已确认

### R-68 渲染复核按 XML 实体原文量测文字（P2）

- **域**：patent-tools（`figure/render-check-scan`、`figure/render-check-findings`）
- **证据**：`scanSvg` 取 `<text>` 内容时只去标签与首尾空白，不解码实体（`render-check-scan.ts:716`），`textEntry` 直接用该原文调 `glyphBox`（`:616-628`）。同一仓库的引线标注走 `textElementContent`，会解码 `&amp;` 等实体（`svg-annotate.ts:100-102`）。
- **最小复现**：`<text x="5" y="10" font-size="3.5">A&amp;B</text>` → `content: 'A&amp;B'`（5 字符），框宽 15.75 mm；实际 `A&B` 为 7.35 mm。在 x=16 放一条竖线（未穿真实文字）→ 复核报 `text-crossed-by-line`。
- **风险**：标签含 `&`/`<`/`>` 时框被系统性算宽，产生假「穿字」「净距」「越界」结论；开启 `Config.figureFailOnRenderFindings` 时会把正常图判为失败。
- **动作**：`scanSvg` 在量测前解码 XML 预定义实体，复用 `svg-annotate` 的同一解码器（导出共享，不复制表）；补实体标签的回归用例。
- **验证**：见执行卡 §35 的 R-68 行；`A&amp;B` + 真实框外的线不报穿字；实体与未转义文本量出同一框宽。
- **负责人**：B
- **状态**：已确认

### R-69 引线标号按子串匹配，重名/前缀节点被错标（P2）

- **域**：patent-tools（`figure/leader-line`）
- **证据**：组匹配用 `references.findIndex(ref => text.includes(ref.label.trim().toLowerCase()))`（`leader-line.ts:824-825`），先出现的参考获胜；只在参考完全未命中任何节点时告警（`:887-891`），多节点命中同一参考、或同一节点命中多个参考都不报。
- **最小复现**：节点「泵体」「泵」，参考 `[{label:'泵',numeral:'1'},{label:'泵体',numeral:'2'}]` → 两个节点都得到标号 `1`，同时警告「参考 '泵体' 未命中任何节点」。
- **风险**：专利附图上同一标号出现在两个零件，或零件被标错号；告警只覆盖「未命中」，模型无法从输出发现歧义匹配。
- **动作**：先做去空白/小写的精确匹配，再在无精确匹配时按最长标签的包含匹配；一个参考命中多个节点时给出歧义告警并不标注（或要求唯一），补歧义用例。
- **验证**：见执行卡 §35 的 R-69 行；上述复现中「泵体」→2、「泵」→1、无告警；无歧义输入的标注快照不变。
- **负责人**：B
- **状态**：已确认

### R-70 CJK 字体缺失时静默降级（P2）

- **域**：patent-tools（`figure/dot-builder`、`wiring`、`figure/graphviz-renderer`）
- **证据**：`resolveDotFont` 只按平台返回单一字族（`wiring.ts:220-237`：darwin `PingFang SC`、win32 `Microsoft YaHei`、其余 `Noto Sans CJK SC`），不检查字体是否存在；DOT 头把该字族写给 Graphviz（`dot-builder.ts:444`）；渲染器只在退出码非 0 时读取 stderr（`graphviz-renderer.ts:237-248`），成功路径忽略警告。文字转路径是可选加固，默认不启用（`config.ts:70`、`wiring.ts:496-499`）。
- **最小复现**：`printf 'digraph G { node [fontname="Definitely Missing Font 123"]; a [label="壳体"] }' | dot -Tsvg` → 退出码 0、stderr 为空，SVG 仍写 `font-family="Definitely Missing Font 123"`；无该字体的阅读器回退到缺中文字形的字体。
- **风险**：附图在出图机器上可能已按回退字体排版（字宽/字高与 `glyphBox` 估算不符），换机阅读可能显示方框；工具与复核均报成功，交付前没有可执行信号。
- **动作**：在 DOT 渲染前做字体预检（`fc-match`/平台字体目录）并在缺失时告警或失败；或输出字族回退列表；是否默认开启文字转路径由 owner 决定。至少把「当前静默降级」写入包 README 的限制条目。
- **验证**：见执行卡 §35 的 R-70 行；缺字体输入产生可见告警或明确错误；正常字体输入的 DOT/快照不变。
- **负责人**：B
- **状态**：已确认

### R-71 渲染复核的虚线展开按长度无上限（P2）

- **域**：patent-tools（`figure/render-check-scan`、`figure/render-check-findings`）
- **证据**：`dashPatternUser` 只拒绝负值、非有限数与全零（`render-check-scan.ts:281-291`），任意小的正值都通过；`dashSegments` 以 `while (cursor < total)` 按 `长度 / 模式` 逐段枚举（`render-check-findings.ts:557-577`）。
- **最小复现**：160 mm 直线 + `stroke-dasharray="0.001 0.001"` → 约 8 万段，耗时 11 ms；模式再小 10 倍即 80 万段，线性增长。2 MB 输入上限允许把线长与模式同时推到极端值。
- **风险**：`verify_patent_figure` 与生成后的自动复核在主线程同步展开，畸形或单位错误的 SVG 可造成长时间阻塞/内存膨胀；这是一条对外部 SVG 输入无界的计算路径。
- **动作**：给单元素与全图设虚线片段上限（例如单元素 1 万、全图 10 万），超限记 `not-measured` 并跳过该元素的虚线展开；或拒绝过小的 `stroke-dasharray`。
- **验证**：见执行卡 §35 的 R-71 行；微小模式在固定时间内完成并产生 `not-measured`；正常点划线图面结论不变。
- **负责人**：B
- **状态**：已确认

### R-72 剖视剖面线数量随坐标跨度无上限增长（P2）

- **域**：patent-tools（`figure/section-diagram`）
- **证据**：`clipHatchSegments` 从 `ceil(cMin / spacing)` 循环到 `cMax`，段数与轮廓跨度/间距成正比（`section-diagram.ts:469-504`）；输入校验只要求坐标有限、顶点不少于 3（`:279-296`）；片段大小上限在拼接完成后才检查（`vector-figure.ts:83-85`）。
- **最小复现**：100,000 mm 见方的轮廓按默认 45°/3 mm 打剖面线 → 约 4.7 万条线段、3,608,928 字节片段，生成耗时 30 ms；跨度再放大 10 倍即约 36 MB，1,000 倍即数十 GB 级拼接。
- **风险**：单位错误（如把微米当毫米）或异常坐标不会立刻被拒绝，而是先耗尽内存/事件循环，最后才可能报 `too_large`；在工具请求中表现为长时间无响应。
- **动作**：在循环前由 `(cMax - cMin) / spacing` 估算段数，超过上限（例如 2 万条）直接抛 `invalid_input`/`too_large` 并给出实际跨度与间距；补一个「大跨度快速拒绝」用例。
- **验证**：见执行卡 §35 的 R-72 行；1,000 mm 轮廓仍成功，10^6 mm 轮廓在毫秒级拒绝；现有剖视快照不变。
- **负责人**：B
- **状态**：已确认

### R-73 包围盒计算用展开参数，超大顶点集直接栈溢出（P2）

- **域**：patent-tools（`figure/render-check-findings`）
- **证据**：`polyBounds` 用 `Math.min(...xs)` / `Math.max(...xs)` 处理全部顶点（`render-check-findings.ts:211-215`）；`inkBounds`（`:784-789`）与 `outlineOverlaps`（`:720-725`）都会走它。
- **最小复现**：`measureInkBounds` 处理一个 20 万点（约 0.8 MB，低于 2 MB 上限）的 `<polygon>` → `RangeError: Maximum call stack size exceeded`。
- **风险**：复核工具面对允许大小的外部 SVG 直接抛异常，无法给出报告；调用方只能得到未分类的失败，而不是「未量测/越界」等可行动结论。
- **动作**：`polyBounds` 改为单次循环累计 min/max（不展开参数）；补 20 万点用例。
- **验证**：见执行卡 §35 的 R-73 行；同一输入返回包围盒并完成复核；既有报告快照不变。
- **负责人**：B
- **状态**：已确认

### R-74 DOT 页边距可超过页幅，输出负的可用绘图区（P3）

- **域**：patent-tools（`figure/dot-builder`）
- **证据**：`resolvePageBundle` 只要求 `marginCm > 0`（`dot-builder.ts:300-315`）；`pageAttributeLines` 以 `pageW - 2 * marginIn` 写 `size`（`:329-347`），未与页幅比较。
- **最小复现**：`resolvePageBundle({ pageSize: 'a4', marginCm: 30 })` → DOT 含 `page="8.27,11.69"`、`size="-15.35,-11.93"`、`margin="11.81,11.81"`。
- **风险**：Graphviz 对负 `size` 的处理不是错误而是未定义/退化布局，图可能被压到不可读；工具不报错，模型无法从结果发现参数错误。
- **动作**：校验页边距小于对应页幅的一半（横竖取小者），否则抛 `DotBuildError('invalid_page')`；只给 margin 而不给 pageSize 时无法判断页幅，保持现状并在文档注明。
- **验证**：见执行卡 §35 的 R-74 行；30 cm 边距被拒绝；正常 A4 边距的 DOT 快照不变。
- **负责人**：B
- **状态**：已确认

### R-75 电路图接受自连与同格重复元件（P3）

- **域**：patent-tools（`figure/circuit-diagram`）
- **证据**：校验只查 id、kind、行列范围与重复 id（`circuit-diagram.ts:636-660`）；走线允许 `from === to`（`:700-710`），`routePoints` 对同一端口产生往返折线（`:426-440`）；端点计数把同一端口的两次出现当成 T 形结点（`:741`）。
- **最小复现**：单元件 + `connections: [{ from: 'a', to: 'a' }]` → `<polyline points="10.5,13 7,13 10.5,13" …/>` 加引脚上的实心 `<circle r="0.5">`；两个元件同 `(col,row)` 时符号与文字完全重叠。
- **风险**：非法电路被画成「有一段看不见的走线 + 一个结点」或叠压符号，工具报成功；渲染复核可能只报叠压，模型难以定位到是输入自连/重格。
- **动作**：拒绝 `from === to`；拒绝同一 `(col,row)` 的多个元件（`invalid_input`，消息给出冲突元件）；补用例。
- **验证**：见执行卡 §35 的 R-75 行；自连与同格输入被拒绝；正常电路快照不变。
- **负责人**：B
- **状态**：已确认

### R-76 文字度量与坐标格式存在多份实现（P3）

- **域**：patent-tools（`figure/glyph-box`、`figure/leader-line`、`figure/plot-diagram`、`figure/freecad-*`、`figure/mm-primitives`）
- **证据**：`glyph-box` 的全角/大写/其余字宽为 1 / 0.75 / 0.6，并用 East Asian Width 码点表（`glyph-box.ts:16-25,38-51,78-88`）；`leader-line` 与 `plot-diagram` 各自用 1 / 0.55 与正则 `/[\u3000-\u9fff\uff00-\uffef]/`（`leader-line.ts:138-147,268-271`、`plot-diagram.ts:126-130,200-203`），Hangul 与扩展 B 不在内；FreeCAD Python 用 0.62 量数字，注释却称与 `glyph-box` 同口径（`freecad-structure-script.ts:344-347`）；`mm-primitives` 自称「SVG 数值格式化的唯一实现」（`mm-primitives.ts:2`），但 Python 模板另用 `"%.3f"`（`freecad-structure-script.ts:361-363`）与 `round(..., 3)`（`freecad-section-script.ts:191`）。
- **最小复现 / 实测**：同一字符在放置侧（0.55）与复核侧（0.6/0.75/1）得到不同框宽；Hangul 与扩展 B 只在 `glyph-box` 按全角；Python `"%.3f"` 与 JS `Math.round(v*1000)/1000` 在 20,000 个 4 位小数样本中有 941 个（4.7%）不同（如 14.8715 → Python `14.871`、JS `14.872`）。
- **风险**：引线落位与复核对同一文字的边界判断不一致，临界净距/穿字会一边躲、一边报；拆分方案无法指定唯一的文字度量模块；跨引擎复现同一张图时坐标文本可能不同。
- **动作**：拆出单一 `figure-text-metrics` 模块承载码点表、比例与占位框，`glyph-box`/`leader-line`/`plot-diagram` 改为调用；Python 侧保留独立实现但在注释与 README 中声明差异（或在后续 PR 对齐 `fmt`）。改比例会改模型可见图面，必须单独 PR 并评审快照差异。
- **验证**：见执行卡 §35 的 R-76 行；CJK 混排快照值不变；跨语言取整差异有对照表；拆分后 `glyph-box` 仍是唯一比例来源。
- **负责人**：B
- **状态**：已确认

### R-77 审批门后的恢复是整次重跑，持久化的暂停记录没有续接入口（P2）

- **域**：patent-workflow
- **证据**：`runWorkflow` 以 `{ ...ctx }` 起步（`workflow.ts:97`），主循环从序号 0 开始（`workflow.ts:481`），从不读取 `WorkflowRunStore.loadRun`（仅两处实现：`workflow-store.ts:243,274`）。暂停结果由 `assembleRunResult` 落盘，同 runId 重跑直接覆盖（`workflow-store.ts:9` 注释自述为有意语义）。
- **失败输入**：novelty 在 `approval` 门暂停 → 带 `approvalGrants: ['approval']` 重跑 → 门前的模型阶段全部再执行一次；门前的 `draft`/检索产出不会被复用，非确定性阶段的两次结果可以不同，暂停记录只作审计。
- **测试覆盖**：`tests/workflow-recovery.spec.ts` 的暂停/恢复用例锁定「整次重跑」（门前 `draft` 调用两次）与同 runId 覆盖；重复暂停两次写入逐字相同的记录。
- **风险**：重跑成本与外部副作用重复；用户以为「续接」而实际拿到第二次生成的结果；暂停记录里的阶段产出无法据以恢复现场。
- **动作**：D14 只补测试并固定「恢复 = 带放行重跑」的语义，README 不宣称可续接。若要真正从持久化产出续接，需要先决定 `state` 的来源、哪些阶段可跳过以及证据账本如何合并，属于接口决策，后续单独立项。
- **验证**：见执行卡 §42 的 R-77 行；暂停后恢复完成、同 runId 只保留一条记录、门前阶段调用两次。
- **负责人**：A
- **状态**：已确认

### R-78 相邻审批门进入并行窗口，同时向人收集多个决策（P2，已修复）

- **域**：patent-workflow
- **证据**：`stageWindow` 只排除声明 `retry`/`consumes` 的阶段（`workflow.ts:269-277`）；同 atom 的连续审批门因此进入并行窗口，`Promise.all` 同时执行两个门。既有用例 `tests/workflow.spec.ts` 的 `parallel-interrupt` 正是两个相邻门触发的。
- **失败输入**：manifest `[gate_a, gate_b, deliver]`，拒绝 `gate_a` → 修复前两个门都被追问（回调次序 `['a', 'b']`），拒绝第一个门不能阻止第二个门已经被提问；修复后只询问 `gate_a`（`['a']`），运行停在第一个门。
- **风险**：人工决策被并发收集；第二个门可能基于第一个门尚未批准的产出取决策，拒绝路径在提问范围上失效。
- **动作**：`stageWindow` 对审批门返回 1（`workflow.ts:277`），门一次只取一个决策。内置 manifest 每个只有一个门，正常路径行为不变。
- **验证**：见执行卡 §42 的 R-78 行；新增用例修复前失败、修复后通过；patent-workflow 全量测试通过。
- **负责人**：A
- **状态**：已关闭

### R-79 审批放行名单拼错或指向非门阶段时被静默忽略（P3，已修复）

- **域**：patent-workflow（调用方：patent-tools 的 `approveStageIds`）
- **证据**：修复前 `runWorkflow` 把 `approvalGrants` 原样交给执行器，执行器只做 `includes(stage.id)`（`workflow/executor.ts:88`）；名单里的未知 id 与「未批准」在结果上不可区分。
- **失败输入**：`approvalGrants: ['gtae']`（或指向 `draft` 这类非门阶段）→ 修复前运行照常执行、再次停在门口且没有诊断；修复后在执行前抛 `WorkflowError`（`workflow.ts:189`）。
- **风险**：模型或宿主把拼错当成被拒绝，反复重跑仍停同一门；放行决定看似已给出却没有生效。
- **动作**：新增 `assertApprovalGrants`（`workflow.ts:189`），只接受本 manifest 的 `approval-gate` 阶段 id，校验发生在 validate 之后、任何阶段执行之前。
- **验证**：见执行卡 §42 的 R-79 行；两条用例分别覆盖未知阶段与非门阶段，且断言执行器未被调用。
- **负责人**：A
- **状态**：已关闭

### R-80 plantask 的挂起决策与轮次只在进程内存，恢复语义不完整（P2）

- **域**：patent-workflow
- **证据**：`pending` 与 `rounds` 都是服务实例的 `Map`（`index.ts:148,150`），重启即失；`patent/plantask` 事件虽写入会话日志并声称可据此重建（`types.ts` 事件注释），服务不读回日志。`applyDecision` 只有批准→executing、拒绝→replanning（封顶→finished）两条出口（`index.ts:264-272`），`awaiting_feedback`/`finished` 没有服务入口；轮次只在封顶时清零（`index.ts:269`），「计划收到终态时清零」在正常批准路径不会发生。
- **失败输入**：进程重启后 `approve(caseId)` 抛 `no pending plantask`；`approve` 之后对同一 caseId 再 `runPlantask` 会当作新计划（执行态无锁）；同一 case 先拒绝一次、批准后再拒绝，轮次继续累计。
- **风险**：跨重启的人工决策无法续接；重复调用无法区分「重试上一轮」与「新计划」；轮次预算跨计划周期漂移。
- **测试覆盖**：`tests/service.spec.ts` 的重复决策、批准后重新发起、轮次封顶、审批请求抛错清理用例；D14 补空计划不取审批用例。
- **动作**：D14 只固定现状并登记；若需要跨重启恢复，需决定 plantask 状态是否落盘、由谁驱动 `awaiting_feedback`→`finished`，属于持久化设计决策，后续 PR。
- **验证**：见执行卡 §42 的 R-80 行；重复决策抛错、同一 caseId 可重新发起且不复用旧 pending。
- **负责人**：A
- **状态**：已确认

### R-81 空计划在取到批准后才失败，caseId 被挂起锁死（P2，已修复）

- **域**：patent-workflow
- **证据**：修复前 `runPlantask` 对空 `planSteps` 也迁移到 `awaiting_approval` 并挂 `pending`；批准后 `applyDecision` 的 executing 守卫抛 `PlanTaskSemanticError`（`plantask.ts` 的 `SEMANTIC_GUARDS.executing`）。自动批准路径的 `catch` 清掉 pending 但丢弃了已作出的批准；`autoApprove:false` 走 `approve()` 时异常发生在 `pending.delete` 之前，pending 永久残留。
- **失败输入**：`runPlantask(agent, 'case', [])` → 审批被询问；`allowed-once` → 抛「executing 前必须先 sync 计划步骤」；之后同一 caseId 的 `runPlantask` 永远抛「已有挂起的 plantask」，直到进程重启。
- **风险**：没有可审内容的计划也向人取审批；批准被丢弃；caseId 被锁死，恢复只能等重启。
- **动作**：在同步任务后、取审批与落 pending 之前拒绝空计划（`index.ts:204`），错误类型沿用 `PlanTaskSemanticError`。
- **验证**：见执行卡 §42 的 R-81 行；空计划不触发审批、不写 plantask 事件、同一 caseId 随后可正常发起。
- **负责人**：A
- **状态**：已关闭

### R-82 默认部署允许模型自报审批放行，HITL 门只对协作式调用者生效（P1）

- **域**：patent-tools（消费 patent-workflow 的审批门）+ patent-workflow（放行名单是调用方数据）
- **证据**：`approveStageGates` 缺省为 false（`patent-tools/src/config.ts:116,179`；`wiring.ts:450` 以 `=== true` 落定），此时 `liveGateTarget` 返回 undefined（`patent-workflow-run.ts:539-551`），门仍用默认 `ApprovalGateHandler`；工具只在 live 门存在时拒绝 `approveStageIds`（`patent-workflow-run.ts:439-448`），否则把它原样作为 `approvalGrants`（`:607-608`）。既有用例明确锁定该行为：「keeps approveStageIds working when live gates are off」（`patent-tools/tests/patent-workflow-run.spec.ts:337-348`）。
- **失败输入**：默认配置（未设 `approveStageGates`）+ `patent_workflow_run({ manifestId: 'patent_disclosure_v1', input: '…', approveStageIds: ['review_gate'] })` → 运行直接完成，不产生 `approval/request`；期望的 HITL 行为是暂停并让人决策。引擎侧只校验放行 id 是否为本 manifest 的门（`workflow.ts:189`），不校验谁给出的放行。
- **风险**：默认部署里模型可以在首次调用就自报放行，审批门从「人工确认」退化为「模型自觉」；拒绝路径本身仍在执行点生效，但批准来源不受约束。
- **动作**：D14 只登记，不改默认值（改默认会改变现有部署行为并要求 approval 服务在场）。后续由 owner 决定：默认改 `approveStageGates: true`，或要求放行必须对应一次先前暂停（按 caseId/runId 记录暂停门）后才接受。
- **验证**：见执行卡 §42 的 R-82 行；登记复现路径与现有测试，不含代码改动。
- **负责人**：A
- **状态**：已确认

### R-83 摘要倒排索引按位置建密集数组，超大位置直接决定工作量（P2）

- **域**：tool-literature
- **证据**：`runtime/shared/text.ts:117-135`（修复前为 `words[pos] = word` + `filter`）；调用点在 `connectors/openalex.ts:69` 的 `toHit`，摘要进入 `paper_search` 结果。
- **失败输入**：OpenAlex 响应 `abstract_inverted_index: { "a": [4294967294] }`。位置 2^32-2 是合法数组索引，`words` 的长度随之为 2^32-1，`filter` 需走访约 4.29e9 个槽位；实测 1e8 位置耗时 1,246 ms，按线性增长推算该输入约 53 s。响应体积只有几十字节。
- **风险**：单个外部响应即可让一次 `paper_search` 长时间占用事件循环；工作量的上界来自位置数值而不是响应大小，与「防御式：畸形输入返回空而不抛错」的模块承诺不符。
- **动作**：D16 改为 `Map<位置, 词>` 收集后按位置排序输出，工作量只随位置条目数增长；非数组的位置列表跳过而不是抛错。重复位置保留后写值、空洞折叠的既有语义不变。
- **验证**：执行卡 §46 的 R-83 行；`fromInverted({ a: [2 ** 32 - 2] })` 用例在修复前需走访 4.29e9 个槽位（按实测两点线性推算远超 5 s 默认超时），修复后立即返回单词。
- **负责人**：B
- **状态**：已关闭

### R-84 TRIZ 分离原则的 signals 元素未在加载期校验（P2）

- **域**：methodology
- **证据**：`src/data.ts:180-188`（修复前的分支只校验 `signals` 是非空数组，不校验元素）；输出 schema 声明 `items: { type: 'string' }`（`tool/triz.ts:75,97`），插件在 `apply()` 调用 `validateTrizAssets()`（`index.ts:49`）。
- **失败输入**：资产 `signals: [123]`（或 `[null]`、`[{}]`、`['']`）→ `validateTrizAssets` 通过、插件正常加载；首次对角查询（如 `triz({ improving: 5, worsening: 5 })`）被工具输出校验拒绝：`"value" must match exactly one oneOf branch (matched 0)`。
- **风险**：资产承诺的「畸形资产在加载期失败」被破坏；错误只在生产查询时暴露，诊断信息是 schema 文案而不是资产字段位置。
- **动作**：D16 在加载期逐项校验 signal 为非空字符串，错误消息带元素序号；新增插件加载拒绝用例，证明失败发生在工具注册之前。
- **验证**：执行卡 §46 的 R-84 行；`tests/assets-invalid-signals.spec.ts` 断言 `host.plugin` 拒绝且 `triz` 未注册。
- **负责人**：B
- **状态**：已关闭

### R-85 `paper_search` 把空白查询透传给文献源（P2）

- **域**：tool-literature
- **证据**：`src/tool/paper-search.ts:107-124`（修复前）不检查 `query`；arXiv 连接器将空串包成 `all:`（`connectors/arxiv.ts:52-55`）。
- **失败输入**：`paper_search({ db: 'arxiv', query: '   ' })` 修复前返回成功，实际请求 `https://export.arxiv.org/api/query?search_query=all%3A&...`，并把源的空结果渲染成「没有匹配论文」。
- **风险**：空白查询被当作有效检索，消耗源的限速窗口并占用一次工具往返；模型会把输入错误误读成检索无结果，而不是收到可纠正的参数错误。
- **动作**：D16 在解析连接器之前裁剪查询并拒绝空串（`invalid_tool_input`），源调用次数为 0；检索与结果回显统一使用裁剪后的查询。
- **验证**：执行卡 §46 的 R-85 行；空串、纯空格、换行制表符三种输入均报 `query must be non-empty` 且源未被调用。
- **负责人**：B
- **状态**：已关闭

### R-86 `paper_download` 没有下载字节上限（P2）

- **域**：tool-literature
- **证据**：`src/tool/paper-download.ts:104-113` 直接链与 `:316` 兜底链都先 `arrayBuffer()` 再 `inspectPdfBody`；不读 `Content-Length`，也不在读取过程中累计字节。
- **失败输入**：源或记录页返回超大 PDF、或持续输出而 Content-Length 缺失的响应 → 整个响应体先进入内存，PDF 魔数与最小尺寸校验在缓冲完成后才执行。
- **风险**：一次下载即可耗尽宿主内存；错误页面或压缩炸弹也在校验前消耗资源。上限缺失使「文件大小校验」只覆盖最小边界，不覆盖最大边界。
- **动作**：独立 PR。流式读取响应体并累计字节，超限时中止并释放流；上限采用协议安全不变量还是 `Config` 字段由 owner 决定；同步把测试桩从 `arrayBuffer()` 迁移到流式响应。
- **验证**：登记；执行卡 §46 不含该路径的负向用例。
- **负责人**：C
- **状态**：已确认

### R-87 `verify_patent_filing` 读取 DOCX 时没有归档与字节预算（P2）

- **域**：patent-filing
- **证据**：`assets/engine/verify.py:118` 对模型给出的路径直接 `Document(str(docx_path))`；`src/filing/engine.ts:447-458` 只做 `existsSync`。同一仓库的 DOCX 读取路径已有预算：`docx-kit/src/types.ts:114-124` 的 `ZipReadLimits` 与 `zip.ts:428` 的 `readZip(bytes, limits)`，由 `document-deliver` 对不可信文件使用。
- **失败输入**：`verify_patent_filing({ docx: '<高压缩比 .docx>' })`。python-docx/zipfile 在 Python 子进程内解压，条目数、累计解压字节与输入文件大小都没有上限；120 s 引擎超时只限制时间，不限制内存峰值，4 MB 标准输出上限只覆盖报告文本。
- **风险**：一次验收调用可让子进程消耗任意内存并拖慢宿主；两条 DOCX 读取路径的信任策略不一致，验收路径反而更宽松。
- **动作**：独立 PR。在 `python-docx` 打开前用标准库 `zipfile` 检查文件大小、条目数与 `ZipInfo.file_size` 总和，预算与 `verify_deliverable` 的 64 MiB、`docx-kit` 的 `ZipReadLimits` 对齐；Node 侧先做文件大小预检，便于快速失败；补超限负向用例。
- **验证**：登记；执行卡 §51 的 R-87 行；本轮不含修复代码。
- **负责人**：C
- **状态**：已确认

### R-88 法律知识库的结果上限没有在进入查询前夹取（P2）

- **域**：legal-knowledge
- **证据**：`SqliteBackedEngine.search` 把 `options.limit ?? 10` 原样交给 SQL 和 `filterByValidity`。案例入口用 `Math.min(Math.max(limit ?? 5, 1), 50)`，NaN 与小数会漏过。效力过滤用 `options.limit ?? default`，0 与负数会让 `results.length >= limit` 立刻成立，命中被清空。
- **失败输入**：内存法规 `search('中华人民共和国', { limit: 0 })` 返回 `[]`；SQLite `search('中华人民共和国', { limit: -1 })` 返回 `[]`；案例 `search('合同', { limit: NaN })` 返回 `[]`。
- **风险**：调用方要一条结果时得到空列表；负上限在过滤前还可能变成 SQL 的无上限。
- **动作**：入口改用 `resolveResultLimit`，并把取整后的值写回 `options.limit`。案例保持默认 5、上限 50；其余引擎默认 10、上限为最大安全整数。工具的 1–20 不变。
- **验证**：`legal-search.spec.ts` 与 `sqlite-search.spec.ts`。修复前上述输入为空，修复后 0 与 -1 返回 1 条，NaN 回退到该入口的默认条数。
- **负责人**：A
- **状态**：已关闭

## 3. 处理顺序

1. **先验证后动手**：R-01、R-02 先做行为对比；R-03、R-06 先补边界/并发测试。
2. **P0 完成后**：R-05、R-08、R-09 并行；R-04 与 R-13 合并处理。
3. **结构拆分**：R-07、R-03 在测试就位后进行；R-10 跟随 R-01/R-02 的共享核心决策。`figure/` 的拆分按执行卡 §38 的顺序推进，纯移动 PR 不与修复混做。
4. **D12 修复队列**：R-68（实体解码）与 R-71/R-73（复核上限/循环改造）先成一组；R-67/R-69/R-74/R-75 各自带失败用例成 PR；R-70 需 owner 先定降级策略；R-72 给剖面线段数上限；R-76 在拆分完成后单独评估。
5. **D14 修复队列**：R-78（门串行）、R-79（放行名单校验）、R-81（空计划前置拒绝）已随 D14 修复并带用例；R-77（审批门后恢复非续接）与 R-80（plantask 状态只在内存）是恢复语义缺口，先固定现状，真实续接与持久化各自单独立项。
6. **D16 修复队列**：R-83（倒排索引改按条目收集）、R-84（signals 加载期校验）、R-85（空白查询前置拒绝）已随 D16 修复并带边界用例；R-86（下载字节上限）只登记，流式读取与上限值决策另立 PR。
7. **D17 决策**：不抽共享 OOXML 写入器；`patent-document` 的 HTML/PDF、`patent-filing` 的模板 DOCX、`docx-kit` 的最小 DOCX 读写各自保留，共享边界是受控草案与 `patent-core` 格式助手（执行卡 §50）。R-87（验收 DOCX 读取无归档预算）照常单独立项。
8. **D19 决策**：不合并两个知识库引擎，不把 FTS 放进 `patent-index-asset`。查询阶梯留在 `patent-core`；法律入口对齐 NUL 清洗与上限夹取（执行卡 §54）。R-88 已关闭。R-10 迁包留 D20。
9. **D18 决策**：法条判定与判定表共享；引用语法、索引和工具名留在各域（执行卡 §58）。R-55 已关闭。R-50 保持缺列表时 `valid`，13 条《专利法》款数另立数据 PR。
10. **D20 收口**：查询内核与知识库安装辅助迁入领域中立包 `@deepseek-ai/dsh-knowledge-core`（执行卡 §61–§62）。`patent-core` 保留同名再导出，`legal-knowledge` 断开对 `patent-core` 的依赖，R-10 关闭。两个检索引擎仍各自保留。
11. **每项关闭条件**：有可执行验证证据、受影响文档与快照同步、PR 单一意图。

## 4. 与日程的映射

| 风险 | 计划日 |
|---|---|
| R-01 | D18 关闭（判定与判定表共享；语法留在各域） |
| R-02 | D21–D23 |
| R-03 | D10 |
| R-04 / R-13 | D4–D6 |
| R-05 | D11 |
| R-06 / R-07 | D26–D28 |
| R-08 | D21–D25 |
| R-09 | D11 |
| R-10 | D20 关闭（查询内核与安装辅助迁入 `dsh-knowledge-core`，法律域断开对 `patent-core` 的依赖） |
| R-88 | D19 修复（法律知识库上限在入口夹取） |
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
| R-50 | D18 决定不改判定，D19 确认；款数补录另立数据 PR |
| R-51 / R-52 / R-56 / R-57 | D9 |
| R-53 / R-54 | D9 |
| R-55 | D18 修复（畸形款/项拒绝整条引用） |
| R-58 / R-59 | D11 登记，随错误码修复 PR |
| R-60 / R-61 | D11 登记，独立 PR（输出契约） |
| R-62 / R-63 / R-64 / R-65 / R-66 | D11 登记，随工具层修复 PR |
| R-67 / R-68 / R-69 / R-70 / R-71 / R-72 / R-73 / R-74 / R-75 / R-76 | D12 登记，按执行卡 §38 先拆分、再修复（各带失败用例） |
| R-78 / R-79 / R-81 | D14 修复（门串行、放行名单校验、空计划前置拒绝） |
| R-77 / R-80 | D14 登记，恢复语义与持久化设计另立 PR |
| R-82 | D14 登记，默认部署的 HITL 信任边界需 owner 决策 |
| R-83 / R-84 / R-85 | D16 修复（倒排索引、TRIZ signals 校验、空白查询） |
| R-86 | D16 登记，下载字节上限另立 PR |
| R-87 | D17 登记，验收 DOCX 读取预算另立 PR |
