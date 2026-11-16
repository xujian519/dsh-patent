# 发现清单

本页是四域审阅的统一发现清单。每条发现必须可执行：写清位置、证据、影响、最小修复建议、预估工作量与自动化可行性。

## 状态与编号

- 发现编号：`F-<域>-<三位序号>`，域取 `PAT`、`DOC`、`LEG`、`VID`、`CROSS`。
- 观察编号：`OBS-<三位序号>`，用于环境、工具链和流程缺口，不是代码缺陷。
- 状态：`new`、`confirmed`、`false-positive`、`deferred`、`fixed`、`wontfix`。
- 维度：A（安全）、B（代码质量与精简）、C（优化）、D（测试缺口）、E（正确性与边界）。
- 严重度：Blocker、High、Medium、Low；定义见 [00-scope.md](00-scope.md)。

## 发现模板

复制以下字段到新条目：

```text
### F-XXX-001 标题

- 位置：文件:行
- 维度：
- 严重度：
- 可能性：高/中/低
- 证据：命令、输出摘要、调用链或测试结果
- 影响：谁在什么条件下会遇到什么后果
- 最小修复建议：
- 预估工作量：
- 是否可自动化：
- 状态：
```

## 发现列表

| ID | 标题 | 域 | 维度 | 严重度 | 可能性 | 状态 |
|---|---|---|---|---|---|---|
| F-PAT-001 | 交付物原子写在 POSIX 上先删后改名 | PAT | E | High | 中 | fixed |
| F-PAT-002 | `rule_check` 丢弃同义词资产警告，合规检查静默降级 | PAT | B | High | 中 | confirmed |
| F-PAT-003 | 原子写四份手写实现，未复用仓库共享 `atomic-write` 包 | PAT | A/B | High | 高 | fixed（3/4） |
| F-PAT-004 | 品牌配置损坏时静默回退默认品牌 | PAT | B | Medium | 中 | confirmed |
| F-PAT-005 | 四个输出路径默认锚定 `process.cwd()` | PAT | E | Medium | 中 | confirmed |
| F-PAT-006 | `adversary-review` 以关键词启发式输出"置信度 87.5%" | PAT | B | High | 高 | confirmed |
| F-PAT-007 | `atomicWriteJson` 从 `patent-data` 历史导出面导入 | PAT | B | Low | 高 | fixed |
| F-PAT-008 | TRIZ 资产裸 `JSON.parse as T`，失败无包内错误类型 | PAT | B | Low | 低 | confirmed |
| F-PAT-009 | `registerPatentTools` 单函数 312 行 | PAT | B | Medium | 高 | confirmed |
| F-PAT-010 | `patent/model-call` 在流异常时不落会话事件 | PAT | E | Medium | 中 | confirmed |
| F-PAT-011 | `pending`/`rounds` 为进程内状态且未声明单进程语义 | PAT | E | Medium | 中 | confirmed |
| F-PAT-012 | 51 处 `as unknown as` 与两个零引用导出类型 | PAT | B | Low | 高 | confirmed |
| F-PAT-013 | `patent-core` 导出面过宽，大量内部符号对外 | PAT | B | Low | 高 | confirmed |
| F-PAT-014 | `patent_pdf_download` 的输出目录不受部署文件策略约束 | PAT | A | High | 中 | fixed |
| F-PAT-015 | PDF 兜底下载的临时文件路径可预测且不独占创建 | PAT | A/B | Medium | 中 | fixed |
| F-PAT-016 | ego-browser 子进程继承完整 `process.env` | PAT | A | Low | 中 | confirmed |
| F-PAT-017 | 交付前引用门禁只覆盖 `render_patent_document`，立案构建不经引用核验 | PAT | A/E | High | 低 | confirmed |
| F-PAT-018 | 后台运行接受模型自报的 `approveStageIds`，HITL 审批可绕过 | PAT | A | High | 中 | confirmed |
| F-PAT-019 | 同一管线状态的文本读取有 4 份实现，键列表解析已漂移 | PAT | B | Low | 高 | new |
| F-PAT-020 | 权项号派生两包各一份，无编号时的缺省语义相反 | PAT | B | Low | 中 | new |
| F-PAT-021 | `workflow/types.ts` 两处 JSDoc 指向不存在的 `./workflow-store.js` | PAT | B | Low | 高 | new |
| F-PAT-022 | `figure/` 几何与文本度量原语重复，`orientation` 同名异义 | PAT | B | Low | 高 | new |
| F-PAT-023 | `freecad-structure-script.ts` 1233 行里 940 行是内嵌 Python | PAT | B | Low | 高 | new |
| F-PAT-024 | 插件默认值两份来源：七个专利包 42 对 `??` 重述、2 处同义重述、1 处第三种缺省 | PAT | B | Medium | 高 | new |
| F-PAT-025 | 规则资产 YAML 失败处理惯用法重复 5 处，顶层对象校验两种写法 | PAT | B | Low | 高 | new |
| F-PAT-026 | `patent-teams` 内部 5 处结构克隆，事件载荷与邮箱结算各有两个编码 | PAT | B | Low | 高 | new |
| F-PAT-027 | 子进程超时/取消骨架 4 份，已抽好的 `subprocess-render` 未被其余 3 处复用 | PAT | B | Medium | 高 | new |
| F-PAT-028 | 输出目录与安全文件名判定 4 种编码，中文案卷号在两个工具间接受集相反 | PAT | B | Medium | 高 | new |
| F-PAT-029 | `escapeRegExp` 专利域内 4 份命名封装 + 6 处内联，仓内无共享实现 | PAT | B | Low | 高 | new |
| F-PAT-030 | `patent-kg-adapter` 邻居扩展循环 3 份，两个检索引擎 `backfillContent` 近克隆 | PAT | B | Low | 高 | new |
| F-PAT-031 | `templateDraft` 的 `openEnd` 是死字段，两处用 `indexOf` 重新定位已命中位置 | PAT | B | Low | 高 | new |
| F-DOC-001 | DOCX 渲染的 Markdown 解析无围栏代码块分支 | DOC | E | High | 高 | confirmed |
| F-DOC-002 | `document_deliver` 把取消与编程错误都报为"不可读" | DOC | E | Medium | 中 | confirmed |
| F-DOC-003 | OOXML 读取限额两包各写一份字面量 | DOC | B | Low | 高 | fixed |
| F-DOC-004 | 插件默认值出现两个来源（schema default 与 `??`） | DOC | B | Medium | 中 | fixed（文档域） |
| F-DOC-005 | `tool-office` 用 9 处 `as` 断言担保跨模块不变量 | DOC | B | Low | 低 | confirmed |
| F-DOC-006 | 跨模块请求类型按字段重写而非组合（`RenderRequest`、`OfficeImagesRequest`） | DOC | B | Low | 高 | confirmed |
| F-LEG-001 | `legal-law` 名字表是模块级只增状态，加载不复位 | LEG | E | High | 中 | confirmed |
| F-LEG-002 | `legal-evidence` 的 YAML 通用规则不参与判定 | LEG | E | High | 高 | confirmed |
| F-LEG-003 | 非法 `severity` 与非数值 `weights` 静默回落且无警告 | LEG | E | Medium | 中 | confirmed |
| F-LEG-004 | 两域默认引用策略分叉，缺对照说明与回归护栏 | LEG | E | Low | 中 | confirmed |
| F-LEG-005 | 专利知识库降级日志写死 `[sati]` 前缀 | LEG | B | Low | 高 | confirmed |
| F-LEG-006 | 三性判定器把「打分 + 结论对象」手写 13 份，布尔三元打分块 18 处 | LEG | B | Low | 高 | confirmed |
| F-LEG-007 | `getById` 在 `legal` 与 `judicial-interpretation` 逐字相同 | LEG | B | Low | 高 | confirmed |
| F-LEG-008 | `evaluate_legal_evidence` 输出 schema 把维度判定对象写三份 | LEG | B | Low | 高 | confirmed |
| F-LEG-009 | `rule-set.ts` 手写 `asRecord` 与同名 `hasText`，未用共享工具 | LEG | B | Low | 中 | confirmed |
| F-VID-001 | 任务 journal 与账本无跨进程写守卫 | VID | E | High | 中 | confirmed |
| F-VID-002 | 成功任务缺 `output_path` 时不清 journal、不记账 | VID | E | Medium | 中 | confirmed |
| F-VID-003 | zod schema 与手写类型双份维护，靠 `as` 抹平 | VID | B | Medium | 高 | confirmed |
| F-VID-004 | ffmpeg 直接覆写目标，失败会毁掉上一版成片 | VID | E | Medium | 中 | confirmed |
| F-VID-005 | `resolveMediaConfig` 的 13 个默认值与 schema 默认值重复 | VID | B | Low | 中 | confirmed |
| F-VID-006 | `StrictRequest` 与 `MediaTaskRequest` 字段完全重复 | VID | B | Low | 高 | confirmed |
| F-VID-007 | 成本账本无完整性保护，模型可改写 `budget.json` 绕过预算 | VID | A | Medium | 中 | confirmed |
| F-VID-008 | `ui-video-studio` 手写第二份项目/账本/journal 文法，预算口径出现第三份 | VID | B | Medium | 高 | confirmed |
| F-VID-009 | 云 provider 的 submit/poll 与图片编码骨架各写一遍，拷贝已漂移 | VID | B | Low | 高 | confirmed |
| F-VID-010 | store 的「锁 + 读 + 改 + 写」骨架三处各写一遍 | VID | B | Low | 高 | confirmed |
| F-CROSS-001 | 四域另有 4 份 `messageOf`/`errorText` 与 1 份可并的 `asRecord`，而 `dsh-value` 已有对应原语且 11 个域内包已依赖它 | CROSS | B | Low | 高 | new |
| F-CROSS-002 | `patent-tools` 导入未声明的 workspace 依赖 `@deepseek-ai/dsh-value`，运行产物靠打包内联掩盖 | CROSS | B/E | Low | 高 | new |

## 专利域

### F-PAT-001 交付物原子写在 POSIX 上先删后改名

- 位置：`packages/patent/patent-document/src/document/renderPatentDocument.ts:114`
- 维度：E
- 严重度：High
- 可能性：中
- 证据：`atomicWriteFile` 依次执行 `writeFile(tmp)`、`rm(file, { force: true })`、`rename(tmp, file)`；注释说明这是 Windows 上 rename 不覆盖的变通，但代码无平台分支。对照 `patent-core/src/persist-utils.ts:103` 的 `atomicWriteJson` 直接 `rename` 覆盖，说明 POSIX 本可原子替换。
- 影响：渲染过程中进程崩溃或断电，落在"目标已删除、tmp 未改名"窗口时，上一次的交付物消失且无法从本工具恢复；文档渲染是立案与答复的关键路径。
- 最小修复建议：仅 `process.platform === 'win32'` 时先 `rm`，其余平台直接 `rename`；更强的做法是收敛到 `patent-core` 的单一实现（见 F-PAT-003）。
- 预估工作量：S
- 是否可自动化：是（单测断言非 Windows 分支不调用 `rm`）
- 状态：confirmed

### F-PAT-002 `rule_check` 丢弃同义词资产警告，合规检查静默降级

- 位置：`packages/patent/patent-tools/src/tool/rule-check.ts:216`
- 维度：B
- 严重度：High
- 可能性：中
- 证据：`loadSynonymsAsset()` 返回 `SynonymsLoadResult`（含 `warnings`），工具只取 `.synonyms`；同仓 `packages/patent/patent-rule/src/index.ts:478` 取用同一函数并把警告写进 `packWarnings`。`synonyms.yaml` 缺失时匹配退化为纯关键词。
- 影响：模型走 `rule_check` 工具时，合规判定可能漏报规则命中，而结果里没有任何提示；同一资产在插件门禁路径有警告、在工具路径无警告，用户无从判断结果可信度。
- 最小修复建议：把 `warnings` 并入工具结果（新增 `assetWarnings` 字段或复用 `packWarnings`），并在描述里说明降级语义。
- 预估工作量：S
- 是否可自动化：是（缺资产用例断言结果含警告）
- 状态：confirmed

### F-PAT-003 原子写四份手写实现，未复用仓库共享 `atomic-write` 包

- 位置：`packages/patent/patent-core/src/persist-utils.ts:103`、`packages/patent/patent-document/src/document/renderPatentDocument.ts:114`、`packages/patent/patent-tools/src/tool/internal/workflow-helpers.ts:122`、`packages/patent/patent-teams/src/team-lock.ts:223`
- 维度：A、B
- 严重度：High
- 可能性：高
- 证据：仓库已有 `packages/util/atomic-write`，`writeFileAtomic` 提供 `wx` 独占创建（拒绝临时路径上的预置符号链接）、Windows `EACCES`/`EBUSY`/`EPERM` 有界重试、文件与父目录 fsync、显式 `mode`，以及 `withFileLock` 跨进程串行。`patent-tools/src/figure/inkscape-renderer.ts:30` 已使用该包并在 `package.json:37` 声明依赖；`patent-core` 未声明。四处手写实现分别只有：core 有文件 fsync、document 无 fsync 且先删后改名、tools 无 fsync 且失败不清理 tmp、teams 有 Windows EPERM 分支但无跨进程锁。
- 影响：崩溃后的可恢复性取决于调用点走了哪份实现；缺 `wx` 使可预测的临时路径成为符号链接攻击面；共享包修复不会传导到四份手写实现，安全与耐久性会持续分叉。
- 最小修复建议：四包全部委托 `writeFileAtomic`，删掉本地 `atomicWrite*`；F-PAT-001 的先删后改名随之消失。
- 预估工作量：M
- 是否可自动化：是（克隆检测抓不到语义级重复，需用 lint 规则禁止包内再定义 `atomicWrite`）
- 状态：confirmed

### F-PAT-004 品牌配置损坏时静默回退默认品牌

- 位置：`packages/patent/patent-document/src/document/brandInjector.ts:41`
- 维度：B
- 严重度：Medium
- 可能性：中
- 证据：`loadBrandFromPath` 对不存在文件返回 `{}`，`catch` 把读取与 JSON 解析错误一并吞掉返回 `{}`；同模块 `resolveConfinedPath`（`:105`）对越界路径抛 `DocumentRenderError`。同一次渲染里两条失败方向相反。
- 影响：用户配置了 `brandPath` 但路径拼错或 theme.json 损坏时，交付物静默使用默认品牌，没有任何警告；署名与免责声明类品牌信息错误属于对外可见问题。
- 最小修复建议：区分"未配置"与"配置了但不可用"：前者返回默认，后者抛 `DocumentRenderError`；至少把失败写进渲染结果警告。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-PAT-005 四个输出路径默认锚定 `process.cwd()`

- 位置：`packages/patent/patent-tools/src/wiring.ts:197`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`resolveNoteDir`、`resolveFigureIndexFile`、`resolveChemistryIndexFile`、`resolveFigureOutputDir` 在未配置时分别落到 `join(process.cwd(), '99-知识库')`、`resolve(process.cwd(), '.sati/figures-index.json')`、`.sati/chemistry-index.json`、`patent/figures`。
- 影响：桌面打包部署下 cwd 可能是应用目录而非用户工作根，默认写入会落到不可写目录（工具失败）或应用包内（污染安装目录）；不同启动方式得到不同数据位置。
- 最小修复建议：默认根改为部署显式传入的工作区根（`ctx` 上的 workspace 服务）；确实没有时 fail loud 而不是猜 cwd。
- 预估工作量：M
- 是否可自动化：是（测试以不同 cwd 启动断言路径来源）
- 状态：confirmed

### F-PAT-006 `adversary-review` 以关键词启发式输出"置信度 87.5%"

- 位置：`packages/patent/patent-core/src/adversary/review.ts:9`、`:387`、`:397`、`packages/patent/patent-core/src/atoms/index.ts:217`
- 维度：B
- 严重度：High
- 可能性：高
- 证据：文件头注释写明"当前为确定性骨架（不调用模型），TODO 完整版需模型注入"；`assessArgumentStrength` 只做 `missedRejections`/`evidenceGaps` 关键词计数，`buildReviewSummary` 直接渲染 `整体置信度：${(overallConfidence * 100).toFixed(1)}%`；原子声明 `usesModel: false`，但经 `registerBuiltinAtoms()` 全局注册，与真正调用模型的 `adversary-model` 并列。
- 影响：模型与用户看到"论证强度：充分；整体置信度：87.5%"，无法分辨这是关键词命中率而非实体论证评估；对外可见的审查结论强度被系统性高估，属于语义误导。
- 最小修复建议：摘要去掉百分比，改称"关键词覆盖率"；或在结果与原子描述里强制前缀"确定性启发式，非实体论证评估"；按 TODO 接入 `PatentModelPort` 后恢复置信度字段。
- 预估工作量：M
- 是否可自动化：部分（断言原子结果含 `deterministic: true` 标记）
- 状态：confirmed

### F-PAT-007 `atomicWriteJson` 从 `patent-data` 历史导出面导入

- 位置：`packages/patent/patent-tools/src/tool/knowledge-note-file-writer.ts:16`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：该 helper 的实现与归属在 `patent-core/src/persist-utils.ts:103`，`patent-data` 只是再导出；`patent-tools` 与 `patent-data` 因此产生一条非真实依赖边。
- 影响：依赖图与归属不符，删除或搬迁 `patent-data` 时会误伤；读者按包名找不到实现。
- 最小修复建议：改从 `@deepseek-ai/dsh-patent-core` 导入，并删除 `patent-data` 的再导出。
- 预估工作量：S
- 是否可自动化：是（模块图与依赖检查）
- 尾项（Day 15 复核，不另开编号）：批次 A 只改了导入侧，`patent-data/src/index.ts:90`–`97` 的再导出按其注释「keeps its historical public surface」保留。范围复核结论：`JsonFileStore`、`SAFE_ID_PATTERN`、`assertSafeId`、`atomicWriteJson` 与 5 个 case 路径符号的生产消费者为 0——`patent-filing/src/filing/engine.ts:15`、`patent-workflow`、`patent-tools` 全部直接从 `patent-core` 导入。唯一消费方是 `patent-data/tests/persist-utils.spec.ts`（149 行，文件头注明是 Sati 测试的移植）与 `scaffold.spec.ts:25`–`34` 的 8 条 `typeof === 'function'` 断言。口径可行：`docs/upgrade-guide/v0.2.2-alpha.2/patent-unused-export-removals/` 已有「零消费导出即删 + 写升级指南」的先例，`docs/upgrade-guide` 里也没有 `patent-data` 的保留声明。**前置约束**：`persist-utils.spec.ts` 是 `patent-core/src/persist-utils.ts` 行为用例的唯一出处（`patent-core` 自己的 tests 里对 `assertSafeId`/`SAFE_ID_PATTERN` 零引用），删除前必须先把用例搬进 `patent-core`，否则 per-file 100% 覆盖率门禁会红。净减少：−149 行 spec、−8 条 scaffold 断言、再导出面 −9 行（含注释），并去掉一条 `patent-data → patent-core` 的伪公开面。
- 状态：fixed（导入侧已改；再导出面尾项见上）

### F-PAT-008 TRIZ 资产裸 `JSON.parse as T`，失败无包内错误类型

- 位置：`packages/patent/methodology/src/data.ts:14`
- 维度：B
- 严重度：Low
- 可能性：低
- 证据：三个 `triz-*.json` 共用一次 `JSON.parse(...) as T`，无字段校验；缺失抛裸 `ENOENT`、格式错抛裸 `SyntaxError`。对照 `patent-index-asset` 的严格 readers 与 `patent-fees` 的 `FeeTableError`。
- 影响：资产损坏时报错不含包内上下文与资产路径，难以定位；`as T` 让字段漂移在运行期才暴露。
- 最小修复建议：加逐资产类型与 `MethodologyAssetError`，或复用 `patent-index-asset` 的读取器。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-PAT-009 `registerPatentTools` 单函数 312 行

- 位置：`packages/patent/patent-tools/src/wiring.ts:299`
- 维度：B
- 严重度：Medium
- 可能性：高
- 证据：文件共 610 行，`registerPatentTools` 从 299 行起占约一半，串起 manifest 校验、原子注册、四组路径解析与 37 个工具装配；同包 `createXTool` 工厂普遍 130–160 行。
- 影响：任何新增工具都要改同一个函数，冲突面与误改面大；定位某个工具的装配失败要在 300 行里回溯。
- 最小修复建议：按 figures / workflow / knowledge / filing 拆成四个 `register*Group`，主函数只保留编排与依赖解析。
- 预估工作量：M
- 是否可自动化：否（结构重构，靠测试护栏）
- 状态：confirmed

### F-PAT-010 `patent/model-call` 在流异常时不落会话事件

- 位置：`packages/patent/patent-workflow/src/model-call-log.ts:49`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`session.append('patent/model-call', ...)` 位于 `for await` 循环之后，无 `try/finally`；流中途抛错或消费者提前 `return` 时不执行 append，已 yield 的 delta 不进入会话日志。
- 影响：违反仓库"Model-visible ⟺ logged"规则；会话回放看不到这部分模型输入输出，model-call 计数与实际调用不符。
- 最小修复建议：把 append 移入 `finally`，事件增加 `truncated: true` 标记异常终止。
- 预估工作量：S
- 是否可自动化：是（注入中途抛错的流，断言事件仍存在且标 truncated）
- 状态：confirmed

### F-PAT-011 `pending`/`rounds` 为进程内状态且未声明单进程语义

- 位置：`packages/patent/patent-workflow/src/index.ts:148`、`:150`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：两个字段是 `private readonly Map`；状态机终态已写入会话事件，但 README 未声明"单进程/重启不恢复"。
- 影响：重启后挂起的 plantask 与轮次计数静默丢失；用户看到工作流停在中间，`approve` 找不到 pending，且没有文档解释这是预期语义。
- 最小修复建议：README 显式声明单进程契约（含重启行为），或从会话事件重建 pending 与轮次。
- 预估工作量：M
- 是否可自动化：是（重启用例断言状态可恢复或明确报错）
- 状态：confirmed

### F-PAT-012 51 处 `as unknown as` 与两个零引用导出类型

- 位置：`packages/patent/patent-tools/src/tool/` 各工具文件；`packages/patent/patent-workflow/src/worker-contract.ts`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`grep 'as unknown as'` 在 patent-tools 命中 51 处，其中 28 处目标为 `JsonValue`，集中在工具结果渲染（analysis-report 8、flexible-plan 7、workflow-run 6）；均已在 `scripts/no-unknown-casts.baseline.json` 冻结。`WorkerExecutionRecord` 与 `WorkerOutputValidation` 在全仓除声明文件外零引用。
- 影响：工具返回值与渲染器入参绕过类型检查，service 签名改动不会被编译器发现；未引用导出增加公开面维护成本。
- 最小修复建议：提供 `toJsonValue()` 序列化器或让结果类型实现可序列化接口，机械替换后收紧基线；删除两个零引用导出。
- 预估工作量：M
- 是否可自动化：是（基线门禁已在）
- 状态：confirmed

### F-PAT-013 `patent-core` 导出面过宽，大量内部符号对外

- 位置：`packages/patent/patent-core/src/index.ts`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：符号索引交叉比对显示约 487 个公开导出，其中约 37 个在 `patent-core/src` 之外全仓零引用、约 217 个在包外（含测试）零引用。抽样复核 `matchKeywordsAll`、`renderClaimStrategyReport`、`describeCitation`、`readJsonStringArray` 四个：均在 `index.ts` 导出、包外 0 引用、包内 5–9 处使用。全部样本都不是死代码，属于导出面过宽。全量计数来自子代理的符号索引比对，未逐条复算。
- 影响：内部实现的重命名都变成对外 API 变更；`verify-export-jsdoc` 与 README 必须为纯内部机制维护公开契约，维护成本随导出数增长。
- 最小修复建议：把 atom/handler 常量与内部 helper 收回各自 barrel（`atoms/index.ts` 已全局注册的可不对外导出），逐个确认后再收窄；给门禁加一条"导出必须有包外消费者或显式 `@public` 标注"。
- 预估工作量：M
- 是否可自动化：是
- 状态：confirmed
- Day 19 横向复核（扩范围，不改判定）：本条不限于 `patent-core`。对四域七包 `src/` 的 639 个 `export` 声明做全仓文本索引比对，除声明文件外零提及的有 63 条，逐条判定后**没有一条是死代码**：62 条在声明文件内仍被使用（`export` 多余或仅为经 barrel 进入公开面），1 条 `WorkerExecutionRecord` 全仓零使用但已被 `.agents/audits/2026-11-01-export-surface-cleanup-plan.md` 的 EXP-03 登记为 PUBLIC-API。因此可收窄的是「导出关键字」而非「符号」，计数口径与 #651 一致，本条的证据从 `patent-core` 扩到该七包。

### F-PAT-014 `patent_pdf_download` 的输出目录不受部署文件策略约束

- 位置：`packages/patent/patent-tools/src/tool/patent-pdf-download.ts:511`、`packages/patent/patent-core/src/pdf-download.ts:67`、`packages/patent/patent-tools/src/tool/patent-pdf-download-ego.ts:154`
- 维度：A
- 严重度：High（判定依赖威胁模型，见下）
- 可能性：中
- 证据：`resolveDatedOutputDir` 只做 `resolve(cwd, outputDir)`，绝对路径原样接受、相对路径可含 `..`；模型的 `outputDir` 参数描述也写明"绝对或相对当前工作目录"。随后 `mkdir(outputDir)`、`writeFile`/`rename` 全走 `node:fs`，同一路径还作为 ego-browser 子进程的 `cwd`。对照同域 `patent-document`（`renderPatentDocument.ts:86`）与 `patent-filing`（`engine.ts:133`）都走 `resolveConfinedPath`。
- 影响：部署若通过 `ctx.fs` 的 sandbox 策略限制写入范围，本工具可以绕开——模型被页面内容或提示注入影响时，可把 PDF 与截图写到工作区之外的任意可写目录，并让第三方浏览器进程以该目录为 cwd 运行。
- 最小修复建议：与同域其它工具一致，用 `resolveConfinedPath(outputDir, cwd, '输出目录', …)`；若产品确实需要写任意目录，改为部署级 `Config` 白名单，而不是模型参数。
- 预估工作量：S
- 是否可自动化：是（`..`、绝对路径与符号链接越界用例）
- 状态：confirmed

### F-PAT-015 PDF 兜底下载的临时文件路径可预测且不独占创建

- 位置：`packages/patent/patent-tools/src/tool/patent-pdf-download.ts:332`
- 维度：A、B
- 严重度：Medium
- 可能性：中
- 证据：临时文件路径固定为 `` `${target}.tmp` ``，随后 `writeFile(tmp, buf)` 再 `rename(tmp, target)`；没有随机后缀、没有 `wx` 独占创建、没有文件与父目录 fsync，也没有 Windows `EPERM`/`EACCES` 重试。同批次 A 已收口的共享 `writeFileAtomic` 四项俱全。
- 影响：能写该输出目录的本地进程可预先在 `<target>.tmp` 放置符号链接，让下载内容写到别处；崩溃时目标可能是半写状态；Windows 上目标已存在时 rename 会失败。这是批次 A 遗漏的第五份原子写。
- 最小修复建议：改用 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic(target, buf, { mode: 0o644 })`；同时并入批次 A 的复用收口。
- 预估工作量：S
- 是否可自动化：是（预置符号链接的用例）
- 状态：confirmed

### F-PAT-016 ego-browser 子进程继承完整 `process.env`

- 位置：`packages/patent/patent-data/src/ego-session.ts:51`、`:121`、`:193`
- 维度：A
- 严重度：Low
- 可能性：中
- 证据：`this.env = options.env ?? process.env`，`buildEnv` 在复制全部变量后只追加 `PATH` 条目，再作为子进程环境传入；同一批 `patent-tools/src/figure/freecad-renderer.ts:271` 的 FreeCAD 相反，只传 `HOME`/`XDG_*`/`TEMP`。
- 影响：第三方浏览器二进制及其启动的页面进程拿到 `DEEPSEEK_API_KEY` 等全部进程级凭据。浏览器本就能读用户文件，所以这是最小权限问题而非直接泄露；但同一仓库两个子进程的凭据暴露面不一致，缺少统一约定。
- 最小修复建议：ego-browser 只传白名单（`PATH`、`HOME`、语言与显示相关变量），需要登录态时由 ego 自己的配置承担。
- 预估工作量：S
- 是否可自动化：是（断言子进程环境不含未列入白名单的变量）
- 状态：confirmed

### F-PAT-017 交付前引用门禁只覆盖 `render_patent_document`，立案构建不经引用核验

- 位置：`packages/bundle/web-app/presets/patent.patch.yml:500`、`:383`、`packages/patent/patent-rule/src/index.ts:425`
- 维度：A、E
- 严重度：High
- 可能性：低
- 证据：`citationGate` 只有一条，`tool: render_patent_document`；`build_patent_filing` 的 `deliveryGate` 只要求本会话跑过 `law_verify`，且 `isBlockedResult` 只看结果里的 `blocked: true`。而 `patent-law` 的默认策略把 `notIndexed` 与 `unverified` 判为 `warn`（`verify.ts:55-60`），warn 不产生 `blocked`，因此不满足「阻断」但满足「跑过」。真正重读制品文本的 `BLOCKING` 判定只在 `citation-gate.ts:37`，且只被 render 路径调用。
- 影响：申请文件 `draft` 里若出现伪造或索引未收录的法条引用，交付门禁不会阻断——只要同一会话里另有一次能识别到引用的 `law_verify`。申请文件是直接递交 CNIPA 的成品，错误引用属于对外可见的业务结论错误。
- 最小修复建议：在 preset 的 `citationGate` 增加 `tool: build_patent_filing`、`textArgs: [draft]`；`structuralGateText` 的 `collectText` 已能递归草案对象，不需要改代码。
- 预估工作量：S
- 是否可自动化：是（preset 断言 + 一条含伪造引用的构建用例）
- 状态：confirmed

### F-PAT-018 后台运行接受模型自报的 `approveStageIds`，HITL 审批可绕过

- 位置：`packages/patent/patent-tools/src/tool/patent-workflow-run.ts:442`、`:446`；`packages/patent/patent-tools/README.zh.md:83`；`packages/bundle/web-app/presets/patent.patch.yml:301`
- 维度：A
- 严重度：High
- 可能性：中
- 证据：拒绝 `approveStageIds` 的条件是 `approveStageGates && !background && approveStageIds.length > 0`；错误文案自认「关闭 approveStageGates 或改用后台运行时才接受该参数」。README 同一句写「后台运行保持『暂停后由 approveStageIds 续跑』契约」。而 `TRANSITIONS.awaiting_approval` 允许直接迁移到 `executing`，`patent_plan_task` 的无状态 `transition` 也会把 `awaiting_approval → executing` 判为合法并返回 `ok: true`。
- 影响：模型可以选 `run_in_background: true`，在审批门暂停后用自己列的 `approveStageIds` 续跑，人类从未被询问。交付前置门禁只要求本会话成功跑过一次 `patent_workflow_run`，自批产生的收口记录同样满足证据要求，因此这条路径能一路走到交付。shipped preset 已开 `approveStageGates: true`，但后台分支把这道开关绕开了。
- 最小修复建议：后台运行同样拒绝 `approveStageIds`——到达审批门即暂停并让调用方在前台续跑；若必须支持后台续跑，把模型自报的列表换成由审批服务在回合内签发的一次性凭据，模型只转交不生成。
- 预估工作量：M
- 是否可自动化：是（后台 + approveStageIds 的用例应被拒绝；现有用例断言了相反行为，需要同步改）
- 状态：confirmed

### F-PAT-019 同一管线状态的文本读取有 4 份实现，键列表解析已漂移

- 位置：`packages/patent/patent-core/src/atoms/handlers/builtin/state-keys.ts:62`（`resolveKeyList`）、`:84`（`readStateText`）；`packages/patent/patent-tools/src/atoms/state-text.ts:22`（`readFirstStateText`）、`state-values.ts:17`（`firstStateString`）、`slop-gate.ts:50`（`resolveTextKeys`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`state-keys.ts` 的模块 JSDoc 自称「Semantics stay here so handlers that read the same pipeline state cannot drift」，但它未进入 `patent-core` 公开面，`patent-tools` 只能重写：`slop-gate.ts:50` 的 `resolveTextKeys` 与 `resolveKeyList` 结构一一对应，差异只在 `keys.push(item.trim())`（`state-keys.ts:73` 保持未 trim，同文件另有 `resolveTrimmedKey:47`，说明「是否 trim」在 core 里是显式选择）；同类读取器 `readFirstStateText` 遇非字符串立即返回 error，`firstStateString` 丢弃非字符串返回空串，`readStateText` 则把 `string[]` 按键内换行连接——三者读的是同一批键（`claims_draft`、`specification`、`source_text`）。另 `readStateText` 的 `string[]` 分支当前没有写入方：`draft.ts:477` 等只写字符串，`grep -nE "(source_text|specification|claims_draft|claim_strategy)\s*[:=]\s*\["` 在 patent 三包内无命中，`patent-core/tests` 也没有覆盖该分支的用例。
- 影响：新增原子或自定义灵活计划读同一键时，结论取决于选了哪个 helper——报错、空串或换行拼接；改一次语义要同步三到四处，已经漂移的 trim 规则说明同步没能发生。`readStateText` 的数组分支目前是无人写入的防御分支。
- 最小修复建议：把 `readStateText`/`resolveKeyList`/`resolveTrimmedKey` 从 `patent-core` 公开面导出（它们本就声明为状态读取的唯一语义家），`patent-tools` 改为导入；删除 `slop-gate.resolveTextKeys`（18 行）与 `firstStateString`（12 行），`state-text.ts` 缩为基于共享读取器的薄适配；`readStateText` 的数组分支二选一：补写入方与用例，或删除并同步 JSDoc。**假设**：仓外自定义原子可能向文本键写数组，删除前需确认。净减少：约 35–40 行，并消掉 trim 与数组两种语义分歧。
- 预估工作量：S
- 是否可自动化：部分（`typecheck` 加 `atoms` 既有用例回归；trim 语义需补一条「两键各带首尾空格」的用例）
- 状态：new

### F-PAT-020 权项号派生两包各一份，无编号时的缺省语义相反

- 位置：`packages/patent/patent-core/src/atoms/handlers/builtin/claim-breadth.ts:187`；`packages/patent/patent-tools/src/tool/amendment-reserve.ts:96`
- 维度：B
- 严重度：Low
- 可能性：中
- 证据：两处都先调共享的 `deriveClaimRefs`，再筛 `claimType === 'independent'`，差异全在缺省：`claim-breadth` 在 `refs.length === 0` 时返回 `[1]`（JSDoc「无编号时按第 1 项处理」），`amendment-reserve` 在 `refs.length === 0` 或没有独立权项时返回 `undefined`（JSDoc「原文没有行首编号…返回 undefined」）。同一份没有行首编号的权利要求书，一边按「只有权项 1」继续检查，另一边按「未知」跳过，两条 JSDoc 各自成立却互不引用。同批还有 `readClaimsText` 在 `adversary-model.ts:92` 与 `adversary-review.ts:81` 逐字相同的两份实现。
- 影响：起草早期用未编号权要跑 `claim-breadth` 与答复储备检查，会得到覆盖面不同却都自称成功的结果；改派生规则要改两处，漏一处就分叉。
- 最小修复建议：把缺省策略提升为共享函数的显式参数（如 `independentClaimNumbers(claims, { whenUnnumbered: 'claim1' | 'unknown' })`），或在两处 JSDoc 互指并说明为何不同；同批把两份 `readClaimsText` 收成一处共享导入。净减少：约 10 行，主要收益是缺省差异从注释里的默契变成签名里的选项。
- 预估工作量：S
- 是否可自动化：是（为两种缺省各补一条用例，先锁住既有行为再合并）
- 状态：new

### F-PAT-021 `workflow/types.ts` 两处 JSDoc 指向不存在的 `./workflow-store.js`

- 位置：`packages/patent/patent-core/src/workflow/types.ts:197`（`persist?: WorkflowRunStore`）、`:280`（`WorkflowRunStore` 声明）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`patent-core/src/workflow/` 只有 `budget.ts`、`consume-ref.ts`、`manifest.ts`、`revision-log.ts`、`signal.ts`、`stage-outputs.ts`、`types.ts`，没有 `workflow-store`；实现位于 `packages/patent/patent-workflow/src/workflow-store.ts`，类名是 `InMemoryWorkflowRunStore:232` 与 `JsonFileWorkflowRunStore:261`。`:197` 还引用了 `src/workflow WorkflowPlanStore`，那是移植来源 Sati 的路径，不是本仓路径。
- 影响：读者按相对路径找不到实现，也看不出执行器在另一个包；`patent-workflow` 依赖 `patent-core` 类型的这条依赖边只存在于代码里，文档侧没有任何指向。
- 最小修复建议：两处改为包名引用 `@deepseek-ai/dsh-patent-workflow` 的 `workflow-store.ts`（`InMemoryWorkflowRunStore`/`JsonFileWorkflowRunStore`），删掉指向 `src/workflow WorkflowPlanStore` 的移植来源路径。净减少：0 行代码，去掉 2 处失效引用。
- 预估工作量：S
- 是否可自动化：否（现有 doc 门禁不校验注释里的跨包相对路径；改完随 `pnpm run doc-sync` 复核）
- 状态：new

### F-PAT-022 `figure/` 几何与文本度量原语重复，`orientation` 同名异义

- 位置：`packages/patent/patent-tools/src/figure/leader-line.ts:176`（`orientation`）、`:181`（`onSegment`）、`:186`（`segmentsIntersect`）、`:231`（`polygonBBox`）；`render-check-findings.ts:200`（`orientation`）、`:211`（`polyBounds`）、`:310`（`onSegment`）、`:317`（`segmentsIntersect`）；`plot-diagram.ts:200` 与 `glyph-box.ts:78`（`textWidthMm`）；`mm-primitives.ts:47`（`boundsOfPoints`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`segmentsIntersect` 与 `onSegment` 在 `leader-line.ts`、`render-check-findings.ts` 各一份，算法相同（叉积符号加端点落段判定），只是前者用坐标参数、后者用 `Point`/`Segment`；包围盒三份：`boundsOfPoints` 与 `polyBounds` 只差类型名，`polygonBBox` 额外解析 `points` 属性；`textWidthMm` 两份且精度不同——`glyph-box` 版按实测墨迹比例分类累加并接收字号，`plot-diagram` 版是 CJK/ASCII 二值粗估、字号取自模块常量。同名异义最危险的是 `orientation`：`leader-line.ts:176` 返回有向面积，`render-check-findings.ts:200` 返回 0–180 的角度度数，两者都是 `number`，误调用不会被类型系统发现。
- 影响：修一处交线判定不会带动另一处；`orientation` 换个调用点就得到数量级不同的值而编译通过；重复实现没有交叉验证，`figure-mm-primitives.spec.ts` 只覆盖 `boundsOfPoints`，其余副本无对应用例。
- 最小修复建议：新建 `figure/geometry.ts` 集中 `sideOf`/`onSegment`/`segmentsIntersect`/`pointSegmentDistance`/`boundsOfPoints`，`leader-line.ts` 与 `render-check-findings.ts` 改为导入；`render-check-findings.ts:200` 的 `orientation` 改名 `segmentAngleDeg`；`plot-diagram.ts` 的 `textWidthMm` 改用 `glyph-box.textWidthMm(text, FONT_MM)`，删掉本地的两个比例常量。净减少：约 50 行（两份重复块约 24+35 行收成一份约 25 行，包围盒 2 份合 1，`textWidthMm` 与常量 −10 行），外加消除 1 处同名异义。
- 预估工作量：M
- 是否可自动化：是（`jscpd` 抓不到这类短函数——`.jscpd.json` 的 60 token 阈值高于它们；靠 `figure/` 既有用例，并为 `geometry.ts` 补单测）
- 状态：new

### F-PAT-023 `freecad-structure-script.ts` 1233 行里 940 行是内嵌 Python

- 位置：`packages/patent/patent-tools/src/figure/freecad-structure-script.ts:294`（`PYTHON_TEMPLATE` 起始）至文件末
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：文件共 1233 行，TS 部分 293 行，其余 940 行是 `String.raw` 模板内的 FreeCAD 脚本（第 294–1233 行，文件以模板闭合收尾）。同文件 `JSON.stringify(JSON.stringify(payload))` 的双重序列化有注释说明必要（内层给 `json.loads`，外层转 Python 字符串字面量），不计入本条。仓内已有 `.py` 资产先例：`patent-filing/assets/engine/{build,style,render_figures,verify}.py`、`patent-tools/tests/fixtures/generate-*-fixture.py`。
- 影响：这是两包最大的单文件，但 76% 的内容不是 TypeScript——行数热点、评审视线与 TS 侧门禁都被稀释；内嵌 Python 没有语法检查与高亮/缩进保护，改动只能靠真实 FreeCAD 渲染才发现缩进错。
- 最小修复建议：模板移为 `src/figure/freecad-structure-script.py`，运行时读入后做 `replace('__PAYLOAD_LITERAL__', …)`，读取路径沿用仓内资产的打包/ASAR 双候选写法。**假设**：`build:artifacts` 会把该 `.py` 带进发布产物，迁移前需用 `ELECTRON_RUN_AS_NODE` 探针确认 asar 内可见；若不带，退回生成期内联。净减少：TS 文件从 1233 行降到约 300 行，Python 侧获得独立的语法检查位。
- 预估工作量：M
- 是否可自动化：是（`build:check` 加 `figure-freecad-real-render.spec.ts` 的 CAD lane 回归）
- 状态：new

### F-PAT-024 插件默认值两份来源：七个专利包 42 对 `??` 重述、2 处同义重述、1 处第三种缺省

- 位置：七个包的插件入口。`packages/patent/patent-teams/src/index.ts:87`–`97` 对 `:116`–`152`；`patent-rule/src/index.ts:310`–`335` 对 `:437`–`503`；`patent-data/src/index.ts:200`–`214` 对 `:230`–`333`；`patent-filing/src/index.ts:61`–`63` 对 `:80`–`84`；`writing-patterns/src/index.ts:98`–`101` 对 `:200`–`209`；`patent-knowledge/src/index.ts:117`–`119` 对 `src/config.ts:29`–`30` 与 `src/index.ts:137`；`patent-document/src/index.ts:41`–`42` 对 `:55` 与 `src/document/renderPatentDocument.ts:26`、`:232`
- 维度：B
- 严重度：Medium
- 可能性：高
- 证据：每个字段的缺省值写了两遍——schemastery 的 `.default(...)` 一次，`apply()` 或 `resolve*()` 里的 `?? 同值字面量` 再一次。逐包复核：

| 包 | schema `.default` | 消费侧重述 | 备注 |
|---|---|---|---|
| `patent-teams` | 10 | 10 对 `??` | 含 `DEFAULT_MAILBOX_DELIVERY_LEASE_MS` 同一常量写两次 |
| `patent-rule` | 9（其中 2 个是数组元素内的嵌套字段，无 `??`） | 6 对 `??` + 1 处 `approvalDisabled === true` | 顶层 7 个字段全部重述 |
| `patent-data` | 15 | 15 对 `??` | 全为 `DEFAULT_*` 常量，`positiveInteger(...)` 包装后仍是同值 |
| `patent-filing` | 3 | 3 对 `??` | `templatePath`/`specPath` 只有 `defaultTemplatePath()` 一处来源，不重复 |
| `writing-patterns` | 4 | 3 对 `??` + 1 处 `registerSection === false` | 布尔缺省以取反形式重述；`stagePatterns` 无 schema 缺省 |
| `patent-knowledge` | 3 | 3 对 `??` | `knowledgeDir`/`sourceDbPath` 的 `??` 在 `resolveKnowledgePaths` 内，供无 Loader 的 `{}` 调用兜底 |
| `patent-document` | 2 | 1 对 `??` + 1 处跨文件字面量 | `.dsh/documents` 在入口与 `renderPatentDocument.ts:26` 各写一次，`:232` 是第三种缺省 |

D14 只覆盖 `patent-teams` 与 `patent-rule`，并把后者记为「7 处」；D15 逐行复核为 6 对 `??` + 1 处同义重述，并把范围扩到剩余五包，合计 42 对 `??`、2 处同义重述、1 处第三种缺省。同域第六个包 `patent-workflow` 已是单源写法：`src/index.ts:61` 只有 `z.natural()`，缺省值在 `resolveWorkflowConfig`（`:69`）落定一次，JSDoc 明写「缺省值不在这里落定」与「把缺省值落定一次」。这是 F-DOC-004 的同一根因在专利域复现，且同域已有正确模板。
- 影响：改 schema 默认值不影响消费侧的 `??` 分支，反之亦然；`cordis.yml` 省略字段时，Loader 展示的配置与运行时值可能分叉，新增字段只补一处即静默漂移。`patent-teams` 另有一层错位：`service.ts:83` 的 `PatentTeamsConfig` 是「已解析」类型，但 `apply()` 构造的解析结果只覆盖 11 个字段中的 8 个，`promptSectionOrder`、`approveCreation`、`approveClosure` 仍从原始 `config` 读——类型上看不出哪些字段已解析。
- 最小修复建议：二选一，唯一要求是每个字段的默认值只有一处。(a) 套用 F-DOC-004 已落地的修法：`Config` 接口字段改必填 + `z<Partial<Config>, Config>`，删掉 `apply()` 里的 `??`；(b) 反向对齐 `patent-workflow`：schema 只校验、不写 `.default`，由显式 `resolveXxxConfig(config)` 落缺省。`patent-knowledge` 与 `patent-document` 的 `??` 兼作库级兜底（调用方可以完全不给 `config`），改为必填时需保留一条「无 Loader 调用」的入口，否则 standalone 用法断掉。两者都是对外可见的 `Config` 类型变化，需按 `dsh-create-upgrade-guide` 记录。净减少：42 行重复默认 + 2 处同义判定 + 1 处第三种缺省消失，且「半解析配置」状态随之消失；上表可直接作为按包勾选的修改清单。
- 预估工作量：M（七个包，逐包同形改法）
- 是否可自动化：部分（可加一条门禁：同包内同一字段同时出现 schema `.default` 与 `config.X ?? 默认值` 即报错）
- 状态：new

### F-PAT-025 规则资产 YAML 失败处理惯用法重复 5 处，顶层对象校验两种写法

- 位置：`packages/patent/patent-rule/src/runtime/RuleLoader.ts:543`、`runtime/rule-pack.ts:67` 与 `:152`、`runtime/patent-compliance.ts:258`、`runtime/synonym-engine.ts:144`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：5 处都是 `parseDocument(text)` → `if (doc.errors.length > 0)` → `doc.errors[0]?.message ?? 'unknown'` 再带一行 `/* v8 ignore next */` 注释，只是出口不同（返回 issues、抛错、push warnings 后 `continue`）。顶层必须是对象的校验有两种写法：`asRecord(doc.toJS())`（RuleLoader:549、patent-compliance:263）与手写的 `typeof root !== 'object' || root === null || Array.isArray(root)`（rule-pack:70–73、synonym-engine:148–150），后者在 `asRecord`（来自 `@deepseek-ai/dsh-value`，经 RuleLoader:57 再导出）可用的情况下重复了同一判定。规则的目录解析与合并本身没有重复：候选目录集中在 `asset-location.ts:44` 的 `candidateRuleDirs`，装配走 `RuleLoader.loadRuleSetDir` + `mergeRuleSets`，`patent-compliance` 的 `parseActivationPatch` 与 `applyActivationPatch` 是解析与施加的互补分工。
- 影响：YAML 失败文案分散在四个文件，改一处不会传播；两种顶层判定一旦 `asRecord` 的语义调整（例如放行数组），手写的两处不会跟着变，同一份资产在不同加载器里得到不同结论。5 行内容相同的 `v8 ignore` 注释也各自独立失效。
- 最小修复建议：新增 `runtime/yaml-asset.ts`，导出 `parseYamlRecord(text, source): { record: Record<string, unknown> } | { error: string }`（内部用 `asRecord`），四处只保留各自的出口映射。净减少：约 5–8 行，`v8 ignore` 从 4 处并为 1 处，顶层对象守卫只剩一份。
- 预估工作量：S
- 是否可自动化：是（现有 `RuleLoader`、`rule-pack`、`patent-compliance` 的单测覆盖四个出口）
- 状态：new

### F-PAT-026 `patent-teams` 内部 5 处结构克隆，事件载荷与邮箱结算各有两个编码

- 位置：`packages/patent/patent-teams/src/service.ts:398`、`:402`、`:418`、`:424`；`src/task-ops.ts:374`、`:478`、`:597`；`src/tools.ts:49`/`:105`（任务行 `deps`/`output` 片段）、`:300`–`311`/`:338`–`347`（输出 schema 字段表）、`:315`/`:351`（render 文案）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`jscpd` 降到 40 token / 4 行在该包得到 5 组共 27 行克隆（默认 60/6 阈值下为 0）。人工补充两处语义分叉：① 4 次 `withMailboxLease` 里「确认还是释放」的判定有两种编码——队长分支按 `delivered === 'live'` 决定 ack/release，成员分支按 `accepted` ack、再按 `delivered === 'mailbox'` release；② 3 处 `patent-teams/task-updated` 载荷里，`task-ops.ts:374` 直接传 `agent.session`，`:478` 与 `:597` 走 `captainSessionOf(host.ctx, SessionId(fresh.captainSessionId), agent.session)`，调用方不同因此结果不同，但同一段解析写了两次。检查项 ③ 的其余部分不重复：`state.ts:38` 的 `unsatisfiedDependencies` 是唯一的就绪判定来源，`scheduler.ts:144` 的 `nextReadyTask` 与 `task-ops.ts:463` 都复用它，没有第二份任务板查询。
- 影响：改事件载荷口径（例如 `attempt` 字段）要同时改 3 处，漏一处就出现同一事件两种字段集；ack/release 两种判定若再各自演化，会出现「投递成功但邮箱未确认」或「未投递却已确认」的分叉，且只在消息投递路径上暴露。
- 最小修复建议：`emitTaskUpdated(host, fresh, task, sessionId, extra)`（sessionId 由调用方给，保留队长/成员差异在调用点可见）、`settleMailboxDelivery(stateRoot, teamId, holder, key, delivered, ids)`（内部按 `delivered` 做 ack/release 二选一）、`renderTaskLine(task)` 共享 `deps`/`output` 截断片段。`tools.ts:300`–`311`/`:338`–`347` 的输出 schema 字段表与 `:315`/`:351` 的 render 文案建议保持显式——它们对应两个不同工具的对外输出契约，抽公共片段会让契约变得需要跳读。净减少：约 18–22 行，事件载荷与结算语义由 3 处 + 2 处降到各 1 处。
- 预估工作量：S
- 是否可自动化：部分（`jscpd` 降阈可复现 5 组克隆；语义分叉需人工判断）
- 状态：new

### F-PAT-027 子进程超时/取消骨架 4 份，已抽好的 `subprocess-render` 未被其余 3 处复用

- 位置：`packages/patent/patent-tools/src/figure/subprocess-render.ts:22`–`43`（`startRenderDeadline`，已抽成可复用 helper，被 graphviz/inkscape/freecad 三个渲染器共用）；`patent-data/src/subprocess-runner.ts:55`–`68`；`patent-document/src/document/pdfRenderer.ts:100`–`110`；`patent-filing/src/filing/engine.ts:187`–`196`
- 维度：B
- 严重度：Medium
- 可能性：高
- 证据：四处都是同一段 8–10 行骨架——`new AbortController()`、`setTimeout(() => controller.abort())`、`timer.unref()`、`signal.addEventListener('abort', …, { once: true })`、`if (signal.aborted === true) controller.abort()`、`spawn({ …, signal: controller.signal })`、`await handle.done`、`finally { clearTimeout; removeEventListener }`；另外三处各自的收尾还有 `GRACE_MS = 3_000`、`MAX_OUTPUT_BYTES` 常量与「被信号 …/退出码 …」文案。差别只在选项对象与错误映射：`subprocess-runner` 与 `subprocess-render` 用 `timedOut = true` 记录超时，`pdfRenderer` 与 `engine.ts` 不记录，超时只能以 `被信号 SIGTERM 终止` 的形式出现，与外部取消、被杀无法区分；只有 `engine.ts:185` 有起进程前的 `signal.aborted` 领域错误（注释写明「已取消的调用不起进程」），`pdfRenderer` 无此判断，已取消时仍会 spawn Chrome 再由信号结束。`patent-tools` 那一份证明这套骨架可以抽成纯 helper（只依赖 `AbortSignal`/`AbortController`，不需要 subprocess 类型）。
- 影响：四种失败语义（超时、调用方取消、外部信号、非零退出）里有两处只能报出三种；`pdfRenderer` 的取消路径多起一个浏览器进程。骨架再演化（例如加 `timedOut`、加优雅期）要改四处，漏一处就出现同一 seam 上两种取消行为。
- 最小修复建议：把 `subprocess-render.ts` 的 `startRenderDeadline`（含 `timedOut()` 与 `dispose()`）移到 `patent-core/src/subprocess/deadline.ts`——它是纯 helper，不引入 `@deepseek-ai/dsh-subprocess` 依赖，符合 H01 已确认的 core 边界；`subprocess-render.ts` 改为从 core 导入。其余三处替换骨架并保留各自的 `spawn` 选项与错误类型（`DocumentRenderResult` 的错误串、`PatentFilingError`、`EgoSpawnResult`），同时让两处补上超时与取消的区分。净减少：约 −40~−45 行（骨架四份降为一份 + 三处各删 12–18 行），并把「超时/取消/信号/退出码」四种语义收敛为同一处判定。
- 预估工作量：M（四处调用点，三种错误类型各自保留）
- 是否可自动化：部分（`jscpd` 在默认阈值下抓不到，需降阈或按符号名比对）
- 状态：new

### F-PAT-028 输出目录与安全文件名判定 4 种编码，中文案卷号在两个工具间接受集相反

- 位置：`packages/patent/patent-document/src/document/renderPatentDocument.ts:33`–`39`（`SAFE_NAME_CHARS` 与两个逐字相同的 `SAFE_NAME_PATTERN`/`SAFE_CASE_ID_PATTERN`）、`:84`–`93`（`resolveOutputDir`）；`patent-filing/src/filing/engine.ts:100`–`113`（`assertSafeOutputName`，blocklist）、`:129`–`141`（`resolveOutputDir`，与 document 逐字相同）、`:136`（`assertSafeId`）；`patent-core/src/persist-utils.ts:59`（`SAFE_ID_PATTERN`，ASCII allowlist）、`:66`（`assertSafeId`）、`:84`（`assertSafePathSegment`，blocklist 且 JSDoc 明写允许中文案卷号）
- 维度：B
- 严重度：Medium
- 可能性：高
- 证据：同一个判定写了 4 种编码，接受集互不相同：

| 位置 | 判定 | 中文 | 内部空格 | 圈码 `①` |
|---|---|---|---|---|
| `renderPatentDocument` 的 `caseId`/`outputName` | 字符集 allowlist | 接受 | 拒绝 | 接受 |
| `buildFiling` 的 `outputName` | 黑名单（`..`/分隔符/控制字符/首尾空白） | 接受 | 接受 | 接受 |
| `buildFiling` 的 `caseId`（`assertSafeId`） | ASCII allowlist | **拒绝** | 拒绝 | **拒绝** |
| `patent-core` 的 `assertSafePathSegment` | 黑名单 | 接受 | 拒绝（首尾） | 接受 |

两个工具落在同一棵目录树：`caseOutputsDir(caseId)` → `data/cases/<caseId>/outputs/`，两个工具的 `caseId` schema 都只是 `type: 'string'`（`build-patent-filing.ts:96`、`render-patent-document.ts:113`），校验只在运行时发生。因此同一份工作里先 `render_patent_document` 再 `build_patent_filing`、`caseId` 写作「2024-001号」时，前者成功、后者抛 `RangeError: Invalid 案卷号 … only [A-Za-z0-9._-] allowed`。`document` 里的两个正则还是逐字相同的两份（同一字符集、同一量词、同一 `..` 前瞻）。两份 `resolveOutputDir` 只在错误类型上不同。
- 影响：模型与用户只能从失败信息反推「哪个工具接受什么名字」，而两个工具对同一概念给出相反答案；`patent-core` 的 JSDoc 已经写明「案卷号常写作 `CN2024-0001` 或中文案卷名」，说明中文案卷号是被支持的用法，`buildFiling` 的拒绝与这条声明冲突。将来给字符集补一个字符（例如 `②` 之外的圈码）要改四处，漏一处就分叉。
- 最小修复建议：在 `patent-core` 立一个 `safe-path.ts`，只保留两个具名判定——`assertPathSegment`（路径段：允许非 ASCII，拒空、`.`/`..`、分隔符、NUL、首尾空白与尾点，即现有 `assertSafePathSegment`）与 `assertDeliverableName`（交付文件名：在路径段之上再加允许字符集、长度与 `..` 排除）。`document` 与 `filing` 各自保留一层薄包装把错误映射成 `DocumentRenderError`/`PatentFilingError`，`filing` 的 `caseId` 改用 `assertPathSegment` 与 `document` 对齐；`resolveOutputDir` 只留 document 一份，filing 注入错误构造。接受集的取舍需要一次确认：案卷号到底允不允许空格（当前三处拒绝、一处接受），建议统一为拒绝并在工具描述里写明。净减少：约 −15~−20 行，接受集由 4 种降为 2 种（路径段 / 交付文件名）。
- 预估工作量：M（改接受集是对外可见行为变化，需 `dsh-create-upgrade-guide` 记录并补两侧一致性用例）
- 是否可自动化：部分（可加门禁：同一概念的安全名判定只允许出现在 `patent-core`）
- 状态：new

### F-PAT-029 `escapeRegExp` 专利域内 4 份命名封装 + 6 处内联，仓内无共享实现

- 位置：命名封装 `patent-core/src/atoms/handlers/builtin/claim-strategy.ts:222`、`patent-document/src/document/documentCompliance.ts:218`、`patent-document/src/document/paragraphNumbering.ts:60`、`patent-document/src/document/draftConverter/templateDraft.ts:20`（`slotPattern`）；内联单用 `patent-core/src/evidence/public-use.ts:60`、`patent-core/src/notice/grounds.ts:282`、`patent-document/src/document/draftConverter/genericDraft.ts:21`、`patent-law/src/reference.ts:66`、`patent-tools/src/tool/spec-blocks.ts:131`、`patent-tools/src/tool/spec-software.ts:300`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：10 处都是 `replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`，字符集逐字相同；`git grep 'export function escapeRegExp'` 全仓 0 命中，说明没有可复用的既有实现。三份封装加 `slotPattern` 的差别只有参数名与 JSDoc。
- 影响：正则转义字符集是安全相关的常量（漏转义 `{`/`}` 会让量词失效、漏转义 `\` 会让后续字符被解释）。现在修改它需要改 10 处，而其中 4 处封装的意义正是「只改一处」。
- 最小修复建议：在 `@deepseek-ai/dsh-value`（`patent-core` 已依赖）导出 `escapeRegExp(text: string): string`，4 个封装改为直接调用或删除封装让调用点导入；6 处内联一并换掉。净减少：约 −5~−8 行（封装体 3 行降为 1 行调用，扣除新增 import 与共享实现），主要收益是字符集单一来源。
- 预估工作量：S
- 是否可自动化：是（按正则字面量做仓级重复检测）
- 状态：new

### F-PAT-030 `patent-kg-adapter` 邻居扩展循环 3 份，两个检索引擎 `backfillContent` 近克隆

- 位置：`packages/patent/patent-knowledge/src/patent/patent-kg-adapter.ts:94`–`99`、`:103`–`108`、`:126`–`131`；`src/case-law/case-law-search.ts:344`–`350` 与 `src/legal/knowledge-law-search.ts:370`–`377`（`backfillContent`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`jscpd` 降到 40 token / 4 行后在该包命中两组邻居循环配对（`patent-kg-adapter.ts:94` ↔ `:103`、`:94` ↔ `:126`），三个调用点（similar、cites、`getSimilarNodes`）都是「按 `node_id` 查邻居行 → 拼 `{ id, type, label }` → 去重」的 5 行。`backfillContent` 两份未到 jscpd 阈值，逐行人工比对为近克隆：骨架相同，只差结果字段名（`bm25` 与 `rank`）、语句顺序与空内容分支的写法。
- 影响：邻居行的组装口径（取哪个字段当 `label`、按什么去重）写成三份，新增第四种邻居关系时会再写一份；`backfillContent` 的「空内容」策略若只改一侧，两条检索路径对同一文档给出不同的可展示性。
- 最小修复建议：抽 `expandNeighbors(db, ids, edgeKind): KgNeighbor[]` 供三处调用；`backfillContent` 抽到 `shared/`，把结果字段名作为参数（或让两侧共用同一字段名）。**不合并**两侧的 `dedupeByDocument`——`case-law-search.ts:415`–`428` 先取最小 `bm25` 再排序，`knowledge-law-search.ts:435`–`445` 保序截断，语义不同，合并会改变排序语义。净减少：约 −20~−25 行，邻居组装与内容回填各降到 1 处。
- 预估工作量：S
- 是否可自动化：部分（`jscpd` 降阈可复现，语义差异需人工判断）
- 状态：new

### F-PAT-031 `templateDraft` 的 `openEnd` 是死字段，两处用 `indexOf` 重新定位已命中位置

- 位置：`packages/patent/patent-document/src/document/draftConverter/templateDraft.ts:33`–`35`（字段声明与 JSDoc）、`:52`、`:59`；`:123`、`:168`（`html.indexOf(hit.openTag)`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`git grep -n 'openEnd'` 在该文件内只有声明、赋值与 JSDoc 三处，没有任何读取；实际使用的是同值的 `contentStart`（`:118`、`:155`）。`SlotElementHit.start` 已是开标签起始下标（`:79` 就在用），而 `:123` 与 `:168` 仍对整段 `html` 调 `indexOf(openTag)` 重新扫描一遍。`:128` 的 `result.indexOf(extra.openTag)` 作用于已被修改的字符串，必须保留。
- 影响：死字段让「`openEnd` 与 `contentStart` 有什么区别」成为读者必须回答的问题，而答案是「没有」；两处重新扫描是多一次 O(n) 且在理论上可能命中更早的同名标签（当前模板每槽位只出现一次，因此只是冗余，不是缺陷）。
- 最小修复建议：删除 `openEnd` 字段与其 JSDoc；`:123`、`:168` 改用 `hit.start`/`first.start`。净减少：−3 行，去掉 2 处全串重扫。
- 预估工作量：S
- 是否可自动化：是（未读取字段可由类型检查或 lint 发现）
- 状态：new

### Day 10 定向结论：法律域与共享层无安全发现

- **SQL 全部参数化**：`MATCH ?` 与 `LIKE ?` 绑定，`likePattern` 转义 `%`、`_`、反斜杠并配合 `ESCAPE '\'`；唯一的表名插值取自包内固定数组；安装 API 的源库与输出目录来自 options/CLI，不注册为工具。
- **索引与策略来自部署**：`baselineDir` 与五个引用策略只由 `Config` 提供；shipped legal preset 把 `mismatch`、`unverified`、`notIndexed` 全部设为 `block`。
- **证据评分不收回合策略**：`evaluate_legal_evidence` 只收证据属性，没有策略、权重或"跳过"入参；规则资产缺失时插件在加载期失败。
- **共享层不放大风险**：两域共用同一份 FTS/LIKE 转义与阶梯实现；当前实现正确，未发现单域特化分支。

### Day 9 定向结论：文档域无安全发现

- **office-kit**：每次转换一个 `mkdtemp` 私有目录，输入以 `wx` + `0o600` 写入，`finally` 递归删除；启动清扫按名字正则、真实目录、mtime 截止过滤并跳过链接。本包不拼 argv，LibreOffice 调用在 `@deepseek-ai/libreoffice-kit` 内，入口由使用方的 `import.meta.resolve` 解析。
- **docx-kit**：`readZip` 限条目数与非压缩总字节；entry 名只解码、不当文件路径，包内也没有按键名落盘的 API，因此 ZIP 穿越当前不可达。`readZip` 经 `./src/*` 子路径可达，将来加解压能力时需自带名字校验。
- **doc-template**：模板 id 按 manifest 白名单校验；HTML 变量经 `escapeVariables`，链接与图片经 `isDeliverableUrl` 拒绝 `javascript:`、`data:`、`vbscript:` 与协议相对地址；`output_path` 经 `ctx.fs` 写入，受部署文件策略约束。

### Day 8 定向结论：已处理的身份与注入面

- **审批失败方向（前台）**：`LiveApprovalGateHandler` 只在 `allowed-once` 时放行；拒绝、取消、审批服务缺失、`never` 策略或异常一律暂停并带结果名（`approval-gate.ts:107`）。开启后 `approveStageIds` 被拒绝，模型无法自批。
- **团队身份**：`patent_teams_send_message` 的 `from` 只能是调用者自己的身份，传别人会抛错（`service.ts:369-371`）；移除成员等 captain-only 操作走 `captainTeam`/`freshCaptainTeam` 校验；成员更新任务必须携带当前 `attempt_id`，接管或重派后旧 attempt 失效。
- **模板注入**：模板 id 先按 `manifest.json` 的 `templates` 白名单校验再拼路径，未知 id 直接抛错；草案文本（文本槽位、blocks、rows、表格单元格、理由节）统一经 `escapeHtmlText` 转义，标题与表格结构由转换器独占生成。
- **输出路径**：`outputName` 走 `SAFE_NAME_PATTERN`；`outputDir` 与 `brandPath` 走 `resolveConfinedPath`；`build_patent_filing` 的 `outputDir` 同样按工作目录包含性校验。

### Day 7 定向结论：已处理的外部输入与收敛的失败方向

- **SQL/FTS 参数化**：`MATCH ?` 与 `LIKE ?` 全部走绑定；多词 LIKE 的 OR 子句按词数生成占位符，值经 `likePattern` 转义 `%`、`_`、`\`；`doc_type IN (...)` 的取值先按闭集常量校验再拼入，注释也写明只接受类型值。
- **表名与列名插值**：`pragma_table_info('${table}')` 的 `table` 注释明确「仅包内字面量」，调用点也确实只有字面量；`ALTER TABLE ... ADD COLUMN` 的列名与类型来自包内常量数组；`VACUUM INTO '${path}'` 经 `sqlQuote` 转义单引号。
- **资产路径**：`rulesDir`、`baselineDir`、费用表目录都只来自部署 `Config`；这四个包的模型可见工具没有任何路径参数，输入无法影响资产位置。
- **费用失败方向**：`patent-fees` 的 `failOnUnverified` 默认 `true`，未核验时不给合计。
- **渲染路径的引用门禁是 fail-closed**：`citation-gate.ts:37` 的 `BLOCKING` 含 `not-indexed`、`unverified`、`out-of-range`、`mismatch`，比 `law_verify` 工具的默认策略更严——工具负责让模型看见缺口，门禁负责不让它落盘。缺口只在立案构建路径（F-PAT-017）。

### Day 6 定向结论：已处理的外部输入

以下为复核后确认**没有**发现问题的部分，记录以免后续重复怀疑：

- CNIPR 三个脚本的参数（`numbers`、`query`、`pages`、预算数值）全部经 `JSON.stringify` 嵌入脚本体，脚本走 stdin 而不是 shell；`page.fill` 不解释内容。
- ego-browser 与渲染子进程的 `argv` 全是数组，没有字符串拼接的 shell 调用。
- CNIPR 直链模式锁定 `pic\.cnipr\.com/pdfcn/…\.PDF` 并强制补齐 `http://`；Google Patents 侧的选择器锁定 `patentimages.storage.googleapis.com`，`Network.responseReceived` 还要求 `response.url === pdfUrl`。
- `normalizePatentNumber` 会剥离 `/`、`:`、空白与连字符，`validatePatents` 另行拒绝 `\` 与 `..`，落盘文件名无法穿越目录。
- FreeCAD 的 Python 脚本载荷经双重 `JSON.stringify` 注入，字符串转义规则与 Python 字面量一致；子进程用最小环境。

## 文档模式

### F-DOC-001 DOCX 渲染的 Markdown 解析无围栏代码块分支

- 位置：`packages/document/docx-kit/src/markdown.ts:123`
- 维度：E
- 严重度：High
- 可能性：高
- 证据：`parseMarkdown` 逐行分派到表格（`|` 开头）、标题（`#` 开头）、列表与段落，全文无围栏状态；`grep fence` 无命中。对照 `document-deliver/src/checks.ts:238` 已有 `fenceRanges`。
- 影响：模板正文或渲染源含代码块时，围栏内的 `#` 行被提升为标题、`|` 行被拼成表格，交付的 DOCX 内容与源文本不一致；这是静默内容篡改，审阅者难以发现。
- 最小修复建议：加入围栏状态机（进入/退出 ` ``` `/`~~~`），围栏内一律按代码段落处理；或复用 `checks.ts` 的结构扫描器保持两侧一致。
- 预估工作量：M
- 是否可自动化：是（补 fence 用例）
- 状态：confirmed

### F-DOC-002 `document_deliver` 把取消与编程错误都报为"不可读"

- 位置：`packages/document/document-deliver/src/tool.ts:373`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`catch` 只区分 `FS_TOO_LARGE`，其余一律 `status: 'unreadable'`；无 `signal.throwIfAborted()`。`checkDeliverables` 的逐文件循环同样不检查中止。
- 影响：用户取消后模型收到"文件不可读"的假结论，并继续读后续文件；把取消误报成内容问题会误导后续修复动作。
- 最小修复建议：`catch` 首行 `exec.signal.throwIfAborted()`；循环每轮检查中止信号。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-DOC-003 OOXML 读取限额两包各写一份字面量

- 位置：`packages/document/office-kit/src/index.ts:106`、`packages/document/document-deliver/src/index.ts:67`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`office-kit` 内联 `.default(10_000)` 与 `.default(250 * 1024 * 1024)`；`document-deliver` 导出同名常量，两处仅靠注释互指，无 import 关系。
- 影响：一侧调整预算后另一侧静默漂移，同一份 DOCX 可能在转换侧通过、交付检查侧被判超限。
- 最小修复建议：由 `docx-kit` 导出默认 `ZipReadLimits`，两包引用同一常量。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-DOC-004 插件默认值出现两个来源（schema default 与 `??`）

- 位置：`packages/document/document-deliver/src/index.ts:107`、`packages/document/doc-template/src/index.ts:129`
- 维度：B
- 严重度：Medium
- 可能性：中
- 证据：`document-deliver` 的 schema 已 `.default(DEFAULT_MAX_ARCHIVE_ENTRIES)`，`apply` 里又写 `config.maxArchiveEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES`；`doc-template` 用 `z<Config>`（字段可选）+ `??` 在 `apply` 补默认。`office-kit` 与 `tool-office` 则是 `z<Partial<Config>, Config>` 且不写 `??`。
- 影响：四个文档包两种写法；改 schema 默认不会影响 `??` 分支，新增字段容易只补一处，Loader 显示值与运行时值分叉。
- 最小修复建议：统一为 `z<Partial<Config>, Config>`（schema 是唯一默认源），删掉 `apply` 里的 `??`。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-DOC-005 `tool-office` 用 9 处 `as` 断言担保跨模块不变量

- 位置：`packages/document/tool-office/src/index.ts:328`
- 维度：B
- 严重度：Low
- 可能性：低
- 证据：`grep -c ' as [A-Z]'` 得 9 处，如 `refs[index] as ImageAttachmentRef`；每处都有注释说明前置校验。
- 影响：上游类型改动时编译器不报错，失配在运行期变成 `TypeError` 而非可读的工具失败。
- 最小修复建议：改为窄化 helper（返回 `T | undefined`）或显式 guard，断言处改为抛 `HarnessError`。
- 预估工作量：M
- 是否可自动化：部分
- 状态：confirmed

### F-DOC-006 跨模块请求类型按字段重写而非组合

- 位置：`packages/document/doc-template/src/store.ts:73`（`RenderRequest`）与 `packages/document/doc-template/src/tool/render-doc-template.ts:27`（`RenderDocTemplateInput`）；`packages/document/office-kit/src/queue.ts:11`（`OfficeOperation`，`images` 成员起于 `:14`）与 `packages/document/office-kit/src/types.ts:57`（`OfficeImagesRequest`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`npx jscpd packages/document/*/src --min-tokens 40 --min-lines 4` 在 42 个文件、8712 行里得 2 组克隆、22 行（0.25%），恰好就是这两对（15 行/42 token 与 9 行/40 token）；默认阈值 60 token / 6 行下为 0 组，所以仓库的 `duplication` 门禁看不到。逐字段比对：`RenderDocTemplateInput` 的 8 个字段中 7 个（`template`、`variables`、`format`、`title`、`author`、`date`、`filename`）与 `RenderRequest` 逐字相同，连 JSDoc 与可选性都一致，只多 `outputPath`；`OfficeOperation` 的 `images` 成员 8 个字段与 `OfficeImagesRequest` 去掉 `extension`、`source` 后逐字相同——`extension`/`source` 属准入输入而不是操作身份，因此差异是设计上应保留的。
- 影响：两对都是「内层 type 改了、外层没跟」的静默漂移点。`RenderDocTemplateInput` 是模型可见的工具入参，漂移后模型能传的字段与渲染器读取的字段不一致，且没有任何门禁会发现——jscpd 默认阈值看不到 15 行以下的重复，类型上两者互不引用。`OfficeOperation` 的 JSON 形态是缓存键（`queue.ts:9` 注释明写「its JSON form distinguishes cached outputs」），字段集漂移会静默改变缓存命中率。
- 最小修复建议：`render-doc-template.ts` 改为 `export interface RenderDocTemplateInput extends RenderRequest { readonly outputPath?: string }`；`queue.ts` 增加 `type OfficeImageOptions = Omit<OfficeImagesRequest, 'extension' | 'source'>`，`images` 成员写 `{ readonly kind: 'images' } & OfficeImageOptions`。两者字段集合不变，`OfficeOperation` 的缓存键不变；`readonly` 与 `exactOptionalPropertyTypes` 语义在 `extends` 与 `Omit` 下都保留。这是 F-VID-006（`StrictRequest` 与 `MediaTaskRequest` 字段全同）的同一根因，三条可一次改完。
- 净减少：约 −30 行——两处共 15 个重复字段的声明与其 JSDoc 只留一份，换成 4 行组合声明。
- 预估工作量：S
- 是否可自动化：部分。默认阈值的 `duplication` 门禁抓不到；可把文档域加入 40/4 的诊断清单，或在 `tests/` 里加一条「工具入参字段是 `RenderRequest` 的超集」的类型级断言（`type Assert<T extends RenderRequest> = T`）。
- 状态：confirmed

## 法律模式

### F-LEG-001 `legal-law` 名字表是模块级只增状态，加载不复位

- 位置：`packages/legal/legal-law/src/baseline.ts:58`、`:354`、`:371`
- 维度：E
- 严重度：High
- 可能性：中
- 证据：`_knownNames`（`Set`）与 `_knownAliases`（`Map`）声明在模块顶层；`registerManifestNames` 与 `registerBaseline` 只 `add`/`set`，`finalizeStatutePattern()` 用累积集合重建正则；无 `reset`/`clear`，测试也未 `vi.resetModules()`。
- 影响：同进程内先加载自定义 `baselineDir`、再加载打包资产时，前者的法规名残留。引用能被识别为法条，却不在当前 `baselines` 里，命中 `notIndexed`，而默认策略是 `block` —— 产生假拦截，且结果取决于进程加载历史。
- 最小修复建议：把名字表收进 `createLegalLawIndex` 实例；或提供 `resetLegalLawIndex()` 并在每次 `load*` 前清空。
- 预估工作量：M
- 是否可自动化：是（两次不同目录加载的用例）
- 状态：confirmed

### F-LEG-002 `legal-evidence` 的 YAML 通用规则不参与判定

- 位置：`packages/legal/legal-evidence/src/engine.ts:80`、`:113`
- 维度：E
- 严重度：High
- 可能性：高
- 证据：`assess()` 的发现来自 `evaluator.checkFindings(input)` 与硬编码的 `checkGeneralFindings(input)`；后者直接写死 `LEGAL-EVI-GEN-001` 与 `-002` 及其 `critical` 严重度。`assets/legal-evidence-rules.yaml:17,26` 声明的 `check` 与 `severity` 从不被读；`getRules()`/`getRulesByType()` 只被测试调用。
- 影响：部署方改 YAML 里通用规则的 `severity`（例如把 GEN-002 降为 warning）完全不生效，门禁实际强度与配置不符；公开 API 报出引擎不会执行的规则。
- 最小修复建议：由 `getRulesByType('general')` 驱动通用检查（`check` 字段映射到判定函数），YAML 成为唯一规则源；或在 README 与类型上明确"通用规则不可配置"。
- 预估工作量：M
- 是否可自动化：是（改 YAML severity 后断言评估结果变化）
- 状态：confirmed

### F-LEG-003 非法 `severity` 与非数值 `weights` 静默回落且无警告

- 位置：`packages/legal/legal-evidence/src/rule-set.ts:56`、`:80`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`severity` 只接受 `critical|warning|info`，其余落 `'warning'` 且不 `warnings.push`；`weights.relevance` 非 number 时直接取默认值，同样无警告。同文件其他字段缺省都会 push 警告。
- 影响：`severity: Critical`（大小写）或 `weights.relevance: "0.35"`（引号）这类错误让门槛悄悄降级，日志无痕；critical 降为 warning 会改变交付结论。
- 最小修复建议：非法值并入 `warnings`，或升级为 `LegalEvidenceRuleAssetError`；与同文件其他字段的失败方向对齐。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-LEG-004 两域默认引用策略分叉，缺对照说明与回归护栏

- 位置：`packages/legal/legal-law/src/verify.ts:37`、`packages/patent/patent-law/src/verify.ts:54`
- 维度：E
- 严重度：Low
- 可能性：中
- 证据：同一 `law-core` 的 `decideArticleCitation`，legal 默认 `notIndexed: block`/`unverified: block`，patent 默认 `warn`/`warn`；两侧 JSDoc 各自写了理由，但没有一处并列对照，也无跨域一致性用例。
- 影响：同一段引用文本在法律模式被拦、在专利模式放行；跨域复用文本时行为不可预期，改一侧默认值不会被另一侧的测试发现。
- 最小修复建议：两包 README 各加一行默认策略对照，并补一条跨域用例锁定"有意分叉"。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-LEG-005 专利知识库降级日志写死 `[sati]` 前缀

- 位置：`packages/patent/patent-knowledge/src/shared/knowledge-fts.ts:60`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`this.logger?.warn(\`[sati] ${this.degradeLabel} FTS5 不可用...\`)`；全仓该前缀仅此一处，同仓 `legal-evidence` 用 `[legal-evidence]`。
- 影响：按前缀过滤日志会把专利域的检索降级误判为其它系统；降级本身是重要运行信号。
- 最小修复建议：改为包名前缀（`[patent-knowledge]`）。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-LEG-006 三性判定器把「打分 + 结论对象」手写 13 份，布尔三元打分块 18 处

- 位置：`packages/legal/legal-evidence/src/evaluators/base.ts:90`、`:125`、`documentary.ts:51`、`electronic.ts:37`、`:84`、`expert-opinion.ts:37`、`:71`、`other-types.ts:30`、`:77`、`:125`、`:170`、`witness-testimony.ts:37`、`:79`（13 处判定尾）；六文件内 18 处 `if (input.x === true) { score += w; reasons.push(...) } else if (input.x === false) { score -= w; reasons.push(...) }`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：13 处判定尾逐字同构——`score = Math.max(0, Math.min(score, 1.0))` + 返回 `{dimension, score, level: levelFor(score), reasoning: reasons.length > 0 ? \`<标签>评估：${reasons.join('；')}\` : '<标签>评估：基础评分'}`，差异只有 `dimension` 与一个中文标签；`base.ts:90` 的关联性尾只用 `Math.min`（评分只增不减，与夹紧到 `[0,1]` 等价）。`npx jscpd packages/legal/*/src packages/law/*/src --min-tokens 40 --min-lines 4` 的 18 组命中里有 12 组落在判定器内部（判定尾 10 组、开场样板 2 组）。另有 60 处打分块（`reasons.push(` 与 `score += / -=` 各 60 次），其中 18 处是「`=== true` 加分、`=== false` 减分、未填不动」的同一形状，每题 5 行、只有字段名、两个权重与两句文案不同。
- 影响：新增一类证据或调整某维度权重时，要改的是同一段样板而不是一行数据；13 份尾里的兜底文案（`基础评分`）说明同一语义有 13 个作者各自维护。风险不是当前行为错误，而是下一次改动的漏改面。
- 最小修复建议：分两步。(a) 在 `base.ts` 增加 `dimensionJudgment(dimension, score, reasons, label)`（夹紧到 `[0,1]`、算 `levelFor`、拼兜底文案），13 处尾各换成一行；(b) 可选：增加布尔三元 helper `scoreSignal(score, value, yes: [Δ, 文案], no: [Δ, 文案], reasons)`，18 处各换一行——这一步把权重从 if 分支挪进参数，可读性是有代价的，需要一次人工确认，建议在 (a) 落地并跑过覆盖率门禁后再做。
- 净减少：(a) 13 处 × 7 行 = 91 行 → 13 行调用 + 约 12 行 helper，**净 −65 行**；(b) 18 处 × 5 行 = 90 行 → 18 行调用 + 约 10 行 helper，**再净 −62 行**。
- 预估工作量：(a) S；(b) M
- 是否可自动化：部分。jscpd 默认阈值抓不到 8 行尾（15 行以下的重复），需按 40/4 诊断；覆盖率门禁是 (b) 的必要回归护栏——`evaluators/*.ts` 在 per-file 100% 名单内。
- 状态：confirmed

### F-LEG-007 `getById` 在 `legal` 与 `judicial-interpretation` 逐字相同

- 位置：`packages/legal/legal-knowledge/src/legal/search.ts:160`、`packages/legal/legal-knowledge/src/judicial-interpretation/search.ts:186`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：两个方法的 19 行方法体逐字相同——`resolveAsOf` + `includeUnverified ?? true`、SQLite 分支 `findRow(<id 列>, id)` → `rowToRecord` → `resolveValidity` → `isVisible ? {...record, validity} : undefined`、内存分支同样的查数组与效力过滤；差异只有 id 列名、内存数组字段与记录类型。`jscpd` 40/4 命中两组（`judicial-interpretation/search.ts:193-199 ↔ legal/search.ts:164-170`、`:199-206 ↔ :170-177`，共 15 行）。`case-law` 的 `getById`（`case-law/search.ts:154`）没有效力过滤，属另一形态，不在本条内。
- 影响：效力过滤是这两类记录的可见性判定，两条路径漂移会让同一份 `asOf` 参数在两个检索引擎给出不同的可见性结论，而工具层把结果直接交给模型。
- 最小修复建议：把「读行/查数组 + 效力包裹」抽成 `shared/` 的 `withVisibility(record, asOf, includeUnverified)`（末尾 4 行）与 `SqliteFtsTable.findVisibleById(idColumn, id, asOf, includeUnverified)`（SQLite 分支），两个 `getById` 各缩到 4~5 行。
- 净减少：38 行 → 约 10 行方法体 + 18 行 helper，**净 −10~−20 行**，并把效力可见性收敛成一个判定点。
- 预估工作量：S
- 是否可自动化：部分。可在 `dual-backend-parity.spec.ts` 里加一条「两个引擎对同一 `asOf`/`includeUnverified` 组合给出同样的可见性」的断言。
- 状态：confirmed

### F-LEG-008 `evaluate_legal_evidence` 输出 schema 把维度判定对象写三份

- 位置：`packages/legal/legal-evidence/src/tool/evaluate-evidence.ts:110`、`:120`、`:130`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`dimensions` 下 `relevance`、`legality`、`authenticity` 三个属性各是一份 10 行的 `{ type: 'object', additionalProperties: false, properties: { dimension, score, level, reasoning } }`，逐字相同；`jscpd` 40/4 命中 `tool/evaluate-evidence.ts:110-119 ↔ :120-129` 与 `:110-119 ↔ :130-139`。
- 影响：向判定对象加字段（例如这次没有的 `weight`）时容易只改一处，模型可见 schema 与 `LegalEvidenceDimensionJudgment` 类型随即不一致，而两者没有类型级校验。
- 最小修复建议：文件内定义一次 `const DIMENSION_JUDGMENT_SCHEMA = {...} as const`，三个属性各写 `DIMENSION_JUDGMENT_SCHEMA`。
- 净减少：30 行 → 13 行，**净 −17 行**。
- 预估工作量：S
- 是否可自动化：是（`tools.spec.ts` 的快照会同时锁住三处）
- 状态：confirmed

### F-LEG-009 `rule-set.ts` 手写 `asRecord` 与同名 `hasText`，未用共享工具

- 位置：`packages/legal/legal-evidence/src/rule-set.ts:17`、`:32`
- 维度：B
- 严重度：Low
- 可能性：中
- 证据：`asRecord(value: unknown): Record<string, unknown> | null` 与 `@deepseek-ai/dsh-value` 的同名导出逐字同义（dsh-value 用 `isRecord` 实现，此处用 `typeof` + 一个 `as Record<string, unknown>` 断言）；同包的 `evaluators/base.ts:54` 也导出了 `hasText`，但签名是 `string | undefined | null`，与 `rule-set.ts` 的 `unknown` 版本同名不同义。`legal-evidence` 的 `package.json` 未依赖 `dsh-value`（同域 `legal-knowledge` 与 `law-core` 都已依赖）。
- 影响：同一包内两个 `hasText` 让人以为是一件事；手写 `asRecord` 多了一处断言，`no-unknown-casts` 基线与仓内统一替换都需要逐个认出它。
- 最小修复建议：短期把 `rule-set.ts` 的私有 helper 改名为 `hasTextField`（或直接内联），消除同名二义；引入 `dsh-value` 只在 Day 19 横向复核把各域 YAML 读取的 `asRecord` 一并收口时再评估——为一个 4 行 helper 单独加依赖、改 tsconfig 引用并重生成模块图不划算。
- 净减少：−4 行（仅取断言与重复实现），主要收益是消除同名二义；若并入 Day 19 的跨域收口则不止这一处。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed（建议并入 Day 19 处理）

## 视频模式

### F-VID-001 任务 journal 与账本无跨进程写守卫

- 位置：`packages/experimental/video-mode/src/store.ts:391`、`packages/experimental/video-mode/src/project.ts:281`
- 维度：E
- 严重度：High
- 可能性：中
- 证据：`writeStoreText` 与 `writeProject` 调用 `ctx.fs.writeText(target, text, undefined, signal)`，第三个参数是写意图且传 `undefined`（无条件覆盖）。`packages/fs/fs/src/types.ts:123` 已提供 `{ kind: 'replaceIfVersion', version }` 与 `FS_STALE_VERSION`。`mutateProjectFile` 的"读两次比对"在第二次读与写入之间仍有窗口。
- 影响：两个会话共享同一 workspace 时，并发写会丢 journal 记录——付费任务重启后不可恢复、成本不进预算；账本丢条目则漏记费用。视频模式是实验特性，但丢的是真实付费数据。
- 最小修复建议：改用 `replaceIfVersion`，把 `FS_STALE_VERSION` 转为有限重试；`withProjectLock` 保留为进程内优化而非一致性保证。
- 预估工作量：M
- 是否可自动化：是（两进程并发写用例）
- 状态：confirmed

### F-VID-002 成功任务缺 `output_path` 时不清 journal、不记账

- 位置：`packages/experimental/video-mode/src/tools/media.ts:471`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`outputPath = args.output_path ?? recovered?.outputPath`；写产物与 `settleTask` 都要求 `outputPath !== undefined`。`media.refresh` 命中内存任务时 `recovered` 为 `undefined`。
- 影响：provider 成功但调用方没带 `output_path` 时，journal 永久残留、费用不结算；客户端 `parsePendingTasks` 又按状态过滤掉，界面上看不到。预算可用额度被高估。
- 最小修复建议：终态清理与结算只依赖 `project_path`，与产物路径解耦；写产物单独判 `outputPath`。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-VID-003 zod schema 与手写类型双份维护，靠 `as` 抹平

- 位置：`packages/experimental/video-mode/src/project.ts:129`、`packages/experimental/video-mode/src/edl.ts:123`
- 维度：B
- 严重度：Medium
- 可能性：高
- 证据：schema 里有 `targetSeconds.max(3600)`、`shot.index.positive()` 等约束，手写接口无对应约束；两侧靠 `as VideoProject` / `as Edl` 对齐。
- 影响：任一侧改动不会被编译器发现；类型层允许的值可能在运行期被 schema 拒绝，或反之漏校验。
- 最小修复建议：`schema: z.ZodType<VideoProject>` 显式标注，或由 schema `infer` 导出类型。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-VID-004 ffmpeg 直接覆写目标，失败会毁掉上一版成片

- 位置：`packages/experimental/video-mode/src/edl.ts:450`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`assemble` 在目标不存在时先写空占位，随后让 ffmpeg 直接写声明输出路径；失败分支只抛 `MEDIA_ASSEMBLY_FAILED`，不做回滚。
- 影响：目标已存在时，ffmpeg 中途失败会留下截断文件，上一版可交付成片被覆盖；项目 `render` 记录仍指向该路径。
- 最小修复建议：渲染到 `<output>.partial`，成功且探测通过后经 `ctx.fs` 发布为正式路径。
- 预估工作量：M
- 是否可自动化：是（模拟 ffmpeg 失败断言旧文件仍在）
- 状态：confirmed

### F-VID-005 `resolveMediaConfig` 的 13 个默认值与 schema 默认值重复

- 位置：`packages/experimental/video-mode/src/tools/media.ts:337`
- 维度：B
- 严重度：Low
- 可能性：中
- 证据：`resolveMediaConfig` 的 13 个 `??` 默认值与 `Config` schema 的 13 个 `.default()` 是同一组值；前者另抛裸 `Error`。
- 影响：改一处忘另一处会让 Loader 展示值与运行时值分叉。
- 最小修复建议：schema 作为唯一默认源，`resolveMediaConfig` 只做派生与区间校验。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-VID-006 `StrictRequest` 与 `MediaTaskRequest` 字段完全重复

- 位置：`packages/experimental/video-mode/src/store.ts:283`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：`StrictRequest` 的字段与 `types.ts:159` 的 `MediaTaskRequest` 完全一致，且该文件已 import 后者；`taskRequestOf` 与 `requestOfTask` 是同一 `requestFields` 的两个方向包装。
- 影响：两份定义会在新增字段时漂移；读者要判断哪一个才是权威。
- 最小修复建议：删 `StrictRequest`，`requestFields` 直接返回 `MediaTaskRequest`。
- 预估工作量：S
- 是否可自动化：是
- 状态：confirmed

### F-VID-007 成本账本无完整性保护，模型可改写 `budget.json` 绕过预算

- 位置：`packages/experimental/video-mode/src/store.ts:27`、`:233`、`:260`；`packages/experimental/video-mode/src/tools/media.ts:466`
- 维度：A
- 严重度：Medium
- 可能性：中
- 证据：账本是工程目录下的明文 `budget.json`，`appendLedgerEntry` 只在进程内按 `taskId` 去重后整份重写；`ledgerCost` 直接求和；预算判定取 `max(projectCost, ledgerCost)`。工程目录位于会话工作区，模型的文件工具可以读写同一路径，账本没有签名、校验和或外部对账。
- 影响：预算保护依赖模型自觉。模型可以先调低 `project.json` 的镜头费用，再改写 `budget.json` 删掉已结算条目，`max()` 两侧同时变小，`MEDIA_BUDGET_EXCEEDED` 不再触发。花的是真实费用，而视频模式只是实验特性。
- 最小修复建议：账本移出模型可写目录（按工程 id 存在应用数据目录），或由宿主持有密钥对条目签名并在读取时校验；更彻底的做法是与 provider 的用量对账，而不是只信本地文件。
- 预估工作量：M
- 是否可自动化：是（改写 `budget.json` 后断言预算仍被拒）
- 状态：confirmed

### F-VID-008 `ui-video-studio` 手写第二份项目/账本/journal 文法，预算口径出现第三份

- 位置：`packages/client/ui-video-studio/src/client/project-reads.ts:13`、`:16`、`:19`、`:22`、`:194`、`:223`、`:256`、`:281`、`:299`、`:329`；权威定义在 `packages/experimental/video-mode/src/project.ts:28`、`:33`、`:51` 与 `store.ts:24`、`:27`、`types.ts:14`
- 维度：B
- 严重度：Medium
- 可能性：高
- 证据：① 文件名字面量两份——客户端 `TASKS_FILE = 'tasks.json'`、`LEDGER_FILE = 'budget.json'`（注释写明 "mirrors the Host's constant"），Host 在 `store.ts:24`、`:27` 各写一遍。② 状态枚举两份——`SHOT_STATUSES`（`:19`）与 `project.ts:33` 的 `z.enum(['draft','ready','generating','failed'])` 同序同值；`PENDING_STATUSES`（`:22`）是 `types.ts:14` 六个状态里的前三个。③ 字段表两份——`parseProjectDocument`/`shotOf`/`renderOf` 逐字段重写 `projectSchema`/`shotSchema`/`renderSchema`，且校验更弱：`aspect` 只查 `typeof string`（Host 限 `9:16`/`16:9`/`1:1`）、`index` 只查整数（Host 要求正）、`durationSec` 无 60 上限、`targetSeconds` 无 3600 上限、`id` 无小写连字符正则、整体无 `.strict()`；因此客户端会渲染 Host 工具随后拒绝的文档。④ 预算口径第三份——`spentCnyOf`（`:329`）复写 `Math.max(projectCost, ledgerCost)`，而同一行在 Host 已写两遍（`tools/deliver.ts:107`、`tools/media.ts:385`）。⑤ `parseLedgerTotal`（`:281`）按 `taskId` 去重是客户端独有（Host 在 `appendLedgerEntry` 时去重），属对手改文件的防御，不是缺陷，但它是文法分叉的既成事实。
- 影响：Host 改字段、改状态、改预算口径时客户端不会跟着变，且没有门禁能发现——`ui-video-studio` 的 `package.json` 不依赖 `@deepseek-ai/dsh-video-mode`（`video-mode` 引 `node:fs`，无法跨 plane 导入），两份定义只靠注释约定同步。当前除校验强度外无实际不一致；一旦漂移，界面会显示不能生成的项目，或显示与门禁不同的花费金额。
- 最小修复建议：把文法抽成浏览器安全的叶子模块（`video-mode` 内不引 Node 的 `format/` 子路径，或并入现有 util 包），导出 zod schema、文件名字面量、状态枚举与 `spentCny(project, ledger)`；Host 两处 `Math.max` 与客户端 `spentCnyOf` 共用它，客户端只保留 UI 投影（裁剪字段的 `StudioShot`/`StudioRender`）。校验强度不一致随 schema 复用一并消失。
- 净减少：客户端约 130 行解析/校验代码换成约 50 行投影加共享调用，净 **−60~−80 行**；Host 两处 `max` 合并 **−1 行**；主要收益是文法单源与校验强度回归。
- 预估工作量：M（新增 browser-safe 入口要登记 `tsconfig` files 并重跑 `gen-module-graph`）
- 是否可自动化：部分。可加一条对照测试：同一 fixture 分别过 Host `projectSchema` 与客户端 `parseProjectDocument`，断言接受/拒绝一致；根治做法是客户端直接复用 schema。
- 状态：confirmed

### F-VID-009 云 provider 的 submit/poll 与图片编码骨架各写一遍，拷贝已漂移

- 位置：`packages/experimental/video-mode/src/minimax.ts:201`、`:239`、`:486`、`:508`；`packages/experimental/video-mode/src/siliconflow.ts:186`、`:223`、`:423`、`:445`、`:436`；`packages/experimental/video-mode/src/comfyui.ts:805`、`:927`；`packages/experimental/video-mode/src/media.ts:1098`；`packages/experimental/video-mode/src/cloud-common.ts:137`
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：① 40/4 的 5 组克隆全是 minimax↔siliconflow 的 provider 骨架——submit 尾（`minimax.ts:203-209` ↔ `siliconflow.ts:188-194`）、settle 尾（`280-285` ↔ `274-279`、`291-303` ↔ `285-297`）、`imageDataUri`（`487-501` ↔ `420-434`）、`imageMediaTypeOf`（`505-521` ↔ `441-457`）；两处都套了 `jscpd:ignore-start -- sibling cloud providers share …`，默认阈值（60/6）不可见。② 拷贝已漂移：`siliconflow.ts:436` 对空文件 `bytes.byteLength === 0` 直接 `MEDIA_REQUEST_INVALID`，`minimax.ts` 没有这一检查，会发出空 payload 的 `data:` URI 让 provider 去拒；接受类型分叉（minimax 另收 heic/heif）是 provider 差异、合理，空文件分叉无依据。③ 超时前导同样被 ignore 包裹且已分叉：`minimax.ts:239` 先 `await this.cancel(task)` 再 `failed(...)`，`siliconflow.ts:223` 只 `this.pending.delete(task.id)` 再 `failedTask(...)`；差异可由各自 `cancel` 语义解释，但它说明「先复制再加 ignore」不是收口。④ `messageOf` 三份逐字相同——`media.ts:1098`（导出，仅 `tests/media-runtime.spec.ts:25` 与 `media.ts:798` 自用）、`cloud-common.ts:137`（经 `minimax-common.ts:23` 再导出）、`comfyui.ts:927`（私有）。⑤ 失败快照助手两份、体相同、参数顺序相反——`cloud-common.ts` 的 `failedTask(task, message, code = 'MEDIA_TASK_FAILED')` 与 `comfyui.ts:805` 的 `private failed(task, code, message)`。
- 影响：五处骨架各自演化，已有三处实质漂移；跨 provider 复制调用点时，`msg`/`code` 顺序相反会在 message 恰好是合法 code 字面量时静默错位。`media.ts` 的 `messageOf` 只为一条 spec 存在，属导出面冗余。
- 最小修复建议：`cloud-common.ts` 补三个共享件——唯一 `messageOf`、`imageDataUri(reference, { label, mediaTypes, rejectEmpty })`（空文件策略作显式参数并统一为拒绝）、`submitResponse(response, label)`；`KeyedCloudProvider` 加 `protected pollPreamble(pending, task)` 模板方法（节流 + 超时，超时经 `onTimeout` 钩子）。`comfyui.failed` 改名并与 `failedTask` 同序（或直接复用）。删 `media.ts` 的 `messageOf`，spec 改从 `cloud-common` 导入。
- 净减少：`imageDataUri` + `imageMediaTypeOf` 合一份 **−30 行**；submit/settle 尾合一份约 **−15 行**；`messageOf` 删两份 **−12 行**；合计约 **−55 行**（保守 −40~−55），并把节流与超时收到一处。
- 预估工作量：S~M
- 是否可自动化：部分。抽取后 jscpd 的 5 组应归零；空文件策略统一后补一条 spec 断言两个 provider 都拒绝空图片。
- 状态：confirmed

### F-VID-010 store 的「锁 + 读 + 改 + 写」骨架三处各写一遍

- 位置：`packages/experimental/video-mode/src/store.ts:144`（`recordTask`）、`:168`（`forgetTask`）、`:233`（`appendLedgerEntry`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：三者都是 `withKeyLock` + read + 过滤/去重 + 写的同形骨架（40/4 组 11：`store.ts:147-154` ↔ `:171-178`，8 行 55 token）；任务 journal 有 `writeTaskRecords`（`:122`）作对称写入口，账本没有 `writeLedger`，`appendLedgerEntry` 把 `ledgerSchema.safeParse` + `issuesOf` + `writeStoreText` 三步内联（`:245-249`）；锁键字符串 `store:${path}` 与 `ledger:${path}` 在两个函数里各自拼写。另有一处无意的不对称：`forgetTask` 在过滤结果不变时短路返回，`recordTask` 无论是否有变化都整份重写。
- 影响：新增 journal 或账本写操作时要记得同时加锁、复检 schema、复用写入口，三者现在都只是约定；锁键拼错不会报错，只会让两个写者互不排斥——与 F-VID-001 的跨进程问题叠加时更难发现。
- 最小修复建议：补 `writeLedger`（镜像 `writeTaskRecords`），抽私有 `mutateTasks(ctx, projectPath, apply, cwd, signal)` 统一锁键、读、写，`recordTask`/`forgetTask` 各缩成一次调用，`appendLedgerEntry` 改走 `writeLedger`。
- 净减少：**−8~−12 行**，锁键与 schema 复检各一个所有者。
- 预估工作量：S
- 是否可自动化：是（现有 store spec 覆盖三条路径，抽取后重跑即证）
- 状态：confirmed

### Day 11 定向结论：视频域已处理的面

- **ffmpeg 参数注入**：`color` 受 `^[0-9a-fA-F]{6}$` 约束，画布与帧率都是整数并限定区间，`inSec`/`outSec` 是数字；字幕路径经 `escapeSubtitleFilename`（控制字符直接拒绝、引号分段转义），字体名经 `escapeStyleValue`；所有输入以 argv 传入，不经 shell。
- **路径策略**：EDL 的每个输入、字幕与输出都先经 `ctx.fs.resolve` + `processPath`，ffmpeg 拿到的是策略已批准的处理路径。
- **provider 下载**：`downloadVideo` 只接受 `http:`/`https:`，按 `content-length` 与实测字节双重上限拒绝超大响应，空响应直接失败。
- **凭据**：`apiKey` 只出现在 `Authorization` 头；错误消息带状态码与 provider 文本，不拼接密钥。
- **客户端**：`ui-video-studio` 没有 `dangerouslySetInnerHTML` 或 `innerHTML`，读取统一走 `workspaceFiles` Remote。

## 跨域（Day 19 横向汇总）

### F-CROSS-001 四域另有 4 份 `messageOf`/`errorText` 与 1 份可并的 `asRecord`，而 `dsh-value` 已有对应原语且 11 个域内包已依赖它

- 位置：`packages/experimental/video-mode/src/media.ts:1098`、`:cloud-common.ts:137`、`:comfyui.ts:927`（三份逐字相同的 `messageOf`）；`packages/patent/patent-tools/src/figure/freecad-renderer.ts:195`（`errorText`）；`packages/legal/legal-evidence/src/rule-set.ts:32`（`asRecord`）
- 维度：B
- 严重度：Low
- 可能性：高
- 证据：共享侧 `packages/util/value/src/index.ts:33` 的 `asRecord` 与同文件的 `errorMessage` 已覆盖同一语义，且是 total 实现——`errorMessage` 先按 `instanceof Error` 取 `String(message)`，再处理带 `message` 字段的对象，最后 `String(value)` 兜底，整段包在 `try/catch` 里返回 `[unrenderable thrown value]`；四域的本地副本都是 `error instanceof Error ? error.message : String(error)`。本地副本有两个可观察差别：① `: string` 签名在运行时可能被打破（`error.message` 若不是字符串，本地实现原样返回，共享实现 `String(...)`）；② 对 `{ message: '...' }` 形态的抛出值，本地实现落到 `String(value)` 得到 `[object Object]`，共享实现取出 message。域内已有 12 个文件直接导入这两个原语（例如 `packages/patent/patent-knowledge/src/case-law/case-law-search.ts:23`、`packages/law/knowledge-core/src/fts-search.ts:9`、`packages/document/document-deliver/src/tool.ts:35`），说明「共享实现是约定」而不只是可选替代。依赖成本已结算：`video-mode`、`patent-core`、`patent-knowledge`、`patent-rule`、`patent-teams`、`legal-knowledge`、`knowledge-core`、`doc-style`、`doc-template`、`document-deliver`、`ui-video-studio` 共 11 个域内包已在 `package.json` 声明 `@deepseek-ai/dsh-value`，四域内需要新增依赖的只有 `patent-tools`（其 `errorText` 在 `freecad-renderer.ts`）。**不能机械合并的三处**：`packages/patent/patent-data/src/cnipr-receipt.ts:259` 与 `packages/patent/patent-tools/src/tool/internal/consume-projections.ts:57` 的 `asRecord` 返回 `| undefined`，`packages/patent/writing-patterns/src/pattern-store.ts:431` 带 `source`/`field` 抛错——三者是不同契约，保留。全仓 `messageOf`/`errorText` 定义 19 处，四域占 4 处，其余 15 处在域外，不在本计划范围，但同一根因。
- 影响：同一语义有两个所有者时，修总渲染的边界（trap、非字符串 message、非 Error 对象）只改一处不会传导；`media.ts:1098` 的 `export` 只为 `tests/media-runtime.spec.ts:25` 的两条断言而存在，是这个函数把内部助手升成公开面的唯一理由。
- 最小修复建议：四处 `messageOf`/`errorText` 删除本地实现、改为从 `@deepseek-ai/dsh-value` 导入 `errorMessage`（`patent-tools` 同时补 `package.json` 依赖并跑 `pnpm run gen-module-graph`）；`legal-evidence/src/rule-set.ts` 的 `asRecord` 改为导入（该包已依赖 `dsh-value`，零清单改动）。顺带把 `media.ts:1098` 的导出收回，测试改为直接喂 `{ message }` 与不可渲染值两组输入，正好覆盖共享实现的 `{message}` 与 trap 分支。
- 净减少：**−26~−32 行**（4 处 `messageOf`/`errorText` 含 JSDoc 约 −22~−28，1 处 `asRecord` −4）。
- 预估工作量：S
- 是否可自动化：是（改导入后跑四域测试；`media-runtime.spec.ts` 两条断言需同步改输入）
- 状态：new
- 归并关系：本条的 `asRecord` 部分与 F-LEG-009 重叠（F-LEG-009 的「是否值得为 4 行引入 `dsh-value`」由 11 个已依赖包直接回答）；`messageOf` 部分吸收 F-VID-009 中的同名助手项（F-VID-009 的 submit/poll 骨架仍独立成立）。三处 `asRecord` 变体、F-PAT-025 的 YAML 惯用法不在本条内，不重复计数。合计净减少若按「全部实施」相加，须扣掉这三处重叠。

### F-CROSS-002 `patent-tools` 导入未声明的 workspace 依赖 `@deepseek-ai/dsh-value`，运行产物靠打包内联掩盖

- 位置：`packages/patent/patent-tools/src/tool/law-search.ts:16`；`packages/patent/patent-tools/package.json`
- 维度：B/E
- 严重度：Low
- 可能性：高
- 证据：该行 `import { errorMessage } from '@deepseek-ai/dsh-value'` 是值导入，但在 `dependencies`、`devDependencies`、`peerDependencies` 三节里都没有 `@deepseek-ai/dsh-value`（该包声明的是另一个包 `@deepseek-ai/dsh-util-values`，两者相邻但不同：`packages/util/value` 与 `packages/util/values`）。pnpm 的严格布局下 `packages/patent/patent-tools/node_modules/@deepseek-ai/` 只有 `dsh-util-values` 一个链接，仓根 `node_modules` 也没有 `dsh-value`，因此该导入在 Node 解析面上不可达。实际不报错的原因是构建把依赖内联了：`packages/patent/patent-tools/lib/index.js` 里没有 `dsh-value` 字样，而 `lib/types/tool/law-search.js:15` 仍保留这条 `import`。`pnpm run verify-package-dependencies` 返回「104 package(s) match the published dependency policy」并退出 0，说明该门禁校验的是声明侧与已登记导出，不覆盖「源码导入 → 清单声明」这个方向。同批核查的其余 10 个域内包（`patent-core`、`patent-knowledge`、`patent-rule`、`patent-teams`、`legal-knowledge`、`knowledge-core`、`doc-style`、`doc-template`、`document-deliver`、`video-mode`）都正确声明了该依赖，`patent-tools` 是唯一例外。该导入由 PR #729（2026-11-04）引入。
- 影响：依赖图、依赖 catalog 与 SBOM 少一条真实边，许可证与来源清单因此与产物内含的代码不一致；`lib/types` 分支保留的悬空导入会在消费者按子路径解析类型时暴露。**假设**：若本仓有意统一「运行时一律打包内联、workspace 依赖只作类型来源」，则本条降级为文档缺口（需在依赖策略里写明这一豁免），而不是缺陷——但现有十包的同形做法说明约定是「声明」。
- 最小修复建议：在 `packages/patent/patent-tools/package.json` 的 `dependencies` 补 `"@deepseek-ai/dsh-value": "workspace:^"`，随后跑 `pnpm install`、`pnpm run gen-module-graph`、`pnpm run gen-dependency-catalog`，并复核 `verify-module-graph` 与 `verify-dependency-catalog`。更彻底的修法是让 `verify-package-dependencies` 增加反向校验：源码里每个 workspace specifier 必须出现在本包清单的某一节。
- 净减少：0 行代码；收益是依赖声明、catalog 与 SBOM 与产物一致。若采纳反向校验，门禁范围从「104 个包」扩到「104 个包的导入图」。
- 预估工作量：S
- 是否可自动化：是（新增反向校验即可在 CI 拦住同类问题）
- 状态：new

## 修复记录

### 批次 A：复用收口（2026-11-15）

用户确认实施批次 A 后完成。改动只涉及复用收敛，未改变任何工具对外的参数与结果字段。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-003（3/4） | `patent-core`、`patent-document`、`patent-tools` 的原子写改为委托 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`；`patent-core` 与 `patent-document` 新增该依赖与 tsconfig 引用 | `patent-core/src/persist-utils.ts`、`patent-document/src/document/renderPatentDocument.ts`、`patent-tools/src/tool/internal/workflow-helpers.ts` |
| F-PAT-001 | 随 F-PAT-003 消失：`renderPatentDocument` 的无条件先删后改名被删除，改用共享包的原子替换 | 同上 |
| F-PAT-007 | `knowledge-note-file-writer` 改从 `patent-core` 导入；`patent-data` 的再导出保留，注释已说明是历史公开面 | `patent-tools/src/tool/knowledge-note-file-writer.ts` |
| F-DOC-003 | `docx-kit` 新增 `DEFAULT_ZIP_READ_LIMITS`；`office-kit` 与 `document-deliver` 改引同一常量，删除重复字面量 | `docx-kit/src/types.ts`、`docx-kit/src/index.ts`、`office-kit/src/index.ts`、`document-deliver/src/index.ts` |
| F-DOC-004（文档域） | `document-deliver` 与 `doc-template` 的 `Config` 改为必填字段 + `z<Partial<Config>, Config>`，删除 `apply` 里的 `??`，schema 成为唯一默认源；两处测试改为传 `Config({})` 或 `Partial<Config>` | `document-deliver/src/index.ts`、`doc-template/src/index.ts` 及对应测试 |

同时修正共享包一个被测试暴露的缺陷：`writeFileAtomic` 的临时文件清理失败会覆盖原始错误；现改为保留原始写入错误，与既有 `patent-document` 语义一致（`packages/util/atomic-write/src/index.ts`）。

未纳入本批次：

- **`patent-teams`**：其 `atomicWriteText` 已有 `wx` 独占创建，且刻意保留 Windows 上"重试后直接覆写"的降级路径。改用共享包会去掉该降级、把可恢复的 Windows 文件占用变成硬失败；在没有 Windows 证据前不改，F-PAT-003 记为 3/4。
- **F-VID-005**：视频 `resolveMediaConfig` 的 13 个 `??` 与 schema 默认值重复，属实验包且改动面独立，留待批次 B。

验证：`pnpm run typecheck` 5/5 通过；`pnpm run lint` exit 0；`pnpm exec vitest run` 覆盖 document 全部包与专利核心/文档/工具包，267 个测试文件、5128 个用例通过、4 skipped；`verify-module-graph` 与 `gen-module-graph` 均通过。

### 批次 A2：Day 6 安全修复（2026-11-15）

用户确认「先修这两条」后完成。改动只涉及 `patent_pdf_download` 一条链路。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-014 | `defaultResolveOutputDir` 的显式分支改用 `resolveConfinedPath`，与 `patent-document`、`patent-filing` 一致；`outputDir` 参数描述同步改为「相对当前工作目录；越出工作目录的路径会被拒绝」 | `patent-tools/src/tool/patent-pdf-download.ts` |
| F-PAT-015 | 兜底下载的落盘改为 `writeFileAtomic(target, buf, { mode: 0o644 })`，删除固定的 `<target>.tmp`、`writeFile`+`rename` 与手工 `unlink` 清理 | 同上 |

**行为变化**：`outputDir` 传工作目录之外的绝对路径现在会被拒绝（`invalid_tool_input`，消息含「输出目录 越出工作目录」）；相对路径与默认的 `<cwd>/专利原文/YYYY-MM-DD` 不变。这是有意的收紧——该目录同时是 ego-browser 子进程的 `cwd`。

**既有测试行为**：`index.spec.ts` 的接线用例原本传绝对临时目录，改为传 `.`（解析后即 cwd，`mkdir` 无副作用，且该用例只验证接线）。新增两条用例覆盖收紧后的行为。

未纳入本批：F-PAT-016（ego-browser 继承完整环境，Low），留待批次 B 一并处理子进程环境白名单。

## 复核记录

- 跨文件克隆检测：`pnpm run duplication` exit 0，3885 个文件 / 804,636 行，0 处克隆（默认阈值）。因此上述"重复"均为语义级重复，克隆门禁抓不到。
- 已否决：`knowledge-core` 根入口同时导出纯函数与 `node:fs` 的安装助手——`grep` 显示其消费者只有 `patent-core`、`patent-knowledge`、`legal-knowledge` 三个 Node 侧包，不进入客户端构建，不构成实际问题；仅作为包边界整洁度观察，不立发现。
- 已否决：Day 3 提出的"资产定位不一致"。`patent-rule`/`law`/`fees`/`deadline`/`writing-patterns` 用单层 `../assets` 且在主进程内经 Electron fs 垫片读取；`patent-document`/`filing` 因模块嵌套更深或资产交给 Python 子进程，必须用双候选路径加 `unpackedFsPath`。两类都能在 ASAR 下命中，真正的差异是失败方向（见 F-PAT-002 与 F-PAT-004）。

## 观察列表

| ID | 观察 | 影响 | 建议 | 状态 |
|---|---|---|---|---|
| OBS-001 | 本机默认 Node v22.22.3 低于根 `engines.node` 的 `>=24.9.0` | 默认 shell 的构建与覆盖率结果不可代表 CI | 2026-11-15 已在 nvm Node v24.19.0 下补跑：构建 10/10 通过；覆盖率运行见 OBS-006 | fixed |
| OBS-002 | `pnpm audit` 返回 `ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS` | 依赖漏洞在当前 registry 下不可见 | 改用 npmjs registry 执行审计，或把 Dependabot 安全告警作为基线来源 | new |
| OBS-003 | 本机未安装 LibreOffice | 文档域真实转换无法本地验证 | 安装 LibreOffice 或依赖 CI 的文档转换 lane | new |
| OBS-004 | 仓库未配置 SAST 与密钥扫描 | 安全缺陷只能靠人工审阅发现 | 在 [07-ci-hardening.md](07-ci-hardening.md) 提出门禁建议；本周期内人工补扫 | new |
| OBS-005 | `docs/code-review/` 中文单语文档会被 `verify-translation-pairing` 判定为缺配对 | 修复前实测 55 个 `.md` 全部报错 | 2026-11-15 已按用户确认在 `scripts/translation-pairing.manifest.json` 加入 `"docs/code-review/"`；复跑退出码 0 | fixed |
| OBS-006 | Node 24 全量 `test:coverage` 退出码 1：10 个测试文件、13 个用例失败；`ERROR: Coverage` 为 0；未产出覆盖率百分比 | 覆盖率基线暂缺百分比；失败多为环境相关 | 在 CI 覆盖率 lane 或提高测试超时后复跑；单独复核 watch-config 与 plugin-market git 两条 | new |
| OBS-007 | 四域类型逃逸计数：patent 82 `any` / 159 `as unknown` / 575 非空断言；document 18/11/13；legal 11/0/44；law 0/0/1；video-mode 5/0/0 | `as unknown` 已被 `no-unknown-casts` 基线冻结，数量本身不是回归 | 精简维度只处理能消除的双重断言，不新增基线条目 | new |

## 记录规则

- 安全发现写清"谁在什么条件下能访问什么资源"。
- 精简发现写"位置—删什么/换什么—预期净减少的复杂度或代码量"。
- 优化发现必须附证据；没有证据的只标为"可选观察"。
- 测试缺口写具体用例：输入、期望行为、边界或错误路径。
- 疑似密钥只记文件、行号、类型和"已脱敏"，不写明文。
