# Day 3 — 2026-11-17

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-17）。

## 今日维度与范围

- 维度：定向与基线
- 范围：专利域外围：patent-rule、patent-law、patent-fees、patent-deadline、patent-document、patent-filing、patent-knowledge、patent-data、patent-teams、writing-patterns、methodology、tool-literature
- 时间盒：120 分钟
- 预期产出：专利域外围数据流笔记；更新 01-repo-map.md；daily/day-03.md

## 检查项

- [x] 记录法条、费用、规则资产与写作范式语料的加载路径。
- [x] 记录期限与费用算术的入口、输入与输出。
- [x] 记录文档渲染与立案组装的入口与交付链路。
- [x] 记录知识库、检索 provider 与团队/审批入口。
- [x] 标记外部依赖与失败可见行为。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 列出 12 包 `src` 结构 | 覆盖 rule/law/fees/deadline/document/filing/knowledge/data/teams/writing-patterns/methodology/tool-literature |
| 统计 `ctx.tools.register` | patent-tools 42 处、patent-teams 12、tool-literature 3、patent-filing 2、patent-document 2、writing-patterns 1、patent-law 1、patent-fees 1、methodology 1 |
| 统计服务读取 | `ctx.subagents` 11、`ctx.get('agents')` 7、`ctx.patentTeams` 6、`ctx.patentData` 5、`ctx.get('approval')` 5、`ctx.get('patentRuleGate')`/`ctx.get('patentDeadline')` 各 1 |
| `grep` 资产加载 | rule/law/fees/deadline/document/filing/writing-patterns/methodology 均用 `new URL('../assets/...', import.meta.url)` + `readFileSync` |
| `grep` 外部调用 | `patent-data` 的 `ctx.subprocess.spawn`、`patent-teams` 的 `ctx.subagents`、`tool-literature` 的 `globalThis.fetch` |
| 读关键入口 | `patent-deadline/src/index.ts`、`patent-knowledge/src/index.ts`、`patent-rule/src/index.ts` 的门禁挂载、`patent-teams/src/state.ts` 的持久化 |

## 数据流笔记

### 资产与算术

- `patent-rule`：`src/index.ts` 把规则输出门禁挂到 `tools/post-execute`，并在 `tools/pre-execute` 做前置检查；资产在 `assets/rules/`（`patent/`、`base/`、`domains/`、`pack.yaml`、`synonyms.yaml`、`pack.schema.json`），`rulesDir` 可覆盖。加载走 `runtime/RuleLoader.ts`、`runtime/rule-pack.ts`、`runtime/patent-compliance.ts`、`runtime/synonym-engine.ts`；同义词资产缺失时降级为纯关键词匹配并警告。
- `patent-law`：`assets/law/` 与 `assets/lineage/` 随包；`baseline.ts`、`lineage.ts`、`citator.ts`、`verify.ts` 读取索引并做逐条决策；注册 `law_verify` 工具。引用机制通过 `@deepseek-ai/dsh-patent-core` 的再导出消费 `law-core`。
- `patent-fees`：`assets/fees/` 随包；`fees.ts` 读费用表，`compute.ts` 与 `money.ts` 做费用、减缴与年费计算；注册 `patent_fees` 工具，`failOnUnverified` 控制未核验时的失败方向。
- `patent-deadline`：`assets/work-calendar/` 的 `cn-holidays.yaml` 在插件加载时读取；缺失或非法日历直接使部署失败，不静默丢掉顺延规则。`period.ts`、`delivery.ts`、`calendar.ts`、`statutes.ts` 做期限与送达日算术；注册 `patent_deadlines` 工具，`provideService`/`exposeTool` 控制服务与工具两种挂载角色。
- `writing-patterns`：`assets/patterns/` 随包；`pattern-store.ts` 读语料，`skill-compiler.ts` 编译 `<writing_skills>`，`prompt.ts` 组装提示；注册 `query_writing_patterns` 工具。
- `methodology`：`data.ts` 读 `assets/triz-matrix.json`、`triz-principles.json`、`triz-separations.json`；注册 TRIZ 工具并注入 section 提示。

### 文档与立案

- `patent-document`：`src/index.ts` 注册 `render_patent_document` 与 `verify_deliverable`；`document/templateResolver.ts` 在 `assets/templates/patent/<template>/assets/template.html` 定位模板（源码与打包两种候选路径），`brandInjector.ts` 注入 `--sati-doc-*` 品牌变量，`verify-deliverable.ts` 读文件并算 sha256。渲染通过 `ctx.subprocess`。
- `patent-filing`：`src/index.ts` 注册立案构建与交付核验两个工具；`filing/assets.ts` 定位 `assets/spec/申请文件.json` 与 `assets/template/申请文件模板.docx`，并用 `unpackedFsPath` 处理 Electron ASAR 解包路径；`filing/engine.ts` 从模板反解体例并计算内容哈希。构建与核验都通过 `ctx.subprocess`，可选 `pythonPath`。

### 知识、检索与团队

- `patent-knowledge`：`ctx.patentKnowledge` 惰性打开 `knowledge.db`（只读），提供判例、法规、指南、wiki 卡与知识图谱查询；数据库缺失或版本不匹配抛 `KnowledgeDbVersionError`。`install.ts` 只在显式调用时运行，插件加载不自动安装。
- `patent-data`：`ctx.patentData` 提供 nuo 检索、CNIPR 通道、ego-browser 子进程、缓存与串行队列；`ego-session.ts` 通过 `ctx.subprocess.spawn` 运行浏览器，`cnipr-script.ts` 构造脚本，`patent-cache.ts` 与 `serial-queue.ts` 控缓存与并发。
- `patent-teams`：`ctx.patentTeams` 管理队长、成员、任务板、邮箱与调度；成员通过 `ctx.subagents` spawn（连续会话），`ctx.get('agents')` 取调用方 agent，`ctx.get('approval')` 走审批；状态落在 `team.json` 与 `inbox/`，用 `withTeamLock` 与 `atomicWriteText` 串行化写入。
- `tool-literature`：注册论文检索、源列表与 PDF 下载三个工具；四个连接器（arXiv/OpenAlex/Crossref/Semantic Scholar）经 `globalThis.fetch` 访问外部 HTTP，带超时、重试与预算。

## 发现

代码级发现：无。Day 3 只做定向，不判定缺陷。

结构观察（待对应维度确认）：

1. 资产定位不一致：`patent-filing` 用 `unpackedFsPath` 处理 ASAR 解包，`patent-document` 尝试源码与打包两种候选路径；`patent-rule`、`patent-law`、`patent-fees`、`patent-deadline`、`writing-patterns`、`methodology` 只用 `new URL('../assets/...', import.meta.url)`。桌面打包或原生子进程读取时是否都能命中，留到 Day 37 与 Day 15 复核。
2. 规则资产的失败方向不一致：`patent-rule` 的同义词缺失降级为关键词匹配并警告；`patent-deadline` 的日历缺失直接使部署失败；`patent-knowledge` 的库缺失或版本不符抛错。是否会在合规判定中造成漏报，留到 Day 36 与 H07 复核。
3. 共享机制消费不对称：`patent-law` 通过 `patent-core` 的再导出消费 `law-core`，法律域的 `legal-law` 直接消费 `law-core`。Day 17 对照两域调用点。
4. `patent-teams` 的成员是 `ctx.subagents` 的连续会话，团队状态与邮箱落在文件系统并用团队锁串行化；审批走 `ctx.get('approval')`。候选 H05/H10，Day 8/11 复核。
5. `patent-data` 的 ego-browser 走 `ctx.subprocess.spawn`，CNIPR 走脚本与串行队列；候选 H05，Day 6 复核。
6. `patent-knowledge` 的安装与查询分离得较干净：插件加载不安装，数据库只读打开，版本不符 fail loud；可作为其他资产加载路径的对照。

## 假设验证/推翻

- H02：**部分观察**。`patent-law` 经 `patent-core` 再导出消费 `law-core`，`legal-law` 直接消费 `law-core`；是否存在单域特化分支，留到 Day 17。
- H05：**已定位**。`patent-data` 的 ego-browser 子进程、`patent-document`/`patent-filing` 的子进程、`patent-teams` 的成员 spawn 是主要汇点；Day 6/8/9 检查 argv/env/路径构造。
- H07：**已定位候选**。`patent-rule` 同义词降级、`patent-law` 的“未核验”语义、`patent-fees` 的 `failOnUnverified` 是三个观察点；Day 10/38 追返回值到提示词与交付门禁。
- H09：Day 3 未触及 preset，仍待 Day 4/19。

## 未决问题

1. ASAR 资产定位是否需要统一的 `unpackedFsPath`，还是 Electron 的 `fs` 垫片已覆盖所有读取路径。
2. `patent-rule` 同义词缺失的降级是否会在合规判定中漏报，需要 Day 36 用缺失资产用例验证。
3. `patent-teams` 的成员 spawn 与团队状态锁在失败或取消时如何恢复，留到 Day 8/11。

## 明日第一件事

Day 4：读文档模式 6 包、法律模式 3 包与共享机制 2 包的数据流，补全 `office-kit` 子进程/队列、DOCX 解析、法律引用与证据评分、`law-core`/`knowledge-core` 的消费点。
