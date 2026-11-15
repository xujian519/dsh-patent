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
| F-DOC-001 | DOCX 渲染的 Markdown 解析无围栏代码块分支 | DOC | E | High | 高 | confirmed |
| F-DOC-002 | `document_deliver` 把取消与编程错误都报为"不可读" | DOC | E | Medium | 中 | confirmed |
| F-DOC-003 | OOXML 读取限额两包各写一份字面量 | DOC | B | Low | 高 | fixed |
| F-DOC-004 | 插件默认值出现两个来源（schema default 与 `??`） | DOC | B | Medium | 中 | fixed（文档域） |
| F-DOC-005 | `tool-office` 用 9 处 `as` 断言担保跨模块不变量 | DOC | B | Low | 低 | confirmed |
| F-LEG-001 | `legal-law` 名字表是模块级只增状态，加载不复位 | LEG | E | High | 中 | confirmed |
| F-LEG-002 | `legal-evidence` 的 YAML 通用规则不参与判定 | LEG | E | High | 高 | confirmed |
| F-LEG-003 | 非法 `severity` 与非数值 `weights` 静默回落且无警告 | LEG | E | Medium | 中 | confirmed |
| F-LEG-004 | 两域默认引用策略分叉，缺对照说明与回归护栏 | LEG | E | Low | 中 | confirmed |
| F-LEG-005 | 专利知识库降级日志写死 `[sati]` 前缀 | LEG | B | Low | 高 | confirmed |
| F-VID-001 | 任务 journal 与账本无跨进程写守卫 | VID | E | High | 中 | confirmed |
| F-VID-002 | 成功任务缺 `output_path` 时不清 journal、不记账 | VID | E | Medium | 中 | confirmed |
| F-VID-003 | zod schema 与手写类型双份维护，靠 `as` 抹平 | VID | B | Medium | 高 | confirmed |
| F-VID-004 | ffmpeg 直接覆写目标，失败会毁掉上一版成片 | VID | E | Medium | 中 | confirmed |
| F-VID-005 | `resolveMediaConfig` 的 13 个默认值与 schema 默认值重复 | VID | B | Low | 中 | confirmed |
| F-VID-006 | `StrictRequest` 与 `MediaTaskRequest` 字段完全重复 | VID | B | Low | 高 | confirmed |

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
- 状态：confirmed

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
