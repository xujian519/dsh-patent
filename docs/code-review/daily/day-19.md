# Day 19 — 2026-12-03

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：B 维度横向复核与汇总（D13–D18 四域全部六组、21 条新发现）
- 时间盒：90 分钟
- 预期产出：聚类与批次建议、共享机制候选、preset 对照、死代码结论、净减少总账；F-CROSS-001、F-CROSS-002；`05-findings.md`、`03-hypotheses.md`、`07-ci-hardening.md` 与 `README.md` 的同步更新

## 检查项

- [x] 把四域重复实现聚类。
- [x] 列出共享机制抽取候选。
- [x] 对照四个 preset 的重复包清单。
- [x] 找出死代码与未使用导出。
- [x] 汇总 B 维度并更新假设状态。

## 实际执行

**口径（5 分钟）**：今日不做新的域内深审，只对 D13–D18 的结论做横向复核。三条原则先定：① 只统计已给净减少量的条目，`F-VID-003`/`F-VID-005`/`F-VID-006`/`F-DOC-004` 建立于「净减少量」要求之前，无此字段，汇总按**下界**处理；② 按根因聚类后要扣掉跨条重叠，否则「全部实施」的数字会虚高；③ 死代码判定必须能区分「符号不存在消费者」与「`export` 多余」，两者修法完全不同。

**检查项 ①：四域重复实现的聚类（25 分钟）**：D13–D18 的 21 条新发现，加上 Day 19 新增的 `F-CROSS-001` 与此前建立的四条（`F-DOC-004`、`F-VID-003`/`005`/`006`），共 26 条 B 维度发现按根因收敛为四簇；其中 `F-PAT-023` 是「TS 文件内嵌 Python 搬出去」的搬迁，仓库总行数不变，不参与聚类，故入簇 25 条（`F-CROSS-002` 是依赖声明缺口而不是重复实现，同样不入簇）。分簇依据是**修法形态**而不是文件位置——同一簇可以一次改动完成，跨簇则不能。

| 簇 | 根因 | 成员 | 已计净减少 |
|---|---|---|---|
| A 固定前导/尾部骨架逐处复制 | 一段固定的开头或收尾在 N 个包装函数里各写一遍，抽一次 helper/wrapper 即可 | F-PAT-027（子进程超时/取消 4 份）、F-LEG-006（判定尾 13 份）、F-VID-009（submit/poll + 图片编码）、F-PAT-025（YAML 失败惯用法 5 处）、F-PAT-026（结构克隆 5 处）、F-PAT-030（邻居循环 3 份）、F-PAT-019（文本读取 4 份）、F-VID-010（锁+读+改+写 3 份） | −231~−272 |
| B schema 与默认值双源 | 同一字段的类型、默认值或校验在两处各写一遍，需要「让缺省值只落一次」 | F-PAT-024（7 包 42 对 `??`）、F-DOC-006（请求类型按字段重写）、F-DOC-004（已修，文档域模板）、F-LEG-008（输出 schema 维度对象 3 份）、F-VID-003 / F-VID-005 / F-VID-006（schema 与手写类型、13 个默认值、字段全同）、F-VID-008（跨 plane 第二份文法） | −149~−169（F-VID-003/005/006 未计） |
| C 同一概念多接受集或语义分叉 | 概念只有一个，各处对它的接受范围不同，或同名不同义 | F-PAT-020（权项号缺省语义相反）、F-PAT-028（中文案卷号接受集相反）、F-PAT-022（`orientation` 同名异义）、F-PAT-031（死字段 + 重扫）、F-PAT-021（失效 JSDoc 引用） | −78~−83 |
| D 共享原语未复用 | 仓库已有唯一实现或应当唯一，四域另有本地副本 | F-CROSS-001（`messageOf`/`asRecord`）、F-LEG-007（`getById` 逐字相同）、F-PAT-029（`escapeRegExp` 10 处）、F-LEG-009（`asRecord` + 同名 `hasText`） | −45~−64（其中 −16 与 A、B 簇重叠，见检查项 ⑤） |

**为什么按修法而不是按域分簇**：D13–D18 的分域结论已经把「哪两个包重复」说清了，横向复核要回答的是「哪几条能一起改」。A 簇的八条各自加一个 helper 或 wrapper，互不依赖，但都落在「包装函数」这一层；B 簇的七条共享同一个修法模板（缺省值落一次），`patent-workflow` 已是正确写法；C 簇净减少小，它真正的产出是把差异显式化，因此不建议独立排期，应并入它所在文件的其他条目；D 簇的收益不在行数而在「一个语义一个所有者」。

**检查项 ②：共享机制抽取候选（20 分钟）**：逐条查证后，**本轮不需要新建任何共享抽象**。四簇里最有价值的候选是已经存在但没被用起来的机制。

| 候选 | 现状 | 决定 |
|---|---|---|
| `errorMessage` / `asRecord`（`packages/util/value`） | 已有唯一实现，已 12 个域内文件直接导入 | 复用，删除本地副本 → F-CROSS-001 |
| `ResolvedConfig` + `assertResolvedConfig`（同包） | 已有实现，`packages/api/gateway/src/index.ts:19` 是消费者 | 作为 B 簇的修法模板，交给 F-PAT-024/F-DOC-004/F-VID-005 |
| `escapeRegExp` | 全仓无共享实现；专利域 10 处，另在 `packages/legal/legal-law/src/reference.ts:121` 与 `apps/desktop/src/core-package-set.ts:161` | 唯一值得新增的候选，但落点取决于 `apps/desktop` 的依赖面（见未决 2） |
| `imageDataUri` / `imageMediaTypeOf` | 两份（`minimax.ts`、`siliconflow.ts`），且已漂移 | 上提到同包的 `cloud-common` 基类，不跨域、不新建包 |
| 客户端文档文法（F-VID-008） | Host 侧 `node:fs` 依赖使其不能跨 plane 导入 | 形态未定（见未决 1），本轮不选型 |
| 检索引擎骨架 | 法律域数据驱动、专利域抽象模板，方向相反 | 明确不做（Day 17 结论），此处记录为「已否决候选」，避免后续重复提议 |

**检查项 ③：preset 的重复包清单（20 分钟）**：H09 的前提与现状已有出入，先纠正事实。`packages/bundle/web-app/presets/` 下有 7 个 patch（`cordis`、`document`、`legal`、`minimal`、`patent`、`ptc`、`standard`），`packages/experimental/video-bundle/presets/` 下有 1 个（`video`），共 **8 个**，不是四个。按 `name: '@deepseek-ai/dsh-*'` 计插件行：

| preset | 插件行 | 去重 |
|---|---|---|
| patent | 42 | 41 |
| legal | 32 | 31 |
| document | 31 | 27 |
| standard（authority） | 30 | 29 |
| ptc | 29 | 28 |
| cordis | 28 | 27 |
| video | 27 | 26 |
| minimal | 10 | 9 |

八个 preset 合计 **229 行、56 个不同插件包**（去重后 218 行）。分布是：5 个包出现在全部 8 个 preset，20 个出现在 7 个，5 个出现在 2 个，1 个出现在 3 个，**25 个只出现在 1 个**（即各域专属面，专利 13、法律 3、终端/命令 4、其余 5）。也就是说**共享核心的 25 个包是逐字复制到 7–8 个文件的**，这正是 H09 担心的形态。

门禁覆盖比 H09 的假设完整得多，四道 preset 门禁已在 `scripts/run-gates.ts:881`–`884` 以 `quick: true` 挂载：`verify-agent-preset-config` 用插件自身的 Config schema 逐个校验 preset 行（复刻 loader 的 `unwrapExports`/`resolveConfig`/`validate`）；`verify-preset-tool-refs` 校验反引号里的工具名；`verify-preset-divergence` 取「两个以上 preset 都携带的同一 `- id:` 行」的原文块哈希，与 `scripts/preset-divergence-baseline.json` 比对，未登记的分叉、登记后内容变化、登记过却不再分叉三者都失败，另有一份「相对行数最多的 preset 缺了哪些行」的报告；`verify-preset-mode-baseline` 以 `standard.patch.yml` 为 `authority`，把其余 preset 分成 `delivery`（必须携带 authority 全集，或登记 `explainedAbsences` 说明缺席理由）与 `utility`，并声明 `requiredRows` 与 `forbiddenKeys`。另有 `verify-runtime-closure` 与 `verify-default-product-isolation` 覆盖运行时闭包与默认产品隔离。

因此 H09 的「漂移会静默」在四道门禁下已不成立，**残留缺口只剩一个方向**：`authority` 行集本身取自某个 preset 的行清单，所以「仓库里存在、但从未进入任何 preset 的包」对所有门禁都不可见——门禁比较的是 preset 之间，而不是仓库与 preset 之间。这一方向不能机械推导（哪个包属于哪种模式是产品判断），因此它不构成 CI 建议，只作为发布检查项。

**检查项 ④：死代码与未使用导出（15 分钟）**：方法是对四域七个包 `src/` 下的 `export` 声明建全仓文本索引（8709 个 TS 文件 + 全仓 `md`/`yml`/`json`/`py`），比对「除声明文件外是否被提及」。扫描范围 639 个 `export` 声明，命中 63 条。逐条判定后**没有一条是死代码**：

- **62 条在声明文件内仍被使用**，其中一部分经 `export *` 进入包公开面（例如 `patent-workflow/src/docket-issue.ts` 的 6 个类型全部经 `src/index.ts` 上架），另一部分是纯粹的 `export` 多余（`packages/document/tool-office/src/formats.ts:22` 的 `CONVERSION_OUTPUTS` 只在同文件 `:138` 被读）。收窄前者是对外 API 变更，归 F-PAT-013；收窄后者是零风险删字，但没有独立价值。
- **1 条完全未被使用**：`packages/patent/patent-workflow/src/worker-contract.ts` 的 `WorkerExecutionRecord`。它已被 `.agents/audits/2026-11-01-export-surface-cleanup-plan.md` 的 EXP-03 登记为 PUBLIC-API（「经 `export *` 上架的类型」），属于有意的公开面，不是遗漏。

三处易误判的情况今日都排除掉了：`TRIZ_PARAMETER_MIN`/`MAX`/`TRIZ_GAP_KINDS`/`TRIZ_EXTRACTION_SCHEMA` 在 `docs/upgrade-guide/v0.2.1-rc.2/patent-core-package-surface/` 里被登记为公开面；`PatentPlantaskEvent`/`PatentEvidenceLedgerEvent`/`PatentLegalGapsEvent` 出现在 `docs/persistence-catalog.md` 与 `docs/persistence-schema.json`；`WorkerInputContract`/`PlanTaskTransitionContext` 在 Agent Note 与包 README 里。只扫 TS 会把这 9 条全部误报为死代码。

**检查项 ⑤：汇总与净减少总账（15 分钟）**：已给净减少数字的 22 条（D13–D18 的 21 条 + `F-CROSS-001`；`F-PAT-023` 的 933 行是搬迁、`F-CROSS-002` 是 0 行，两者都不进这个合计数）相加为 **−503~−588 行**，扣掉跨条重叠后 **−487~−572 行**。重叠有两处：F-CROSS-001 的 `messageOf` 部分吸收 F-VID-009 已计的 −12 行，`asRecord` 部分吸收 F-LEG-009 已计的 −4 行，合计 −16。三段可选收益单列，不进上面的数：F-LEG-006 的布尔三元块 −62 行（计入则 −549~−634）；F-PAT-007 尾项的 −149 行 spec 与 −9 行导出面（D13–D18 各日合计一律不含它，口径一致）；F-PAT-023 的 933 行是 TS 文件内嵌 Python 的**搬迁**，仓库总行数不变，只有按「TS 文件行数」口径才计收益。

批次建议按「零架构风险 → 需人工确认 → 需形态决策」排序：

1. **B1（D 簇，S）**：F-CROSS-001 + F-LEG-007 + F-PAT-029 + F-LEG-009，−41~−60 行，全是 import 或删函数，四域测试即可证。
2. **B2（A 簇可复用已有抽象者，S/M）**：F-PAT-027（`subprocess-render` 已存在）、F-PAT-030、F-PAT-019，−95~−110 行，无对外行为变化。
3. **B3（A 簇其余，M）**：F-LEG-006(a)、F-VID-009 的 `imageDataUri` 部分、F-PAT-025、F-PAT-026、F-VID-010，−96~−115 行；其中 F-VID-010 应排在 F-VID-001 的跨进程守卫之后（Day 18 未决 3）。
4. **B4（B 簇，M）**：F-PAT-024（7 包）+ F-DOC-006 + F-LEG-008，−89~−99 行，统一走 `ResolvedConfig` 模板。
5. **不排期**：F-VID-008（须先定 browser-safe 包形态）、F-PAT-023（须先用 `ELECTRON_RUN_AS_NODE` 探测 asar）、F-PAT-022（须先定 `orientation` 的契约）。

转入 CI 防线（写入 `07-ci-hardening.md`，本计划不改配置）：导出面校验（F-PAT-013，「导出必须有包外消费者或显式 `@public`」）；同形本地助手检测（F-CROSS-001，oxlint `no-restricted-syntax` 禁 `src` 内定义 `messageOf`/`errorText`/`asRecord`）；默认值双源检测（F-PAT-024，「同包内同一字段同时出现 schema `.default` 与 `?? 同值字面量` 即报错」）；反向依赖声明校验（F-CROSS-002，源码里每个 workspace specifier 必须出现在本包清单的某一节，补上现有门禁只覆盖的「声明→使用」反方向）。已有的 preset 四道门禁不需要新增建议，`07-ci-hardening.md` 原有的「组合预设漂移」一行描述已过时，改为记录残留的 authority 方向缺口。

**机械复核（5 分钟）**：① 净减少加总初稿按各日合计直接相加得 −494~−571，未扣 D14 的 F-PAT-024（17 行）与 D15 的扩写（42 行）重叠，按条目重算并去重后订正为 −487~−572。② 死代码扫描第一版用 `git grep -- 'packages/patent/*/src'` 只命中视频域 30 个文件（与 Day 16 的 pathspec 陷阱同源），改成先 `git ls-files` 再过滤 `/src/` 得 639 个文件。③ `git grep -E '…\b'` 在 BSD 正则下 `\b` 是退格符不是词边界，首轮 `messageOf` 统计因此为 0；去掉 `\b` 后全仓定义 19 处、四域 4 处。④ `CONVERSION_OUTPUTS` 与 `TRIZ_PARAMETER_MIN` 两条抽样各自暴露一类假阳性（同文件内使用、升级指南登记）后，才把索引扩到非 TS 文本文件。⑤ preset 行数初稿按 `grep -c 'dsh-'` 得 patent 47 行，与实际 `name:` 行 42 条不符（差额来自 `config` 内的包名提及），改按 `name:` 计。⑥ 因 `ptc.patch.yml` 存在，先前「`pct.patch.yml` 不存在、共六个 preset」的记录作废，今日订正为八个。⑦ 三处计数在自查中修正：preset 插件行初稿写 199（实为 229，去重 218）、共享核心初稿写 26 个包（实为 25）、直接导入 `dsh-value` 的域内文件初稿写 10 个（实为 12），另把「29 条 B 维度发现」改为可核对的「21 条新发现 + 4 条既有 = 25 条」。⑧ 检查项 ② 的旁证带出 F-CROSS-002：查「哪些包已声明 `dsh-value`」时发现 `packages/patent/patent-tools` 未声明却在 `src/tool/law-search.ts:16` 导入，`pnpm run verify-package-dependencies` 仍退出 0（104 个包全部「符合策略」），因此这条不是标签问题而是门禁方向缺口。

## 发现

新增 2 条跨域发现：

| ID | 标题 | 净减少 |
|---|---|---|
| F-CROSS-001 | 四域另有 4 份 `messageOf`/`errorText` 与 1 份可并的 `asRecord`，而 `dsh-value` 已有对应原语且 11 个域内包已依赖它 | −26~−32 行 |
| F-CROSS-002 | `patent-tools` 导入未声明的 workspace 依赖 `@deepseek-ai/dsh-value`，运行产物靠打包内联掩盖 | 0 行，收益是依赖图与 SBOM 完整 |

与既有发现的关系：F-CROSS-001 的 `asRecord` 部分闭合了 F-LEG-009 在 Day 17 留下的「是否值得为 4 行引入 `dsh-value`」——11 个域内包已在 `package.json` 声明该依赖，答案是不用新增依赖；`messageOf` 部分吸收 F-VID-009 中的同名助手项，该条的 submit/poll 骨架仍独立成立。F-PAT-013 增补了 Day 19 的横向测量（七包 63 条零外部提及，零死代码），判定不变。

F-CROSS-002 是今日唯一一条纯新缺陷，来源不是聚类而是检查项 ② 的旁证：统计「哪些包已在清单里声明 `dsh-value`」时发现 `patent-tools` 是唯一例外，随后在源码里找到它的值导入 `law-search.ts:16`。它同时暴露一个门禁方向缺口——`verify-package-dependencies` 只校验声明侧与已登记导出，「源码导入 → 清单声明」这个方向没有校验。若该方向是有意的（运行时统一打包内联），本条应降为「在依赖策略里写明豁免」，而不是补依赖；两种处置都要求先明确约定，因此列在未决 2。今日不再新开其他编号：A/B/C 三簇的条目都已在册，横向结论是「批次怎么切」，属于排期信息，写在本页而不是发现清单。

## 假设验证/推翻

**H09 判为推翻（前提失准）而非收窄**：假设成立的前提是「四个 preset 手工列包，而门禁只覆盖部分引用」。事实是 8 个 preset（web-app 7 + video-bundle 1）、56 个不同包、199 行，共享核心 26 个包确实靠复制，但已有四道专门门禁覆盖「行块漂移（哈希 + 基线）」「某个 preset 缺了 authority 行（含 `explainedAbsences`）」「preset 里的包配置不匹配插件 schema」「工具名不存在」，另有运行时闭包与默认产品隔离两个门禁。H09 描述的静默漂移路径已被封死，残留的是相反方向——仓库有包、preset 全无——而那个方向不可机械判定。判定：推翻，并把「四个」这个计数错误一并纠正。

H01、H02 复核无回归：H01 的 5 个 fs I/O 模块仍在 `patent-workflow` 与随包资产内，`patent-core` 未新增 I/O；H02 的原语层十个跨域原语仍各有多消费者，本轮新增的 F-CROSS-001 恰好是「原语层完整、消费侧没接上」的补充例证，不改变 Day 17 的「引擎骨架不合并」结论。

H04、H10 与今日范围无交集，不更新。H06 的下界今日有一个新输入：27 条 B 维度发现里「是否可自动化」标为「是」的有 15 条、「部分」11 条、「否」1 条（F-PAT-021，注释里的跨包相对路径），但那只说明验证成本低，不说明已有测试覆盖，具体判定仍留 D27–D33。

## 未决问题

1. F-VID-008 的形态决定 B 簇能不能一次改完：如果新建 browser-safe 叶子包，B4 的 `document`/`video` 两条可以合并成一个批次；如果选择「Host 侧导出 schema、客户端消费」，改动面落在 `video-mode` 的编译面登记上。这需要一次架构判断，且都不在本计划「不改业务代码」的范围内。
2. 依赖声明方向要一次定清，它同时决定两件事：① `escapeRegExp` 的落点——仓库里第四处消费者在 `apps/desktop/src/core-package-set.ts:161`，若 `apps/desktop` 已依赖 `packages/util/*`，放进 `dsh-value` 是零成本，否则会新增一条 `apps → util` 边，需要先跑 `pnpm run gen-module-graph` 并复核 `verify-module-graph`；② F-CROSS-002 的处置——是补 `patent-tools` 的依赖声明，还是在依赖策略里写明「运行时一律打包内联、workspace 依赖不强制声明」并把 `verify-package-dependencies` 的反向校验排除在外。两者必须同向，否则同一个问题会以两种规则并存。
3. 汇报口径要与 #845 的 KPI 对齐：按「TS 文件行数」算，F-PAT-023 的 933 行搬迁是最大单项；按「仓库总行数」算它是 0。本页统一采用后者，若 #845 采用前者，B 维度总账要重述。

## 明日第一件事

Day 20（C 优化：`patent-tools`、`patent-core` 的热点路径）第一件事：先用 `pnpm run dsh --profile headless` 或现有 e2e 路径拿到**实测**热点，而不是按行数猜热点——`patent-tools/src/tool/` 里 `registerPatentTools` 312 行（F-PAT-009）与 `freecad-structure-script.ts` 1233 行（F-PAT-023）都是结构热点，不一定是运行时热点。具体顺序：① 从 e2e 的耗时输出或 `benchmarks/` 现有用例取冷启动、单工具调用、全流程三段基线；② 对 `patent-core` 的检索与规则求值路径做一次火焰图或 `--cpu-prof` 采样，区分「启动期一次性开销」与「每次调用开销」；③ 检查今日 D 簇漏掉的一类开销——同一文档在 `patent-tools` 与 `patent-core` 之间被重复解析（F-PAT-019 的四份文本读取器天然意味着四次全量解析）。C 维度的净收益要用测量值表达，不接受「减少一次数组拷贝」这类无量化建议。
