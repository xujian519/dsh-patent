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
| F-PAT-003 | 原子写四份手写实现，未复用仓库共享 `atomic-write` 包 | PAT | A/B | High | 高 | fixed |
| F-PAT-004 | 品牌配置损坏时静默回退默认品牌 | PAT | B | Medium | 中 | fixed |
| F-PAT-005 | 四个输出路径默认锚定 `process.cwd()` | PAT | E | Medium | 中 | confirmed |
| F-PAT-006 | `adversary-review` 以关键词启发式输出"置信度 87.5%" | PAT | B | High | 高 | fixed |
| F-PAT-007 | `atomicWriteJson` 从 `patent-data` 历史导出面导入 | PAT | B | Low | 高 | fixed |
| F-PAT-008 | TRIZ 资产裸 `JSON.parse as T`，失败无包内错误类型 | PAT | B | Low | 低 | confirmed |
| F-PAT-009 | `registerPatentTools` 单函数 312 行 | PAT | B | Medium | 高 | confirmed |
| F-PAT-010 | `patent/model-call` 在流异常时不落会话事件 | PAT | E | Medium | 中 | fixed |
| F-PAT-011 | `pending`/`rounds` 为进程内状态且未声明单进程语义 | PAT | E | Medium | 中 | fixed |
| F-PAT-012 | 51 处 `as unknown as` 与两个零引用导出类型 | PAT | B | Low | 高 | confirmed |
| F-PAT-013 | `patent-core` 导出面过宽，大量内部符号对外 | PAT | B | Low | 高 | confirmed |
| F-PAT-014 | `patent_pdf_download` 的输出目录不受部署文件策略约束 | PAT | A | High | 中 | fixed |
| F-PAT-015 | PDF 兜底下载的临时文件路径可预测且不独占创建 | PAT | A/B | Medium | 中 | fixed |
| F-PAT-016 | ego-browser 子进程继承完整 `process.env` | PAT | A | Low | 中 | confirmed |
| F-PAT-017 | 交付前引用门禁只覆盖 `render_patent_document`，立案构建不经引用核验 | PAT | A/E | High | 低 | fixed |
| F-PAT-018 | 后台运行接受模型自报的 `approveStageIds`，HITL 审批可绕过 | PAT | A | High | 中 | fixed |
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
| F-PAT-032 | 判例零命中检索整表解压 LIKE，约 4.6 秒 | PAT | C | Medium | 中 | new |
| F-PAT-033 | 附图渲染截止期的 `dispose` 没有用例锁住监听清理 | PAT | D | Medium | 中 | new |
| F-PAT-034 | `patent_pdf_download` 成功落盘后不检查清单里的 sha1 | PAT | D | Medium | 低 | new |
| F-PAT-035 | 团队等待结束后不检查 abort 监听是否摘掉 | PAT | D | Medium | 中 | new |
| F-PAT-036 | 未完成依赖的判定没有锁住失败、取消和进行中 | PAT | D | Medium | 中 | new |
| F-PAT-037 | PDF 渲染的宽限和 abort 监听没有用例 | PAT | D | Medium | 中 | new |
| F-PAT-038 | nuo 检索 provider 的抛错和超时告警没有用例 | PAT | D | Medium | 中 | new |
| F-PAT-039 | 同一句权利要求在两套解析里独立／从属结论相反 | PAT | E | High | 高 | fixed |
| F-PAT-040 | 空 quote 的覆盖类映射仍判单篇全覆盖 | PAT | E | High | 中 | fixed |
| F-PAT-041 | 所引权项没有要素时仍报告已并入其全部要素 | PAT | E | High | 中 | fixed |
| F-PAT-042 | 未提取到技术问题时，阻断级法条缺口记为通过 | PAT | E | High | 中 | fixed |
| F-PAT-043 | 源文可读时空 pin-cite 被判格式非法 | PAT | E | Medium | 中 | fixed |
| F-PAT-044 | 要素 claimNo 没有对应段落时用全文做子串校验 | PAT | E | Medium | 中 | fixed |
| F-PAT-045 | 省略 `parallel_lower_levels` 仍判概括范围通过 | PAT | E | Medium | 高 | new |
| F-PAT-046 | 同一格同时 `literal` 与 `not-found` 时，缺口与全覆盖同时成立 | PAT | E | Medium | 中 | fixed |
| F-PAT-047 | 审批门中断后的续跑从第一个阶段重跑，内置 manifest 的检索与模型阶段重复执行 | PAT | E | Medium | 中 | deferred |
| F-PAT-048 | 通知书解析不出驳回理由时，两条双输入规则判为通过且无未评估标记 | PAT | E | Medium | 中 | fixed |
| F-PAT-049 | 结构门禁与引用门禁不核对 `textArgs`，声明写错即静默放行 | PAT | E | Medium | 低 | fixed |
| F-PAT-050 | 重规划按哈希保留已完成步骤，重复步骤全部判为已完成 | PAT | E | Medium | 低 | new |
| F-PAT-051 | 沿革快照按条号跨法套用，实施细则条文取到专利法同号条的生效日与状态 | PAT | E | Medium | 高 | new |
| F-PAT-052 | 指南未修改的节在 rule-lock 判「已修订/已失效」，law_verify 判「已核验」 | PAT | E | High | 高 | fixed |
| F-PAT-053 | 费用工具把单一 `lateMonths` 套到每个年费年度，多年度补缴的滞纳金与事实不符 | PAT | E | Medium | 中 | new |
| F-PAT-054 | `designatedMonths` 可覆盖法定期间，驳回决定的 3 个月复审期被缩成 1 个月 | PAT | E | Medium | 低 | new |
| F-PAT-055 | 上游 JSON 字符串含 null 元素时 `mapPatentData` 抛 TypeError | PAT | E | Low | 低 | new |
| F-DOC-001 | DOCX 渲染的 Markdown 解析无围栏代码块分支 | DOC | E | High | 高 | confirmed |
| F-DOC-002 | `document_deliver` 把取消与编程错误都报为"不可读" | DOC | E | Medium | 中 | fixed |
| F-DOC-003 | OOXML 读取限额两包各写一份字面量 | DOC | B | Low | 高 | fixed |
| F-DOC-004 | 插件默认值出现两个来源（schema default 与 `??`） | DOC | B | Medium | 中 | fixed（文档域） |
| F-DOC-005 | `tool-office` 用 9 处 `as` 断言担保跨模块不变量 | DOC | B | Low | 低 | confirmed |
| F-DOC-006 | 跨模块请求类型按字段重写而非组合（`RenderRequest`、`OfficeImagesRequest`） | DOC | B | Low | 高 | confirmed |
| F-DOC-007 | Office 转换成功返回后不检查 abort 监听是否摘掉 | DOC | D | Medium | 中 | new |
| F-DOC-008 | 同一模板的 Markdown 只出一个标题，HTML 与 DOCX 出两个一级标题 | DOC | E | Medium | 高 | new |
| F-DOC-009 | DOCX 渲染的 Markdown 表格把转义竖线拆成新列，并把整行破折号当分隔行丢弃 | DOC | E | Medium | 中 | new |
| F-DOC-010 | `document_deliver` 的占位符判定不识别 HTML 代码块、注释与属性，代码示例被阻断 | DOC | E | Medium | 中 | new |
| F-LEG-001 | `legal-law` 名字表是模块级只增状态，加载不复位 | LEG | E | High | 中 | confirmed |
| F-LEG-002 | `legal-evidence` 的 YAML 通用规则不参与判定 | LEG | E | High | 高 | fixed |
| F-LEG-003 | 非法 `severity` 与非数值 `weights` 静默回落且无警告 | LEG | E | Medium | 中 | fixed |
| F-LEG-004 | 两域默认引用策略分叉，缺对照说明与回归护栏 | LEG | E | Low | 中 | confirmed |
| F-LEG-005 | 专利知识库降级日志写死 `[sati]` 前缀 | LEG | B | Low | 高 | confirmed |
| F-LEG-006 | 三性判定器把「打分 + 结论对象」手写 13 份，布尔三元打分块 18 处 | LEG | B | Low | 高 | confirmed |
| F-LEG-007 | `getById` 在 `legal` 与 `judicial-interpretation` 逐字相同 | LEG | B | Low | 高 | confirmed |
| F-LEG-008 | `evaluate_legal_evidence` 输出 schema 把维度判定对象写三份 | LEG | B | Low | 高 | confirmed |
| F-LEG-009 | `rule-set.ts` 手写 `asRecord` 与同名 `hasText`，未用共享工具 | LEG | B | Low | 中 | confirmed |
| F-LEG-010 | 未核验与未索引引用的工具结果没有锁住处置 | LEG | D | Medium | 中 | new |
| F-LEG-011 | 证人利害关系未填写时，关键规则报「证人与案件无利害关系」通过 | LEG | E | High | 中 | fixed |
| F-LEG-012 | 电子数据与证人证言的 `formLegal: false` 在合法性评分中被忽略 | LEG | E | Medium | 中 | fixed |
| F-LEG-013 | 法规检索先取 2 倍上限再按时间效力过滤，SQLite 与内存后端给出不同结果 | LEG | E | Medium | 中 | new |
| F-LEG-014 | 法律知识的默认判定日期取 UTC，与中国法域的自然日相差 8 小时 | LEG | E | Low | 中 | new |
| F-VID-001 | 任务 journal 与账本无跨进程写守卫 | VID | E | High | 中 | fixed |
| F-VID-002 | 成功任务缺 `output_path` 时不清 journal、不记账 | VID | E | Medium | 中 | confirmed |
| F-VID-003 | zod schema 与手写类型双份维护，靠 `as` 抹平 | VID | B | Medium | 高 | fixed |
| F-VID-004 | ffmpeg 直接覆写目标，失败会毁掉上一版成片 | VID | E | Medium | 中 | confirmed |
| F-VID-005 | `resolveMediaConfig` 的 13 个默认值与 schema 默认值重复 | VID | B | Low | 中 | fixed |
| F-VID-006 | `StrictRequest` 与 `MediaTaskRequest` 字段完全重复 | VID | B | Low | 高 | confirmed |
| F-VID-007 | 成本账本无完整性保护，模型可改写 `budget.json` 绕过预算 | VID | A | Medium | 中 | confirmed |
| F-VID-008 | `ui-video-studio` 手写第二份项目/账本/journal 文法，预算口径出现第三份 | VID | B | Medium | 高 | confirmed |
| F-VID-009 | 云 provider 的 submit/poll 与图片编码骨架各写一遍，拷贝已漂移 | VID | B | Low | 高 | confirmed |
| F-VID-010 | store 的「锁 + 读 + 改 + 写」骨架三处各写一遍 | VID | B | Low | 高 | confirmed |
| F-VID-011 | 预算检查是 check-then-act，同一工程的并发生成可以超额 | VID | E | Medium | 中 | new |
| F-VID-012 | 失效的 journal 记录没有工具侧清理路径 | VID | E | Medium | 中 | new |
| F-VID-013 | `status` 对 `artifacts: []` 的成功任务照常结算并清 journal | VID | E | Low | 中 | new |
| F-VID-014 | 项目身份取工具结果里的原始路径，绝对与相对写法会让同一工程出现两次 | VID | E | Low | 高 | new |
| F-VID-015 | EDL 音频片段的 `inSec`/`outSec` 不校验顺序，校验晚到 ffmpeg | VID | E | Low | 中 | new |
| F-CROSS-001 | 四域另有 4 份 `messageOf`/`errorText` 与 1 份可并的 `asRecord`，而 `dsh-value` 已有对应原语且 11 个域内包已依赖它 | CROSS | B | Low | 高 | new |
| F-CROSS-002 | `patent-tools` 导入未声明的 workspace 依赖 `@deepseek-ai/dsh-value`，运行产物靠打包内联掩盖 | CROSS | B/E | Low | 高 | new |
| F-CROSS-003 | 知识库安装覆盖时先删输出，改名失败没有用例 | CROSS | D | High | 中 | fixed |
| F-CROSS-004 | 专利、文档、法律三域的工具错误类没有接入 `HarnessError`，失败码在 `tool/result` 与会话界面丢失 | CROSS | E | Low | 高 | new |

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
- 状态：fixed（`finally` 仍追加事件。流抛错或消费方提前停止时带 `truncated: true`，已产出的文本留在 `output`。完整流不带该字段。回放把截断记录当作抛错，不把它当成正常结束）

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
- 状态：fixed（README 已声明单进程契约；`approve`／`reject` 的 JSDoc 写明重启后报 no pending plantask；重启用例锁定）

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
- 状态：fixed（2026-11-16，批次 E6）

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
- 状态：fixed（2026-11-16，批次 E6）

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

### F-PAT-032 判例零命中检索整表解压 LIKE，约 4.6 秒

- 位置：`packages/patent/patent-knowledge/src/case-law/case-law-search.ts:137`–`146`（`stmtSearchLike` 在 WHERE 里对每篇最长 chunk 调用 `sati_uncompress`）、`:352`–`364`（没有 `search_prefix` 时走这条）；`packages/law/knowledge-core/src/fts-search.ts:39`（不足 3 字、无 FTS 或 FTS 已降级时直接 LIKE）、`:53`–`:55`（FTS 空结果再 LIKE）；`packages/patent/patent-knowledge/src/install.ts:175`（`searchPrefix ?? false`）；`packages/patent/patent-knowledge/src/config.ts:31`–`32`（候选顺序是数据目录下的 `knowledge.db`、`knowledge-lite.db`，然后源库）
- 维度：C
- 严重度：Medium
- 可能性：中
- 证据：Day 21，Node `v24.19.0`，数据目录下没有 `knowledge.db`，只读打开的查询库是 `~/.dsh/knowledge/knowledge-lite.db`（3543654400 字节）。`documents` 81551 行，`chunks` 144188 行，`docs_fts` 为 trigram contentless、144079 行，比 `chunks` 少 109 行。查询库和 `~/.sati/knowledge/knowledge.db` 都没有 `search_prefix`。EXPLAIN 为 `SCAN documents`，再用 `idx_chunks_document` 取最长 chunk。`CaseLawSearchEngine.search`：`创造性` 走 FTS，5 条，8 次中位数 75.15ms；`专利`（2 字，标题凑满）0.72ms；`锆钚`（2 字，0 条）4772.49ms；`锆钚钨`（3 字，FTS 未命中后再 LIKE，0 条）4569.07ms。同一词在 `KnowledgeLawSearch` 上 0 条、4.18ms（`law_article` 96 行、`guideline_rule` 112 行）。
- 影响：对判例库的短查询，或 trigram 没有命中的词，会在返回空结果前扫描全部文档并解压每篇最长分块。标题能很快凑满条数的常见词停留在 1ms 内，FTS 命中停留在 75ms 一带。法规引擎的文档类型范围小，同一条回退是 4ms 级。
- 最小修复建议：三字及以上的 FTS 未命中时，不要对全部文档调用 `sati_uncompress`。修改只放在判例引擎。共享阶梯同时服务法律域。Day 21 在已安装法规库上的零命中是 4.18ms。Day 24 把法律域合成库的 LIKE 记为可选观察，法规零命中中位数 8.47ms，判例 18.73ms。不足三字的全文子串仍会扫表；要消掉这 4.8 秒，使用已有的 `--search-prefix`。该开关把召回限制在每篇最长 chunk 的前 512 个码点，`searchPrefix` 保持默认关闭。
- 预估工作量：S
- 是否可自动化：是（小型夹具断言三字零命中不再执行 `stmtSearchLike`。本机 4.6 秒的数字不写进单测）
- 状态：new

### F-PAT-033 附图渲染截止期的 `dispose` 没有用例锁住监听清理

- 位置：`packages/patent/patent-tools/src/figure/subprocess-render.ts:210`–`213`（`dispose` 执行 `clearTimeout` 并 `removeEventListener`）；调用点 `graphviz-renderer.ts:252`、`freecad-renderer.ts:300`、`inkscape-renderer.ts:303` 与 `:363`
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：三个渲染器的失败分类已有断言。Graphviz 覆盖超时（`figure-graphviz-renderer.spec.ts:351`）、信号终止（`:402`）、调用方取消（`:415`）和非零退出（`:508`）。Inkscape 覆盖非零退出（`figure-inkscape-renderer.spec.ts:407`）、调用方取消（`:426`）和临时目录删除失败仍保留转换结果（`:346`）。FreeCAD 覆盖超时（`figure-freecad-renderer.spec.ts:388`）、信号终止（`:321`）、调用方取消（`:334`），并在成功路径断言 `graceMs` 为 3000（`:256`）。`startRenderDeadline` 只被这三个渲染器调用，测试没有直接导入它。附图测试里没有 `deadline.dispose`、`listenerCount('abort')` 或 `removeEventListener`。
- 影响：删掉某一处 `finally` 里的 `dispose()` 后，现有超时、取消和非零退出用例仍然通过。调用方信号上的 abort 监听会留到该信号结束；同一信号上反复渲染会叠监听。计时器因 `unref` 不会挡住进程退出，所以成功路径的用例也看不出漏清理。
- 最小修复建议：为 Graphviz、FreeCAD、Inkscape 各加一条成功退出用例。输入是未取消的调用方 `AbortSignal`，假子进程立即以退出码 0 结束并交出该渲染器会接受的产物。期望是返回成功后，该信号的 abort 监听数与调用前相同；随后再 abort 这个信号，已返回的成功结果保持不变。超时用例在文案含「渲染超时」之外，同样断言监听数回到调用前。删掉对应 `finally` 里的 `dispose()` 时该用例失败。
- 预估工作量：S
- 是否可自动化：是（上述三条假子进程用例）
- 状态：new

### F-PAT-034 `patent_pdf_download` 成功落盘后不检查清单里的 sha1

- 位置：`packages/patent/patent-tools/src/tool/patent-pdf-download.ts:309`–`311`（`sha1OfFile`）、`:604`–`:616`（成功条目写入清单，含 `size` 与 `sha1`）；续传比较在 `:264`–`:269`（只看 `size`）
- 维度：D
- 严重度：Medium
- 可能性：低
- 证据：`packages/patent/patent-tools/tests` 下没有 `sha1`。fetch 兜底用例（`patent-pdf-download.spec.ts:130`–`:154`）让 ego 返回 `fallback`，响应体是 `%PDF-1.4 ` 加 600 个 `x`，`Content-Type` 为 `application/pdf`，断言工具文本含「fetch 兜底」。该路径会在 `packages/patent/patent-tools/src/tool/patent-pdf-download.ts:393` 调用 `writeFileAtomic`，再把 `sha1` 写入 `.MANIFEST.jsonl`。续传用例自己拼接清单，字段只有 `patent`、`status`、`path`、`size`、`ts`（`:157`–`:165`），摘要对错都不影响跳过。
- 影响：把 `sha1` 写成常量、改成路径字符串的摘要，或从清单对象里拿掉该字段，现有「下载完成」文案断言仍然通过。续传今天只比较文件大小，用户当次下载结果不变。清单里的摘要可以和落盘字节分叉，以后按摘要核对时没有回归用例。
- 最小修复建议：沿用 `:130` 的 fetch 兜底输入。期望 `.MANIFEST.jsonl` 新增一行，`status` 为 `ok`，`size` 等于落盘字节数，`sha1` 等于该文件内容的 sha1。本用例不要求摘要不符时重新下载；那条比较当前只存在于 `fileSizeMatches`。
- 预估工作量：S
- 是否可自动化：是（读回清单的单测）
- 状态：new

### F-PAT-035 团队等待结束后不检查 abort 监听是否摘掉

- 位置：`packages/patent/patent-teams/src/team-activity.ts:82`（`addEventListener`）、`:64`（`removeEventListener`）；`packages/patent/patent-teams/src/members.ts:537`（`addEventListener`）、`:542`（`finally` 里的 `removeEventListener`）
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：两处监听都带 `{ once: true }`。`team-activity.spec.ts` 覆盖本队通知（`:9`）、超时（`:16`）和中止（`:40`），`service.spec.ts:1794` 覆盖服务层超时。`service.spec.ts:1378` 在 `waitForMemberIdle` 等待中途中止，断言错误文案含取消原因。`packages/patent/patent-teams/tests` 里没有 `listenerCount`，也没有 `removeEventListener`。
- 影响：删掉这两处 `removeEventListener` 后，现有超时、通知和中止用例仍然通过。`once: true` 只在 abort 事件发生时摘掉监听。等待因通知、超时或成员变空闲而结束时，监听留在调用方信号上。同一信号上再次等待会叠监听；该信号稍后中止时，已经结束的等待仍会走进 `reject`。
- 最小修复建议：为 `TeamActivity` 加一条用例。输入是同一个未中止的 `AbortSignal`，`timeoutMs` 为 5，等待期间不调用 `notify`。期望是返回 `{ timedOut: true }` 后，该信号的 abort 监听数与调用前相同；随后中止这个信号，这次已返回的结果保持 `{ timedOut: true }`。再为 `waitForMemberIdle` 加一条用例。输入是 `whenIdle` 立即完成的成员和未中止的调用方信号。期望是等待返回后监听数与调用前相同；随后中止该信号，不再产生未处理的拒绝。删掉对应的 `removeEventListener` 时该用例失败。
- 预估工作量：S
- 是否可自动化：是（上述两条假信号用例）
- 状态：new

### F-PAT-036 未完成依赖的判定没有锁住失败、取消和进行中

- 位置：`packages/patent/patent-teams/src/state.ts:38`–`:40`（`status !== 'completed'`）；调用点 `task-ops.ts:463`–`:465`、`scheduler.ts:144`–`:147`
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：`state.spec.ts:125`–`:139` 的夹具只有 `t1` 为 `completed`、`t2` 为 `pending`，并断言缺失 id `ghost` 算未完成。`service.spec.ts:591`–`:594` 与 `:803`–`:806` 挡住的依赖都是刚创建、状态为 `pending` 的任务，错误码是 `DEPENDENCIES_OPEN`。`scheduler.spec.ts:259` 调度的是没有依赖的 `pending` 任务。`:276` 的 `claimed` 是该成员自己丢失回合后仍持有的开放任务，调度会换一次 attempt，不经过依赖判定。
- 影响：把过滤收成「状态是 `pending`，或任务不存在」后，现有三处用例仍然通过。`failed`、`cancelled`、`claimed`、`in_progress` 的前置任务会被当成已满足。认领会放行下游任务，调度会把下游 `pending` 任务派给空闲成员。
- 最小修复建议：在 `state.spec.ts` 的 `unsatisfiedDependencies` 夹具里加入四条任务，状态分别为 `failed`、`cancelled`、`claimed`、`in_progress`，再加一条 `completed`。期望返回的 id 是前四条，不含已完成的那条。再在 `service.spec.ts` 把一条已认领任务更新为 `failed`，创建依赖它的新任务并认领。期望错误码为 `DEPENDENCIES_OPEN`，文案点名该失败任务的 id。把 `state.ts:40` 的比较改成只认 `pending` 时这两条失败。
- 预估工作量：S
- 是否可自动化：是（纯函数夹具加一条认领用例）
- 状态：new

### F-PAT-037 PDF 渲染的宽限和 abort 监听没有用例

- 位置：`packages/patent/patent-document/src/document/pdfRenderer.ts:34`（`GRACE_MS` 为 3000）、`:103`（`addEventListener`）、`:114`（传入 `graceMs`）、`:134`（`finally` 里的 `removeEventListener`）
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：失败分类已有断言。缺 Chrome 在 `pdf-renderer.spec.ts:96`，非零退出在 `:114`，零退出但没有文件在 `:136`，内部超时在 `:262`（断言内部 signal 已中止），调用方中止在 `:294`，信号名在 `:327`，子进程缝抛错在 `:371` 与 `:392`。成功路径 `:67` 断言 `{ ok: true, path }`、`existsSync` 和 `--headless`。`packages/patent/patent-document/tests` 里没有 `graceMs`、`listenerCount` 或 `removeEventListener`。`patent-data` 的 `subprocess-runner.spec.ts:97` 已锁住该包自己的默认 3000，不在本条。实现在 `pdfRenderer.ts:125` 只检查文件是否存在，本条不要求读回 PDF 魔数。
- 影响：从 spawn 规格里拿掉 `graceMs`，或删掉 `finally` 里的 `removeEventListener`，现有超时、中止和成功用例仍然通过。假子进程不执行 SIGKILL 升级，宽限字段缺了也看不出来。`once: true` 只在 abort 发生时摘掉监听。成功返回后监听留在调用方信号上，同一信号上反复渲染会叠监听。
- 最小修复建议：在 `pdf-renderer.spec.ts:67` 的成功 spawn 上断言 `calls[0].graceMs` 为 3000。再加一条成功用例。输入是未中止的调用方 `AbortSignal`，假 Chrome 以退出码 0 结束并写出文件。期望是返回 `{ ok: true, path }` 后，该信号的 abort 监听数与调用前相同；随后中止这个信号，已返回的结果保持成功。删掉 `:114` 的 `graceMs` 或 `:134` 的 `removeEventListener` 时，对应用例失败。
- 预估工作量：S
- 是否可自动化：是（假子进程上的两条断言）
- 状态：new

### F-PAT-038 nuo 检索 provider 的抛错和超时告警没有用例

- 位置：`packages/patent/patent-data/src/search-provider.ts:23`–`:31`（`createNuoSearchProvider` 只映射 `hits`）
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：`search-provider.spec.ts` 只有 `:9` 与 `:55` 两条成功用例。空标题回落到专利号，空 `publication_date` 省略，默认 `limit` 为 5。两条传入的 `warnings` 都是空数组。缓存侧 `patent-cache.spec.ts:194` 拒绝把 `检索失败` 与 `检索超时` 写入缓存，`:243` 断言失败结果会再次调用源。那是 `isSearchResultCacheable` 与 `cachedSearchPatents`，不是这个 `StageProvider.search` 的返回值。CNIPR 通道的超时与缺回执在 `cnipr-channel.spec.ts:154` 与 `:165`，不在本条。
- 影响：在 `:23` 外包一层 `catch` 并返回 `[]` 后，两条成功用例仍然通过。检索抛错今天会传到调用方；接住之后搜索阶段拿到空命中，调用方分不清超时和零结果。`warnings` 今天被丢掉。把告警含 `检索超时` 改成抛错，现有用例也通过，因为它们的 `warnings` 是空数组。
- 最小修复建议：注入的 `search` 抛出 `Error('检索超时')`。期望 `provider.search` 以同一条消息拒绝。再注入一条结果：`hits` 为空，`warnings` 为 `['检索超时 (30000ms)']`。期望返回 `[]` 且不抛错。前者在新增 `catch` 返回 `[]` 时失败。后者在把超时告警改成抛错时失败。
- 预估工作量：S
- 是否可自动化：是（注入 `search` 的两条用例）
- 状态：new

### F-PAT-039 同一句权利要求在两套解析里独立／从属结论相反

- 位置：`packages/patent/patent-core/src/claim-chart/runtime/claim-refs.ts:25`、`:76`–`:83`、`:104`；`packages/patent/patent-core/src/claim-lint/parse.ts:30`、`:36`、`:73`–`:87`、`:125`；消费点 `packages/patent/patent-core/src/atoms/handlers/builtin/claim-breadth.ts:188`、`packages/patent/patent-tools/src/tool/amendment-reserve.ts:97`、`packages/patent/patent-tools/src/tool/claim-lint.ts:155`、`packages/patent/patent-tools/src/tool/domain-check.ts:236`
- 维度：E
- 严重度：High
- 可能性：高
- 证据：Node `v24.19.0`，`pnpm exec tsx /tmp/d34-repro.mts` 退出码 0。`deriveClaimRefs` 对 `2. 根据权利要求1-35所述的装置，其特征在于，所述壳体为金属。` 与 `3. 根据权利要求3-1所述的装置，其特征在于，所述壳体可拆。` 都给出 `claimType: independent`、`refersTo: []`；`parseReferenceNumbers('1-35')` 与 `('3-1')` 都是 `[]`，`('1-31')` 展开为 1 到 31。同一段文本交给 `parseClaimDocument`：权 2 `independent: false` 且 `references` 为 1 到 35，权 3 `independent: false` 且 `references` 为 `[1, 2, 3]`。`2. 如权利要求1所述的装置，其特征在于，还包括滤芯。` 在 `deriveClaimRefs` 中是 `dependent`、`refersTo: [1]`，在 `parseClaimDocument` 中 `independent: true`、`referenceClause: null`。`2. 根据权利要求１所述的装置`（全角１）在 `deriveClaimRefs` 中是 `independent`，在 `parseClaimDocument` 中是 `independent: false`、`references: [1]`。区间上限在 `claim-refs.ts` 是跨度 30 且超限或倒序整段丢弃；`claim-lint/parse.ts` 的上限是 1000，倒序按端点展开，引用句只认句首的「根据权利要求」。F-PAT-020 只覆盖无行首编号时的缺省，不覆盖本条。
- 影响：`claim_lint` 与 `domain-check` 把「如权利要求 1 所述」当成独立权利要求，从属权项规则不跑；`claim-breadth` 与 `amendment-reserve` 把全角数字或跨度大于 30 的区间引用当成独立权利要求，概括范围与 33 条替代会按错误的独权集合检查。同一份权利要求书在两个工具里技术方案的引用范围不同。
- 最小修复建议：权项引用只留一份解析。超限或倒序区间记入 `validateClaimRefs` 的缺陷，不要把 `refersTo` 收成空数组再标成 `independent`。句式同时接受「根据／如／按照／依」和全角数字。`claim-lint` 改为调用这份结果。
- 预估工作量：M
- 是否可自动化：是（上面三句各一条断言，锁住 `independent` 与 `references`）
- 状态：fixed（2026-11-16，批次 E2）

### F-PAT-040 空 quote 的覆盖类映射仍判单篇全覆盖

- 位置：`packages/patent/patent-core/src/claim-chart/runtime/pin-cite-validator.ts:90`–`:92`；`packages/patent/patent-core/src/claim-chart/runtime/mapping-machine.ts:10`、`:26`–`:27`、`:37`–`:45`；`packages/patent/patent-core/src/atoms/handlers/builtin/chart.ts:301`–`:302`；展示点 `packages/patent/patent-tools/src/tool/claim-chart-build.ts:177`
- 维度：E
- 严重度：High
- 可能性：中
- 证据：同一次 `pnpm exec tsx /tmp/d34-repro.mts`。`verifyQuoteInSource('', '前文 [0032] 壳体为塑料。 [0034] 滤芯可拆。')` 返回 `{ ok: true, reason: '' }`。要素 `2a`、映射 `literal`、`quote: ''`、`pinCite: ''`，且权 2 引用权 1 时，`deriveNoveltyCoverageByClaim` 给出权 2 `covered: true`、`missing: []`。`COVERED_MAPPINGS` 只含 `literal`、`anticipation`、`literal-construction-dependent`，`validateRowMapping` 不读 `quote`。
- 影响：对比表可以在没有任何逐字引用时写出「单篇全覆盖成立」。`claim_chart_build` 把原子里的结论原样交给模型。无效或侵权意见会把未引用的对比文件说成已经公开了该特征。
- 最小修复建议：源文可读时，`literal`、`anticipation`、`literal-construction-dependent` 必须带去空白后非空的 `quote`，并且 `verifyQuoteInSource` 对空串返回失败。`not-found` 仍允许空 `quote`。
- 预估工作量：S
- 是否可自动化：是（空 `quote` 的 `literal` 行被拒；`not-found` 加空 `quote` 通过）
- 状态：new

### F-PAT-041 所引权项没有要素时仍报告已并入其全部要素

- 位置：`packages/patent/patent-core/src/claim-chart/runtime/mapping-machine.ts:89`–`:104`；`packages/patent/patent-core/src/claim-chart/runtime/invalidity-conclusion.ts:109`–`:116`、`:146`–`:147`
- 维度：E
- 严重度：High
- 可能性：中
- 证据：同一次脚本。权利要求 1 有正文、没有任何要素；权利要求 2 引用权利要求 1，只有要素 `2a` 且该行 `literal`。`deriveNoveltyCoverageByClaim` 的结果只有权 2，`covered: true`，`includesReferredClaims: true`，`referredClaimNos: [1]`。`renderInvalidityConclusion` 写出「权利要求 2: 单篇全覆盖成立（已并入所引用权利要求 1 的全部要素）」和「权利要求 2: 无区别特征（主对比文件已覆盖全部要素）」。`dependentClaimIssues` 为 `[]`。`allCovered` 对空要素列表返回 true，因为 `every` 在空数组上为真；覆盖判定只过滤「已经出现在 elements 里、且 claimNo 落在引用范围内」的要素，权 1 没有要素就不会进入 `missing`。
- 影响：从属权利要求被写成已经包含所引独立权利要求的全部技术特征，而那一项根本没有被拆开、也没有被比对。区别特征清单同时写成「无区别特征」。
- 最小修复建议：引用范围内权项号在 `elements` 中出现次数为 0 时，该路径 `covered` 为 false，并在结论里写明「所引权利要求 N 没有要素，不能并入」。不要把空列表当成已覆盖。
- 预估工作量：S
- 是否可自动化：是（权 1 无要素、权 2 仅 `2a` 为 `literal` 时，权 2 不得 `covered: true`）
- 状态：new

### F-PAT-042 未提取到技术问题时，阻断级法条缺口记为通过

- 位置：`packages/patent/patent-core/src/atoms/handlers/builtin/problem-check.ts:310`–`:315`；`packages/patent/patent-tools/src/atoms/legal-gaps.ts:271`–`:278`、`:514`–`:548`
- 维度：E
- 严重度：High
- 可能性：中
- 证据：同一次脚本。`ProblemCheckHandler.execute({ state: { diff: '区别特征是壳体为金属。' } })` 返回 `problem_check_passed: true`，报告为「实际解决的技术问题合规检查（A22.3 第二步）：未提取到实际解决的技术问题，无法校验（不阻断）」。把这两个字段和 `profile: 'inventiveness'` 交给 `LegalGapsHandler` 后，`problem` 项为 `severity: block`、`status: passed`、依据「已由 state.problem_check_report 评估」，`legal_gaps_passed: true`。该检查没有 `notAssessed`。`evaluateCheckpoint` 在 `failureKey === true` 且报告有值时直接记通过。证据审查缺清单时报告含「未执行」，`legal-gaps.ts:194`–`:197` 会记成未评估；技术问题这条没有同等分支。
- 影响：创造性流程里，专利法第 22 条第 3 款的阻断项在没有技术问题文本时仍显示通过。汇总头可以写成「无阻断项」。上游没写出可提取的问题，交付门禁不会停。
- 最小修复建议：报告含「无法校验」或「未提取到」时，`problem` 检查走 `notAssessed`，`problem_check_passed` 不要写成 `true`。缺问题文本与检出违规分开。
- 预估工作量：S
- 是否可自动化：是（上面这条 `diff` 输入断言 `legal_gaps` 的 `problem` 项为 `not-assessed`，且 `legal_gaps_passed` 不因该项变成通过）
- 状态：fixed（2026-11-16，批次 E3）

### F-PAT-043 源文可读时空 pin-cite 被判格式非法

- 位置：`packages/patent/patent-core/src/atoms/handlers/builtin/chart.ts:289`–`:300`；`packages/patent/patent-core/src/claim-chart/runtime/pin-cite-validator.ts:65`–`:70`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。`validatePinCite('', '前文 [0032] 壳体为塑料。 [0034] 滤芯可拆。')` 返回 `ok: false`，原因是格式非法；`validatePinCite('[D1 段[0032]]', 同一源文)` 返回 `ok: true`。`chart.ts:292`–`:294` 对 trim 后为空的 pin-cite 跳过格式校验。`:297`–`:300` 在 `sourceText` 存在时仍无条件调用 `validatePinCite(row.pinCite, sourceText)`。`validateChart` 没有导出，本轮没有把整图校验跑进进程；拒绝来自这段无条件调用加上空串的返回值。
- 影响：带 `source_path` 的对比文件上，`not-found` 行按提示留空 pin-cite 会校验失败。模型为了通过会补一个源文里存在的段号。定位随后不再表示「未提供位置」。
- 最小修复建议：`:299` 与 `:293` 使用同一个条件，trim 后为空则跳过 `validatePinCite`。非空且格式非法的 pin-cite 仍然失败。
- 预估工作量：S
- 是否可自动化：是（有源文、`not-found`、空 pin-cite 通过；`[D1 段[9999]]` 在带 `[0032]` 标记的源文上失败）
- 状态：new

### F-PAT-044 要素 claimNo 没有对应段落时用全文做子串校验

- 位置：`packages/patent/patent-core/src/claim-chart/runtime/element-validator.ts:143`–`:148`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。`validateElements([{ id: '5a', claimNo: 5, text: '包括壳体', kind: 'limitation' }], '1. 一种装置，其特征在于，包括壳体。')` 返回 `ok: true`，`errors` 为空。`splitClaimSegments` 只有权 1。`:145`–`:146` 在 `segments.get(claimNo)` 未命中时改用整篇去空白文本。注释写的是兼容无编号单条权利要求。
- 影响：要素可以挂在权利要求书里不存在的项号上，只要文本能在其他项里找到。后续覆盖结论会写成「权利要求 5 全覆盖」。
- 最小修复建议：`segments.size > 0` 且目标项号没有段落时报错。只有切分结果为空时才回退全文。
- 预估工作量：S
- 是否可自动化：是（上例期望失败；无行首编号的单条权利要求仍通过）
- 状态：new

### F-PAT-045 省略 `parallel_lower_levels` 仍判概括范围通过

- 位置：`packages/patent/patent-core/src/atoms/handlers/builtin/claim-breadth.ts:156`–`:164`、`:217`、`:248`–`:250`；`packages/patent/patent-core/src/llm-json.ts:199`–`:200`
- 维度：E
- 严重度：Medium
- 可能性：高
- 证据：同一次脚本。说明书含「加热通道为螺旋形通道」。模型记录有 `claim_no`、`generalization`、命中原文的 `quote`、`all_parallel_same_effect: true`、`defect: none`、`reason`，没有 `parallel_lower_levels`。`ClaimBreadthHandler` 返回 `claim_breadth_passed: true`。报告写「[通过] 权利要求 1「任意形状的加热通道」：未列出并列下位；效果一致：是」。JSON schema 的 `required` 含 `parallel_lower_levels`。`parseOptionalJsonStringArray` 把 `undefined` 收成 `[]`。`checkRecord` 的通过条件是 `defect === 'none'`、`all_parallel_same_effect` 与锚点命中，不看下位列表是否为空。
- 影响：专利法第 26 条第 4 款的概括检查在模型没列出并列下位时仍然通过，报告同时写「效果一致：是」。法律缺口的 `claim-support-breadth` 读这个布尔值。
- 最小修复建议：该字段缺失时降级，不把缺失收成空数组。明确给出 `[]` 时，`all_parallel_same_effect: true` 不得通过。
- 预估工作量：S
- 是否可自动化：是（省略字段时期望 `_error`；显式 `[]` 且 `all_parallel_same_effect: true` 时期望 `claim_breadth_passed: false`）
- 状态：new

### F-PAT-046 同一格同时 `literal` 与 `not-found` 时，缺口与全覆盖同时成立

- 位置：`packages/patent/patent-core/src/atoms/handlers/builtin/chart.ts:280`–`:303`；`packages/patent/patent-core/src/claim-chart/runtime/gap-detector.ts:79`–`:83`；`packages/patent/patent-core/src/claim-chart/runtime/mapping-machine.ts:26`–`:27`、`:60`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。要素 `1a` 对目标 `D1` 有两行，映射分别是 `literal` 与 `not-found`，`quote` 都是空串。`detectGaps` 的类别是 `['not-found']`。`deriveNoveltyCoverageByClaim` 对权 1 给出 `covered: true`、`missing: []`。校验循环没有按 `(elementId, targetId)` 拒绝重复行。覆盖集合看到 `literal` 即算覆盖，缺口集合看到 `not-found` 即记缺口。
- 影响：同一张表的缺口列表写「未找到对应内容」，新颖性结论写全覆盖。两份输出会一起进入 `claim_chart_build` 的返回值。
- 最小修复建议：校验阶段按要素与目标去重，同一格多于一行就报错，不进入覆盖计算。
- 预估工作量：S
- 是否可自动化：是（上例两行被拒；单行 `literal` 与单行 `not-found` 的结果保持不变）
- 状态：new

### F-PAT-047 审批门中断后的续跑从第一个阶段重跑

- 位置：`packages/patent/patent-workflow/src/workflow.ts:481`（主循环固定从 0 开始）；`packages/patent/patent-core/src/workflow/types.ts:188`–`:193`（契约写明「重跑从第一个阶段开始」）；`packages/patent/patent-tools/src/tool/patent-workflow-run.ts:349`、`:619`–`:620`（模型侧指引「带 approveStageIds 重跑可继续」）；持久化键 `packages/patent/patent-tools/src/tool/internal/workflow-helpers.ts:139`、`:219`–`:221`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：旧审阅的风险登记册已按同一语义登记 `R-77`（`reports/code-review-risk-register.md:824`–`:835`，状态「已确认」，处置是「先固定现状，真实续接与持久化各自单独立项」；`tests/workflow-recovery.spec.ts:117` 的注释也写明「恢复是整次重跑」）。本条是该登记的复核与量化。Node `v24.19.0`，`pnpm exec tsx d35-repro.mts` 退出码 0。四阶段 manifest（`s1`、`s2`、审批门、`s3`）：首跑执行 `s1`、`s2` 后在门中断，`completed: false`；带 `approvalGrants: ['gate']` 重跑执行 `s1`、`s2`、`s3` 后 `completed: true`，前置两个阶段没有被跳过。8 个内置 manifest 的审批门都在最后一个阶段，门前阶段数分别为 7（infringement）、13（novelty、invalidation、reexamination）、14（oa_response）、15（inventiveness、patentability）、26（disclosure）；门前原子含 `search`、`claim-chart`、`draft-specification`、`figure-analysis`（`d35-repro3.mts` 输出）。持久化 runId 为 `<caseKey>__<manifestId>`，脚本里两次 `saveRun` 收到同一个键，中断那次记录被续跑覆盖。
- 影响：后台运行（`run_in_background: true`）或关闭 `approveStageGates` 的部署在审批门暂停后，续跑把门前全部阶段重新执行：外部检索与多次模型调用重复计费，附图、说明书等前置产出再写一遍。`patent_workflow_run` 的后台模式正是长分析的建议用法。中断记录被同 id 覆盖后，只有会话事件还能证明这次运行停在哪。
- 最小修复建议：沿用 R-77 的方向——给 manifest 路径加恢复点，例如 `WorkflowRunOptions.resumeFrom` 从指定阶段开始，或让 `persist` 逐阶段保存产出并在续跑时复用；在那之前，后台续跑说明应写明前置阶段会重跑，并让续跑使用新的 runId 以保留中断记录。
- 预估工作量：M
- 是否可自动化：是（中断后带 grants 重跑，断言前置 executor 只被调用一次；或断言续跑从 `resumeFrom` 开始）
- 状态：deferred

### F-PAT-048 通知书解析不出驳回理由时，两条双输入规则判为通过

- 位置：`packages/patent/patent-rule/src/runtime/dual-input.ts:119`–`:123`、`:132`；`packages/patent/patent-tools/src/tool/rule-check.ts:264`、`:271`–`:281`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一脚本。`parseOfficeAction('第一次审查意见通知书\n申请人：某某公司\n本申请经初步审查，现进入实质审查程序。')` 的 `rejectionTypes` 为 `[]`；`evaluateDualRule` 对 PR-OA-008（驳回理由覆盖）与 PR-OA-009（未提条款引用）都返回 `null`。`rule_check` 以 `scope: 'patent-oa-response'`、同一 `notice` 执行，输出 15 条其它规则的违规，两条双输入规则一条没有，也没有「双输入规则未评估」行；该行只在 `notice` 为空时由 `:272`–`:273` 写入。工具描述只说明「未提供 notice 时显式列出未评估」。
- 影响：通知书是扫描件文本、版式异常或只写「详见附件」时，解析器识别不到驳回理由，两项本应逐条回应的检查判为通过。模型从「无违规」读成「每条驳回理由都已覆盖、没有引用未提条款」，交付前置门禁也把这次 `rule_check` 记成有效前置证据。
- 最小修复建议：`noticeText` 非空而 `parseOfficeAction` 的 `rejectionTypes` 为空时，把两条规则写入 `dualInputSkipped`（或新增通知书解析诊断字段），结果显式写「通知书未识别到驳回理由，双输入规则未评估」。
- 预估工作量：S
- 是否可自动化：是（固定 notice 文本断言 `dualInputSkipped` 含 `PR-OA-008`、`PR-OA-009`）
- 状态：fixed（2026-11-16，批次 E3）

### F-PAT-049 结构门禁与引用门禁不核对 `textArgs`，声明写错即静默放行

- 位置：`packages/patent/patent-rule/src/runtime/structural-gate.ts:99`–`:105`（取不到声明入参时返回空串）、`:183`–`:185`（空文本直接跳过）、`:128`–`:150`（`strict` 只覆盖规则 id、action 与条目形状）；`packages/patent/patent-rule/src/runtime/citation-gate.ts:70`、`:92`–`:102`
- 维度：E
- 严重度：Medium
- 可能性：低
- 证据：同一脚本。`resolveStructuralGate` 对 `textArgs: ['draft']` 与 `['draftt']` 都返回可用计划，`strict: true` 时也一样。同一份「这里含违规词」的入参：`draft` 命中 1 条 block 违规，`draftt` 命中 0 条，`structuralGateText(args, ['draftt'])` 为 `''`。引用门禁：`textArgs: ['draft']` 对「依据专利法第999条。」返回「《专利法》共 82 条，第 999 条不存在」；`['draftt']` 返回空数组。随包 preset 的两条声明都用 `draft`（`patent.patch.yml:488`–`:504`），与渲染工具当前入参一致，因此今天生效；本条针对的是声明与入参漂移时的失败方向。
- 影响：部署把 `textArgs` 写错，或交付工具改了参数名而声明没有同步，结构门禁与引用门禁都不再判定任何制品，配置里仍显示门禁已启用。制品里的禁止词与不存在的法条可以照常渲染、落盘。
- 最小修复建议：加载期要求 `textArgs` 每项在目标工具的入参 schema 中存在（`apply()` 期间可读工具注册表），`strict` 条目据此报错；运行期 `structuralGateText` 为空且声明了 `textArgs` 时按「门禁无法执行」拒绝，而不是放行。
- 预估工作量：M
- 是否可自动化：是（加载期断言未知入参名；运行期断言空文本触发拒绝）
- 状态：fixed（2026-11-16，批次 E3）

### F-PAT-050 重规划按哈希保留已完成步骤，重复步骤全部判为已完成

- 位置：`packages/patent/patent-workflow/src/plantask.ts:203`、`:208`–`:215`
- 维度：E
- 严重度：Medium
- 可能性：低
- 证据：`pnpm exec tsx d35-repro2.mts` 退出码 0。`syncPlanToTasks(['检索现有技术', '撰写对比表'])` 的 task-1 标为 `completed` 后，`replanTasks(done, ['检索现有技术', '检索现有技术'])` 返回 `preserved: ['task-1', 'task-2']`、`toRun: []`。保留依据是 `hash → 旧任务` 的 Map，同一哈希只留一条；所有同文本的新步骤都读同一条 `completed` 状态。
- 影响：新计划里同一动作出现两次（模型重排后重复生成，或两步共用同一句描述）时，只执行过一次的步骤被记成两次都完成。任务板的 `completed` 与实际产出不一致，`toRun` 为空时调度也不会补派。
- 最小修复建议：按多重集匹配，旧完成任务的同一哈希只能认领一个同文本新步骤；`preserved` 长度不得超过旧任务里该哈希的完成次数。
- 预估工作量：S
- 是否可自动化：是（纯函数夹具：一条已完成、两条同文本新步骤，断言 `toRun` 含第二条）
- 状态：new

### F-PAT-051 沿革快照按条号跨法套用，实施细则条文取到专利法同号条的生效日与状态

- 位置：`packages/patent/patent-law/src/citator.ts:95`、`:136`–`:159`；`packages/patent/patent-law/src/lineage.ts:87`–`:91`；加载点 `packages/patent/patent-law/src/index.ts:201`；快照声明 `packages/patent/patent-law/assets/lineage/cn-patent-law-lineage.yaml:12`
- 维度：E
- 严重度：Medium
- 可能性：高
- 证据：`pnpm exec tsx d36-repro.mts` 退出码 0。用随包索引与随包沿革调用 `lockProvisions(['专利法第22条第3款', '专利法第3条', '专利法实施细则第5条'], baselines, undefined, lineage)`：`专利法第22条第3款` 的 `effectiveDate` 为 `2021-06-01`（沿革第 22 条），`专利法第3条`（不在沿革里）为 `2026-11-14`，`专利法实施细则第5条` 的 `effectiveDate` 同样是 `2021-06-01`，`validityStatus` 为 `active`；`queryValidity({ provision: '专利法实施细则第5条' }, baselines, lineage)` 的理由是「《专利法实施细则》第 5 条经沿革数据确认现行有效」，返回的 `revisionHistory` 是专利法第 5 条的修订史。实施细则资产声明的版本是 `2023 年第三次修订（2024-01-20 施行）`（`assets/law/cn-implementing-regulations.yaml:27`），其真实生效日不是 `2021-06-01`。沿革快照的 `law` 是 `专利法`，`queryArticleLineage(lineage, articleId)` 只按条号取记录，`decideArticleValidity` 也不比较 `lineage.law` 与 `reference.law`。快照覆盖 37 条（2、5、6…77），全部为 `active`。
- 影响：专利法实施细则第 1–82 条中与快照同号的 37 条，一律用专利法同号条的状态、修订史与生效日判定；报告会写出另一个法律的生效日期，理由还声称「经沿革数据确认」。当前快照没有 `revised`/`repealed` 条目，所以可见后果是日期错误；同一路径一旦登记了已修订或已废止的专利法条文，实施细则的同号条文会被一并判为「已修订」或「已废止」，并在 rule-lock 报告里标成 ⚠️已失效。快照未覆盖的专利法条文，以及实施细则中不与快照同号的条文（含第 83–149 条），回落到 `verifiedOn`（例如 `2026-11-14`），报告把它写成「生效」；README:88 已声明该回落是转录日期，但模型看到的报告没有区分。
- 最小修复建议：`queryValidity`／`decideValidity` 只在 `lineage.law === reference.law` 时使用沿革快照；`queryArticleLineage` 增加法律名参数或改由 `Map<LawName, snapshot>` 索引。回落到 `verifiedOn` 时，`renderRuleLockReport` 不要把该日期渲染成「生效」，改写「条文转录核验日」或省略。新增用例：随包专利法沿革下，实施细则第 5 条不得取专利法第 5 条的生效日与修订史。
- 预估工作量：S
- 是否可自动化：是（上面这条断言）
- 状态：new

### F-PAT-052 指南未修改的节在 rule-lock 判「已修订/已失效」，law_verify 判「已核验」

- 位置：`packages/patent/patent-law/src/citator.ts:248`–`:269`（`supersededBy` 与 `hasVersionOverride`）；`packages/patent/patent-law/src/verify.ts:313`–`:330`；`packages/patent/patent-law/src/rule-lock.ts:121`、`:180`；资产说明 `packages/patent/patent-law/assets/law/cn-examination-guidelines.yaml:38`–`:50`
- 维度：E
- 严重度：High
- 可能性：高
- 证据：同一次脚本。指南基础 `sections` 1348 条，`versions` 覆盖 43 条，`staleSections` 6 条；`queryValidity` 对 1241 条判 `revised`，其中 1069 条带已转录正文。`审查指南第二部分第四章3.2.1.1`（创造性三步法）的 `queryValidity` 为 `revised`，理由「所属版本已被2026 年修订版（2026-01-01 施行）取代」；同一引用 `verifyCitation` 为 `valid`，来源写明 2023 年修订版。`第二部分第四章3.2`、`第四部分第三章4.4.1` 同样是一条 `revised`、一条 `valid`。`第二部分第四章6.4` 是 2026 年修改的 43 节之一，两边都判有效。`lockProvisions` 的报告写出「审查指南第二部分第四章3.2：已修订 ⚠️已失效（生效：2026-01-01）」。资产头注明 2026 年对照表登记 27 处修改、6 处改编号、11 个新增节，合计 43 节；其余节仍是 2023 年文本。
- 影响：2026 年修订只改动 43 节，但 citator 在没有 version 覆盖（也没有覆盖其子节）时按 `supersededBy` 把整节判为已修订，于是 1241 节（含创造性三步法 3.2.1.1）在 rule-lock 里标成「⚠️已失效」，同一句引用在 `law_verify` 里却是「已核验」。工作流门禁可能据此阻断现行有效的指南节；模型拿到两个互相矛盾的效力结论，无法判断该信哪一个。报告把 `revised` 一律渲染成「已失效」，对「已修订」的条文也不准确。
- 最小修复建议：把指南版本视图的解析收成一处，`verify.ts` 与 `citator.ts` 共用：不在 `versions` 也不在 `staleSections` 的节按未修改处理（`active`／`valid`），6 条旧路径维持 `unverified`，43 条覆盖路径用 2026 年文本。若产品选择保守语义（2023 文本不再当作已核验），则 `verifySection` 对同样的节也应返回 `unverified`，两边不能继续相反。报告把「已修订」与「已失效」分开，只有 `repealed` 与旧编号路径才写已失效。
- 预估工作量：M
- 是否可自动化：是（3.2.1.1 一条断言：`queryValidity` 与 `verifyCitation` 的结论一致；6 条旧路径仍为未核验）
- 状态：fixed（2026-11-16，批次 E4）

### F-PAT-053 费用工具把单一 `lateMonths` 套到每个年费年度，多年度补缴的滞纳金与事实不符

- 位置：`packages/patent/patent-fees/src/compute.ts:209`–`:215`、`:237`–`:241`；查询字段 `packages/patent/patent-fees/src/types.ts:174`；工具入参 `packages/patent/patent-fees/src/tool/patent-fees.ts:161`–`:164`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。`computeFees(table, { patentType: 'invention', triggers: ['annual-fee'], annuityYears: [4, 5], lateMonths: 3 })` 输出四行：第 4 年度年费 1200.00、第 4 年度滞纳金 3 个月 180.00、第 5 年度年费 1200.00、第 5 年度滞纳金 3 个月 180.00；`total` 为 `{ amount: '2760.00', complete: true, unverifiedIds: [] }`。`annuityLines` 把同一个 `query.lateMonths` 传给每个年度，`latePaymentLine` 按该年度全额年费的 5%／月计价。
- 影响：第 N+1 年度的应缴日比第 N 年度晚 12 个月，第 4 年度超期 3 个月时第 5 年度尚未到期；工具却为第 5 年度也记了 3 个月滞纳金，并把合计标成「全部已核验」。多年度欠费案件无法用单一 `lateMonths` 表达各年度不同的超期月数，按现有接口只能得到一个虚构的滞纳金行或漏掉真实的一行。
- 最小修复建议：把超期改成按年度给出（`lateMonthsByYear` 或 `annuity: [{ year, lateMonths }]`），`patent_deadlines` 的 `latePaymentWindow` 已按年度给出窗口；或在 `annuityYears.length > 1` 且 `lateMonths > 0` 时拒绝计算并列为 `pending`，说明需要各年度自己的超期月数。新增用例：`[4, 5]` 加 `lateMonths: 3` 不得同时给出两条 3 个月滞纳金且 `complete: true`。
- 预估工作量：S
- 是否可自动化：是（上面的用例）
- 状态：new

### F-PAT-054 `designatedMonths` 可覆盖法定期间，驳回决定的 3 个月复审期被缩成 1 个月

- 位置：`packages/patent/patent-deadline/src/deadline-entries.ts:620`–`:629`；校验 `packages/patent/patent-deadline/src/statutes.ts:63`–`:116`（只校验 `stage`，不校验 `designatedMonths` 的适用通知种类）；期间表 `packages/patent/patent-deadline/src/statutes-data.ts:88`–`:137`
- 维度：E
- 严重度：Medium
- 可能性：低
- 证据：同一次脚本。发明案（申请日 2024-01-10）记录一份 `rejection-decision`，电子送达日 2026-01-05，并传 `designatedMonths: 1`。`evaluateDeadlines` 的 `reexamination-request` 条目：`label` 为「请求复审（自收到驳回决定之日起3个月）」，`rawDueDate` 与 `dueDate` 为 `2026-02-05`，`triggerBasis` 末尾是「通知书指定期限 1 个月」。报告表格同时写出「3个月」的标签和 1 个月后的届满日。`fromNotices` 对每种通知书都用 `notice.designatedMonths ?? variant?.months ?? args.months`；驳回决定、授权通知与进入实质审查阶段通知的期间是法定的（专利法第41条、实施细则第60条、第57条），不是通知书指定的。
- 影响：模型或调用方只要给一份没有指定期间的通知书填了 `designatedMonths`，法定期间就被静默改写。复审请求期限被缩短会直接丧失复审权；被延长则让报告显示一个不存在的期限。报告自身还自相矛盾：标签写 3 个月，日期按 1 个月算，起算依据写「指定期限 1 个月」，读者无法判断哪一行是准的。
- 最小修复建议：只允许 `designatedMonths` 用于确由通知书指定期间的种类（`office-action-first`、`office-action-subsequent`、`reexamination-notice`、`invalidation-transfer`）；在 `assertQuery` 或 `toNotice` 里拒绝驳回决定、授权通知与进入实质审查阶段通知携带该字段，并在错误消息里写明对应法定期间。
- 预估工作量：S
- 是否可自动化：是（上例期望 `invalid_query`；四类指定期间通知仍接受该字段）
- 状态：new

### F-PAT-055 上游 JSON 字符串含 null 元素时 `mapPatentData` 抛 TypeError

- 位置：`packages/patent/patent-data/src/mapper.ts:16`–`:22`（`parseJsonArray` 只校验 JSON 与外层数组）、`:27`–`:34`（`extractNames` 直接读 `item[key]`）
- 维度：E
- 严重度：Low
- 可能性：低
- 证据：同一次脚本。`parseJsonArray('[null]')` 返回 `[null]`；把 `inventor_name: '[null]'` 交给 `mapPatentData` 抛 `TypeError: Cannot read properties of null (reading 'inventor_name')`。`parseJsonArray` 的 JSDoc 写「empty or invalid input yields []」，现有用例只覆盖空串、非法 JSON 与非数组（`tests/mapper.spec.ts:37`–`:53`），没有覆盖数组元素为 null 或非对象。
- 影响：nuo 引擎回传的 JSON 字符串里只要有一个 null 元素，整条专利元数据映射就抛错，工具调用失败；同一字段里的其他发明人／受让人、引证与分类也一起丢失。`parseJsonArray` 是包的导出 API，其他调用方拿到未校验的元素后也会遇到同样的读取错误。
- 最小修复建议：`extractNames` 跳过不是非 null 对象的元素；或在 `parseJsonArray` 里按调用方给出的元素校验器过滤，保持导出函数声明的宽容语义。新增用例：`inventor_name: '[null]'` 返回空数组，`'[{"inventor_name":"张三"},null]'` 返回 `['张三']`。
- 预估工作量：S
- 是否可自动化：是（上面两条断言）
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
- **渲染路径的引用门禁是 fail-closed**：`citation-gate.ts:37` 的 `BLOCKING` 含 `not-indexed`、`unverified`、`out-of-range`、`mismatch`，比 `law_verify` 工具的默认策略更严——工具负责让模型看见缺口，门禁负责不让它落盘。`build_patent_filing` 已并入同一门禁（F-PAT-017，批次 E6）。

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

### F-DOC-007 Office 转换成功返回后不检查 abort 监听是否摘掉

- 位置：`packages/document/office-kit/src/queue.ts:184`（`cleanup` 调用 `removeEventListener`）、`:186`（`addEventListener`，`{ once: true }`）、`:303`（成功结束时 `release`，`:214` 调用 `cleanup`）
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：取消、超时和失败分类已有断言。`provider.spec.ts:262` 在引擎超时时删掉临时目录并接受下一次转换，`:310` 取消排队中的调用方且不打断另一路转换，`:403` 在分配资源前拒绝已取消的调用。`provider.spec.ts:237` 拒绝缺文件、目录、非 PDF、不完整 PDF 和超限输出。`queue.spec.ts:173` 起覆盖调用方取消，`:569` 把提供者卸载与调用方取消分开。这些用例在中止发生时结束。`packages/document/office-kit/tests` 里没有 `getEventListeners`，也没有 `listenerCount`。成功读取多半不传信号（`queue.spec.ts:20`）。`legal-law` 的 `baseline.spec.ts:499` 与 `:516` 已经在成功等待后断言监听数为 0，不在本条。
- 影响：删掉 `:184` 的 `removeEventListener` 后，现有取消、超时和成功用例仍然通过。`once: true` 只在 abort 事件发生时摘掉监听。成功返回且调用方没有中止时，监听留在信号上。该信号稍后中止会再次进入 `release`（`queue.ts:205`）。`readers` 计数再次减一，随后按 `maxReaders` 准入时可以多放进一路转换。
- 最小修复建议：加一条成功用例。输入是未中止的 `AbortSignal`，假转换器立即返回 PDF。期望 `read` 成功返回后，`getEventListeners(signal, 'abort')` 的长度为 0；随后中止这个信号，已返回的结果保持成功。删掉 `:184` 的 `removeEventListener` 时监听数断言失败。
- 预估工作量：S
- 是否可自动化：是（假转换器上的一条监听数用例）
- 状态：new

### F-DOC-008 同一模板的 Markdown 只出一个标题，HTML 与 DOCX 出两个一级标题

- 位置：`packages/document/doc-template/src/renderers/markdown.ts:38`；`packages/document/doc-template/src/renderers/html.ts:173`、`:184`；`packages/document/doc-template/src/renderers/docx.ts:23`–`:29`；`packages/document/docx-kit/src/docx-write.ts:75`–`:79`
- 维度：E
- 严重度：Medium
- 可能性：高
- 证据：`pnpm exec tsx d37-repro.mts` 退出码 0。用随包模板与样式构造 `TemplateStore` 后调用 `store.render({ template: 'prd', variables: {} })`：Markdown 的 `content` 只有一行一级标题 `# {{product_name}} 产品需求文档`；HTML 的 `<h1>` 有两个（`产品需求文档` 与 `{{product_name}} 产品需求文档`）；DOCX 投影出两条 `headingLevel: 1`（`# 产品需求文档` 与 `# {{product_name}} 产品需求文档`）。随包模板的正文都以一级标题开头（`disclosure/simplified.md`、`disclosure/standard-9-section.md`、`document/prd.md`、`document/release-notes.md`、`document/report.md`、`document/faq.md`、`document/meeting-notes.md`、`oa-response/*` 等），且都声明了非空 `title`（如 `prd.md:3`）；`disclosure/simplified.md` 的 front-matter 标题是「简化版技术交底书」，正文一级标题是「技术交底书（简化版）」，HTML/DOCX 成品因此出现两个措辞不同的标题；`store.render` 把 `meta.title` 定为 `request.title ?? template.title`（`store.ts:283`）。README:79 只把「正文已有一级标题时不重复注入」写成 Markdown 的行为。
- 影响：同一份模板在 HTML 与 DOCX 成品里出现两个互相竞争的一级标题；正文标题含变量时两行文字还不一样（元数据标题与动态标题）。Markdown 只有一行，三种格式对同一请求给出不同的文档结构；读者或下游转换器会看到重复标题，转换器也可能选错标题。
- 最小修复建议：把 Markdown 的守卫应用到 HTML 与 DOCX（正文以一级标题开头时不注入 `meta.title`），或删掉模板正文的一级标题并统一用 `meta.title`。新增跨格式用例：同一模板分别渲染 Markdown、HTML、DOCX，断言各成品恰有一个一级标题且文字一致。
- 预估工作量：S
- 是否可自动化：是（三格式标题数量的用例）
- 状态：new

### F-DOC-009 DOCX 渲染的 Markdown 表格把转义竖线拆成新列，并把整行破折号当分隔行丢弃

- 位置：`packages/document/docx-kit/src/markdown.ts:99`–`:113`（`isTableSeparator`、`parseTableRow`）、`:142`–`:147`（表格行收集）；`packages/document/docx-kit/src/ooxml.ts:132`–`:140`（按最宽行补空单元格）、`:145`–`:155`（表格组装）
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。输入表格：`| 特征 | 说明 |`、`| --- | --- |`、`| A\|B | 含有竖线 |`、`| - | - |`、`| C | 末行 |`。`parseMarkdown` 得到的行是 `[['特征','说明'], ['A\\','B','含有竖线'], ['C','末行']]`：转义竖线被当成单元格边界，整行破折号被当作分隔行丢弃。`tableXml` 取最宽行 3 列，为其余行补空单元格。同一份 Markdown 交给 HTML 渲染器（`marked`）得到 2 列、3 个数据行，`- | -` 行保留。
- 影响：DOCX 成品表格静默多出一列并少一行数据，HTML 版同一文档却是对的。转义竖线是 GFM 表格的合法写法（单元格要引用正则或「A|B」时常用），整行「-」是常见的「无」占位；两类输入都会让交付表格错位。
- 最小修复建议：按未转义的 `|` 切分单元格（`\|` 还原为字面竖线），只把表头之后紧邻的那一行分隔行当分隔符，之后的全破折号行按数据保留。补这两条解析用例与一条 HTML/DOCX 表格同形的跨格式用例。
- 预估工作量：S
- 是否可自动化：是（上面的表格输入）
- 状态：new

### F-DOC-010 `document_deliver` 的占位符判定不识别 HTML 代码块、注释与属性，代码示例被阻断

- 位置：`packages/document/document-deliver/src/checks.ts:238`–`:270`（`fenceRanges` 与 `quotedRanges` 只认 Markdown 围栏和行内代码）、`:485`–`:499`（`placeholderDrafts` 直接在原始文本上匹配）、`:594`–`:601`（`checkDocumentText` 不区分 HTML 正文与标记）；对照 `:319`–`:360`（`htmlBodyText` 已有 HTML 正文投影，只用于字数预算与空节）
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。Markdown 的 ` ```\n{{case_id}}\n``` ` 得到 `placeholder` 的 `warn`（第 2 行）；HTML 的 `<pre><code>{{case_id}}</code></pre>`、`<code>{{case_id}}</code>`、`<!-- {{case_id}} -->` 以及 `<img src="x.png" alt="[TBD]">` 都得到 `block`。`checks.ts` 的模块注释写明：代码块或行内代码里的占位符只报 `warn`，`block` 只留给引用文本之外的残余占位符。`render_doc_template` 的 HTML 输出会把 Markdown 围栏转成 `<pre><code>`，所以同一份模板内容以 Markdown 交付时是 `warn`，以 HTML 交付时是 `block`。
- 影响：一份合法的 HTML 交付件，只要展示了代码示例、引用了占位符写法，或保留一条编辑注释，就会被 P0 门禁拒绝登记；模型只能删掉示例或改写内容才过。同一内容换成 Markdown 就能通过，门禁结论取决于导出格式而不是文档内容。注释与属性里的文字并不可见，按「残余占位符」阻断与检查范围声明不符。
- 最小修复建议：`format: 'html'` 时先投影可见正文（`htmlBodyText` 已实现注释、标记与 script/style 的剥离），再从 `<pre>`/`<code>` 元素推导引用范围；保留行号映射，或在结果里注明行号对应投影文本。另一种做法是只剥离注释与属性值，并把 HTML 代码元素加入 `quotedRanges`。把上面五个输入补成用例。
- 预估工作量：M
- 是否可自动化：是（五条输入 + 一条 Markdown/HTML 同内容对照）
- 状态：new

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

### F-LEG-010 未核验与未索引引用的工具结果没有锁住处置

- 位置：`packages/legal/legal-law/src/verify.ts:98`–`:99`（`resolveLegalCitationPolicy` 转给共享函数）；工具投影 `packages/legal/legal-law/src/tool/law-verify.ts:210`
- 维度：D
- 严重度：Medium
- 可能性：中
- 证据：判定本身已有断言。`verify.spec.ts:73` 对未转录条文返回 `unverified`，`:83` 对不在索引中的法律返回 `not-indexed`，`:78` 对超范围返回 `out-of-range`。`verify.spec.ts:150`–`:152` 只断言默认常量里 `unverified` 与 `notIndexed` 为 `block`，没有把这两条判定送进 `resolveLegalCitationPolicy`。该函数的现有调用只覆盖 `valid`（`:132`）和 `mismatch`（`:147`）。工具夹具把 `unverified` 与 `notIndexed` 设为 `warn`（`tool.spec.ts:15`–`:16`）。`:102`–`:109` 只断言 `decision` 为 `unverified`，不读 `policy`，也不读 `blocked`。`out-of-range`（`:120`）、`unmatched`（`:129`）、`mismatch`（`:138`）和 `valid`（`:114`）会断言 `policy`。共享函数的六态表在 `packages/law/law-core/tests/citation-tool.spec.ts:29`–`:36` 已锁住，不在本条。
- 影响：把 `verify.ts:99` 改成对 `unverified` 或 `not-indexed` 返回 `allow` 后，上述常量断言、纯函数判定和工具的 `decision` 断言仍然通过。`allow` 与夹具里的 `warn` 都不会把 `blocked` 设为 true，`:102` 看不出来。未核验引用在工具结果里可以被当成放行。
- 最小修复建议：沿用 `verify.spec.ts:73` 的未转录条文和 `:83` 的未索引法律。期望 `resolveLegalCitationPolicy` 在 `DEFAULT_LEGAL_CITATION_POLICY` 下这两条都返回 `block`。再把 `tool.spec.ts:102` 的期望补成 `{ decision: 'unverified', policy: 'warn' }`，并断言 `blocked` 为 false。对不在夹具索引中的法律同样期望 `{ decision: 'not-indexed', policy: 'warn' }`。把 `verify.ts:99` 对这两个判定改成 `allow` 时，默认策略那两条失败；工具投影改成固定 `allow` 时，`policy: 'warn'` 失败。
- 预估工作量：S
- 是否可自动化：是（上述四条期望）
- 状态：new

### F-LEG-011 证人利害关系未填写时，关键规则报「证人与案件无利害关系」通过

- 位置：`packages/legal/legal-evidence/src/evaluators/witness-testimony.ts:90`–`:112`（`LEGAL-EVI-007` 的三分支）；消费点 `packages/legal/legal-evidence/src/engine.ts:80`、`packages/legal/legal-evidence/src/tool/evaluate-evidence.ts:220`–`:235`（摘要只统计 `!passed && severity === 'critical'`）
- 维度：E
- 严重度：High
- 可能性：中
- 证据：`pnpm exec tsx d38-repro.mts` 退出码 0。证人证言输入填写待证事实、证言内容、来源、`collectionLegal: true`、`formLegal: true`、`corroborated: true`，省略 `witnessHasConflict`；`assess` 的 findings 含 `{ ruleId: 'LEGAL-EVI-007', passed: true, reason: '证人与案件无利害关系', severity: 'info' }`，真实性 0.80、等级 `medium_high`。`witnessHasConflict: false` 得到同一条通过项。该分支的条件是 `=== true && disclosed !== true`、`=== true`、其余（含 `undefined`）。同一包的其他关键规则对未填写字段 fail closed：书证 `LEGAL-EVI-001` 用 `!== true`、电子数据 `LEGAL-EVI-004` 用 `!== true`、鉴定意见 `LEGAL-EVI-009`/`010` 用 `!== true`。
- 影响：一项 `critical` 规则在利害关系未知时被报成「证人与案件无利害关系」，摘要因此不计入严重问题；模型或律师会把未核验的证人关系当成已排除，据以采信证言。这是把「不知道」写成「通过」的失败方向；证人未披露利害关系会影响证言证明力。
- 最小修复建议：把三分支拆开：`witnessHasConflict === false` 才报通过；`=== true && conflictDisclosed === true` 报「已披露」；`=== true` 其余报 critical 失败；`undefined` 报未评估（`passed: false` 或新增 `notAssessed`，摘要单列）。新增四条用例：省略、无冲突、有利害关系已披露、有利害关系未披露。
- 预估工作量：S
- 是否可自动化：是（上述四条 findings 断言 + 摘要不计入 severe 的断言）
- 状态：fixed（2026-11-16，批次 E5）

### F-LEG-012 电子数据与证人证言的 `formLegal: false` 在合法性评分中被忽略

- 位置：`packages/legal/legal-evidence/src/evaluators/electronic.ts:27`–`:31`、`packages/legal/legal-evidence/src/evaluators/witness-testimony.ts:27`–`:31`；对照通用实现 `packages/legal/legal-evidence/src/evaluators/base.ts:114`–`:120`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。电子数据的 `formLegal` 省略时合法性 0.85，`true` 时 1.00，`false` 时仍是 0.85，理由行与省略时相同（只写收集程序合法与已记录来源）；证人证言的对应数值是 0.80 / 1.00 / 0.80。通用合法性（`base.ts`）对 `formLegal === false` 减 0.15 并写「形式合法性存疑」。两个类型判定器只处理 `=== true`，`false` 落回未填写路径。
- 影响：调用方明确填写「形式不合法」时，评分与理由与「未填写」完全一致；合法性等级和综合评分偏高，报告不会提这条缺陷。同一字段在通用判定器与两个类型判定器下含义不同。
- 最小修复建议：像通用实现一样处理 `=== false`：扣分并写一条「形式合法性存疑」的理由；扣分幅度与类型体例一致（电子数据与证人证言可各用一档）。新增 `true`/`false`/省略三条评分与理由断言。
- 预估工作量：S
- 是否可自动化：是（三条评分断言）
- 状态：fixed（2026-11-16，批次 E5）

### F-LEG-013 法规检索先取 2 倍上限再按时间效力过滤，SQLite 与内存后端给出不同结果

- 位置：`packages/legal/legal-knowledge/src/legal/search.ts:198`–`:209`（`findByNameFromSqlite` 取 `limit * 2` 后过滤）、`:125`–`:158`（内存路径先过滤全部记录再 `slice`）；`packages/legal/legal-knowledge/src/shared/sqlite-search.ts:50`、`:261`、`:301`（`fetchFactor` 与 SQL `LIMIT`）；`packages/legal/legal-knowledge/src/shared/validity.ts:69`–`:89`（先按上限截断再按效力过滤）；`packages/legal/legal-knowledge/src/judicial-interpretation/search.ts:120` 同用 `fetchFactor: 2`
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：同一次脚本。临时库三条同名记录：`reg-1`、`reg-2` 于 2021 年失效，`reg-3` 无日期（默认 `includeUnverified: true` 可见）。`findByName('民法典', 1, { asOf: '2025-01-01' })`：SQLite 返回 `[]`（取前 2 条均为失效即停止），内存返回 `['reg-3']`（过滤全部记录后取第 1 条）。`search('合同', { asOf: '2025-01-01', limit: 1 })` 两个后端都返回 `[]`；`limit: 10` 时都返回 `['reg-3']`。模型入口 `legal_knowledge_search` 的 regulation scope 走同一个 `legalSearch`，空结果摘要写「本部署的知识库未命中」。
- 影响：请求 N 条可见结果时，只要前 2N 条原始命中被效力过滤掉，就会少返回甚至返回空；法规存在多个失效版本时，现行版本可能落在窗口之外。SQLite 与内存后端对 `findByName` 给出不同集合；模型会把召回窗口造成的空结果读成「本部署未收录」。
- 最小修复建议：把效力过滤放在截断之前：按页/按批读取直到凑满 `limit` 条可见记录或行耗尽，或在 SQL 里直接带效力条件；`searchInMemory` 与 `findByName` 的内存路径也按「先过滤、后截断」统一。新增一条超过窗口的 SQLite/内存 parity 用例（例如 3 条失效 + 1 条可见，`limit: 1`）。
- 预估工作量：M
- 是否可自动化：是（上述 parity 用例）
- 状态：new

### F-LEG-014 法律知识的默认判定日期取 UTC，与中国法域的自然日相差 8 小时

- 位置：`packages/law/knowledge-core/src/validity.ts:38`–`:40`（`todayIsoDate` 用 `toISOString` 的 UTC 日期）；默认值消费点 `packages/legal/legal-knowledge/src/shared/validity.ts:74`（`filterByValidity` 未给 `asOf` 时调用 `resolveAsOf`）；对照 `packages/patent/patent-deadline/src/tool/patent-deadlines.ts:430`–`:438`（同一仓库的期限工具按 `Asia/Shanghai` 读当天）
- 维度：E
- 严重度：Low
- 可能性：中
- 证据：同一次脚本。把时钟固定在 `2026-12-21T19:00:00Z` 后，`todayIsoDate()` 返回 `2026-12-21`，同一时刻 `Asia/Shanghai` 为 `2026-12-22`。效力判定用 `asOf > validTo`、`asOf < validFrom` 比较，因此在中国时间 2026-12-22 的 0–8 点，2026-12-22 生效的法规仍判 `not-yet-effective`，2026-12-21 失效的法规仍判 `in-force`。
- 影响：默认效力结论可能比中国法域的自然日落后一天；同一个法规在一天的 8 小时窗口内会时隐时现。专利期限工具已经按 `Asia/Shanghai` 读「今天」，两个域对同一天的判定不一致。
- 最小修复建议：默认时区改为 `Asia/Shanghai`（或由 `Config` 提供 `timeZone`，与 patent-deadline 同形），并补一条固定在 UTC/中国跨日时刻的用例。显式传入 `asOf` 的路径不变。
- 预估工作量：S
- 是否可自动化：是（固定时钟的跨日用例）
- 状态：new

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
- 修复：`projectSchema` 与 `edlSchema` 经 `lockToInterface` 要求解析字段与 `VideoProject`／`Edl` 一致，校验函数直接返回解析值。可选字段写成 `T | undefined`，与 schema 在 `exactOptionalPropertyTypes` 下的输出一致。只改一边的字段时类型检查失败。`max(3600)` 这类数值界限仍只写在 schema 上。
- 状态：fixed

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

### F-VID-011 预算检查是 check-then-act，同一工程的并发生成可以超额

- 位置：`packages/experimental/video-mode/src/tools/media.ts:382`–`:409`（读账本、比较、放行）、`:410`–`:427`（提交后才写 journal 与账本）；`packages/experimental/video-mode/src/tools/deliver.ts:106`–`:110`（交付时再判一次）；`packages/experimental/video-mode/src/store.ts:233`–`:251`（账本按 `taskId` 去重后整份重写）
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`packages/experimental/video-mode/tests/tools.spec.ts:840`–`:875` 的用例名就叫「lets two generations compare the same ledger and then blocks the next one」。`pnpm exec vitest run packages/experimental/video-mode/tests/tools.spec.ts -t "lets two generations compare the same ledger and then blocks the next one"` 退出码 0，1 passed。两次 `generate` 各自读到同一份空账本、各估 200 minor（2.00 CNY），工程预算 3.00 CNY，两次都提交成功；账本最后有两条，`ledgerCost` 为 4.00；第三次调用才被 `remaining` 挡住。`media` 没有声明 `isConcurrencySafe`，`packages/core/tools/src/pipeline.ts:108`–`:112` 因此把它当 exclusive，单 Agent 的同一批调用会串行；并发来自第二个 Host/Agent 共享同一工作区，或直接调用 `ctx.media` 的服务路径。`appendLedgerEntry` 的 `withKeyLock` 只保护「读—追加—写」，不保护「检查余额—提交—结算」这一段。
- 影响：预算不是预留，而是事后汇总。两个并发付费任务可以在都通过检查后各自提交，实际支出超过 `budgetCny`，超出量取决于并发数与各自的估计额；成片做完后 `video_deliver` 才发现 `reported cost ... exceeds ... budget` 并阻断交付。实验特性，但花的是真实费用。
- 最小修复建议：在账本 `withKeyLock` 内完成「读余额—写入按预留 id 记账的 pending 条目（金额取估计值）」，然后提交；结算时把预留替换为实际 `taskId` 条目，失败时删除预留。若不想引入预留，则在工程级锁里串行化「检查—提交—结算」，并让 `deliver` 与 `generate` 共用同一判定。只把 `remaining` 再读一次不够——两个读者仍会同时通过。
- 预估工作量：M
- 是否可自动化：是（把现有并发用例的期望改为「第二次拒绝」或「总账 ≤ 预算」，并加一条两个 `MediaRuntime`/store 实例共享同一目录的用例）
- 状态：new

### F-VID-012 失效的 journal 记录没有工具侧清理路径

- 位置：`packages/experimental/video-mode/src/tools/media.ts:460`–`:470`（`status` 先 `resume` 再 `refresh`）、`:488`–`:497`（`cancel` 先 `media.cancel` 再 `forgetTask`）；`packages/experimental/video-mode/src/media.ts:859`–`:877`（`resume` 在 provider 未注册、没有 `resume`、拒绝记录时抛错）、`:940`–`:947`（`cancel` 以 `status(taskId)` 开头）
- 维度：E
- 严重度：Medium
- 可能性：中
- 证据：`packages/experimental/video-mode/tests/tools.spec.ts:975`–`:994` 用 `recordTask` 写入一条 `provider: 'ghost'` 的记录，`media status` 抛 `provider "ghost" is not registered`；用例随后直接调用 `forgetTask(created, projectPath, 'ghost-video-1', root)` 手工清掉。`pnpm exec vitest run ... -t "reports a lost task when the journal has no usable record"` 退出码 0，1 passed。工具层只有五个 `forgetTask` 调用点（成功结算、generate 的 failed/cancelled、status 的 failed/cancelled、cancel 成功），都不覆盖 `resume` 抛错；`cancel` 在 `media.cancel` 就因运行时表里没有该任务而抛 `MEDIA_TASK_NOT_FOUND`，走不到 `forgetTask`。
- 影响：provider 被移除、改名，或 journal 记录被 `resume` 拒绝后，记录永久留在 `tasks.json`：每次 `status` 都报同一个错，`cancel` 也失败，studio 的待处理任务列表永远显示它。清理只能手改 `tasks.json`，或在代码里调用 `forgetTask`。
- 最小修复建议：`status` 捕获 `resume` 的不可恢复错误（`MEDIA_PROVIDER_UNAVAILABLE`、没有 `resume` 的 `MEDIA_TASK_NOT_FOUND`、`MEDIA_STORE_INVALID`），把记录标成 failed 并清掉，同时在结果里说明被丢弃的记录；或给 `cancel` 增加「运行时无此任务时仅清 journal」的回退，并提供显式的清理动作。自动丢弃时要保留一条可审计的摘要，避免把「provider 暂时未挂载」当成永久失败静默删除。
- 预估工作量：S
- 是否可自动化：是（复用 ghost 记录用例，断言工具调用后 `readTaskRecords` 为空；再加一条 cancel 清 ghost 记录的用例）
- 状态：new

### F-VID-013 `status` 对 `artifacts: []` 的成功任务照常结算并清 journal

- 位置：`packages/experimental/video-mode/src/tools/media.ts:471`–`:478`；对照 `:441`–`:446`
- 维度：E
- 严重度：Low
- 可能性：中
- 证据：读码。`status` 的两个条件都是 `task.status === 'succeeded' && task.artifacts !== undefined && outputPath !== undefined`，`artifacts: []` 满足；`writeArtifacts` 对空数组循环零次，返回 `{ artifacts: [], captions: [] }`；带 `project_path` 时 `settleTask` 记费用并 `forgetTask`。结果消息只写 `Task ... is succeeded.`，没有 `Wrote`。`generate` 在 `:444`–`:446` 明确拒绝 `written.artifacts.length === 0` 并抛 `MEDIA_ARTIFACT_INVALID`，`status` 没有对应守卫。两处都要求 `outputPath !== undefined`，这是 F-VID-002 的另一半。
- 影响：provider 返回 `succeeded` 与空产物数组时，`status` 会把费用记进账本、清掉 journal，但磁盘上没有产物，也没有错误码；任务在内存里已是终态，journal 已删，无法再恢复。现有 shipped provider 都返回至少一个产物，但 seam 的契约允许空数组，`generate` 已经按失败处理，两个入口应一致。
- 最小修复建议：把终态处理抽成「写产物 → 断言至少一个 → 结算 → 清 journal」，`generate` 与 `status` 共用；`artifacts === undefined || length === 0` 时保留 journal 并抛 `MEDIA_ARTIFACT_INVALID`。结算与清理不再以 `outputPath` 为前置（同时收口 F-VID-002）。
- 预估工作量：S
- 是否可自动化：是（用现有 `providerOf` 桩返回 `succeeded, artifacts: []`，断言工具报错、journal 仍在、账本为空）
- 状态：new

### F-VID-014 项目身份取工具结果里的原始路径，绝对与相对写法会让同一工程出现两次

- 位置：`packages/experimental/video-mode/src/tools/project.ts:167`（`presentationMeta` 发布 `value.path`）、`:186`（只有 `init` 返回 `ctx.fs.processPath`）、`:193`、`:200`、`:207`、`:220`（`read`/`upsert_shot`/`remove_shot`/`record_render` 返回调用方原始路径）；`packages/client/ui-video-studio/src/client/video-projects.ts:72`–`:77`（注释称 Host-resolved）、`:117`–`:121`（按原始字符串去重）
- 维度：E
- 严重度：Low
- 可能性：高
- 证据：`pnpm exec tsx d39-repro.mts` 退出码 0。A 行输出 `[{"path":"/work/video/ep/project.json","seq":3},{"path":"video/ep/project.json","seq":5}]`：`init` 用绝对路径发布一次，`upsert_shot` 用模型传入的相对路径再发布一次，两者指向同一文件。`projectPathOfResult` 的 JSDoc 写的是「the Host-resolved project path」，但只有 `init` 解析。
- 影响：studio 的项目下拉按路径去重，同一生产会出现两个同名选项，客户端重复读取同一文件；模型在多次调用间混用绝对与相对写法（工具说明要求相对路径，`init` 的输出又是绝对路径）时，列表持续增项。工程身份应当只有解析后的绝对路径一种。
- 最小修复建议：每个动作都返回 `ctx.fs.processPath(target)`；`read` 先 `resolve` 再 `processPath`，`mutateProject` 已有 `target`，直接复用。`presentationMeta` 只发布解析后的路径。
- 预估工作量：S
- 是否可自动化：是（Host 侧断言 `read`/`upsert_shot` 的 meta 为绝对路径；客户端加一条「同一文件的相对与绝对路径只产生一项」）
- 状态：new

### F-VID-015 EDL 音频片段的 `inSec`/`outSec` 不校验顺序，校验晚到 ffmpeg

- 位置：`packages/experimental/video-mode/src/edl.ts:39`–`:44`（`audioClipSchema` 只有非负/正数）、`:117`–`:123`（只遍历 `clips` 的 `video` 分支）
- 维度：E
- 严重度：Low
- 可能性：中
- 证据：`pnpm exec tsx d39-repro.mts` 退出码 0。视觉片段 `{ kind: 'video', inSec: 3, outSec: 2 }` 抛 `EDL clip 0: outSec must be greater than inSec`；同一 EDL 的 `audio: [{ source: 'a.wav', inSec: 10, outSec: 5 }]` 通过 `validateEdl`，原样返回。
- 影响：非法音频区间在 EDL 校验阶段被接受，ffmpeg 收到 `atrim=start=10:end=5` 才失败；`assemble` 会先写空占位（目标不存在时），已有目标则被 `-y` 打开，给 F-VID-004 的覆写窗口多一条可达路径。错误码从 `MEDIA_EDL_INVALID` 退化为 `MEDIA_ASSEMBLY_FAILED` 加 ffmpeg stderr。
- 最小修复建议：在 `validateEdl` 的同一循环里校验音频：`inSec !== undefined && outSec !== undefined && outSec <= inSec` 时报 `EDL audio clip N: outSec must be greater than inSec`，错误码 `MEDIA_EDL_INVALID`；补一条反向区间用例。
- 预估工作量：S
- 是否可自动化：是（一条 `validateEdl` 断言）
- 状态：new

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

### F-CROSS-003 知识库安装覆盖时先删输出，改名失败没有用例

- 位置：`packages/law/knowledge-core/src/install-fs.ts:59`（`commitTempSibling`）、`:62`（已有输出时 `rmSync`）、`:64`（随后 `renameSync`）。调用点是 `packages/patent/patent-knowledge/src/install.ts:212` 与 `packages/legal/legal-knowledge/src/install.ts:110`
- 维度：D
- 严重度：High
- 可能性：中
- 证据：`install-fs.spec.ts:70` 把临时文件改到新路径，`:82` 覆盖已有文件并断言新内容与「输出已存在，覆盖」。两条都在 `renameSync` 成功时结束。`install-fs.spec.ts` 里没有 `ENOSPC`、`EACCES` 或让 `renameSync` 抛错的用例。`prepareTempSibling` 会清掉上次留下的临时文件（`install-fs.spec.ts:59`），不读输出文件在改名失败后是否还在。专利安装在 `patent-knowledge/src/install.ts:199`–`:201` 写明，VACUUM 之前直接 `rmSync(output)` 会在失败时丢掉上一份产物，因此先写临时文件；提交仍走 `commitTempSibling`。`packages/law/knowledge-core/README.md` 把这次提交写成原子替换。F-PAT-001 已在其他交付物上收口，不在本条重开。
- 影响：输出已存在时，`:62` 先删掉上一份库，`:64` 再改名。改名因磁盘满、权限或跨设备失败时，错误抛出，已安装的 `knowledge.db` 或 `legal.db` 已经不在，新库仍留在临时路径。现有成功用例继续通过。
- 最小修复建议：在 `install-fs.spec.ts:82` 旁加一条。输出文件内容是 `old`，临时文件内容是 `new`，注入的 `renameSync` 抛出 `code` 为 `ENOSPC` 的错误。期望错误原样抛出，输出文件仍是 `old`，临时文件仍在。当前先删后改名会让这条失败。提交应改为先保留旧文件的改名，与 `packages/fs/fs-local/tests/fsio.spec.ts:828` 在替换失败后仍读到 `old` 的断言对齐。
- 预估工作量：S
- 是否可自动化：是（一条注入改名失败的用例）
- 状态：new

### F-CROSS-004 专利、文档、法律三域的工具错误类没有接入 `HarnessError`，失败码在 `tool/result` 与会话界面丢失

- 位置：`packages/patent/patent-tools/src/error.ts:37`（`PatentToolError`）、`packages/patent/tool-literature/src/error.ts:17`（`LiteratureToolError`）、`packages/document/doc-template/src/types.ts:242`（`DocTemplateError`）、`packages/document/doc-style/src/types.ts:148`（`DocumentStyleError`）、`packages/document/office-kit/src/errors.ts:5`（`OfficeKitError`）、`packages/legal/legal-law/src/tool/law-verify.ts:35`（`LegalLawVerifyToolError`）、`packages/legal/legal-evidence/src/tool/evaluate-evidence.ts:15`（`EvaluateLegalEvidenceToolError`）、`packages/legal/legal-knowledge/src/tool/search.ts:72`（`LegalKnowledgeSearchToolError`）；对照 `packages/experimental/video-mode/src/types.ts:260`（`MediaFailure extends HarnessError`）
- 维度：E
- 严重度：Low
- 可能性：高
- 证据：`pnpm exec tsx d40-repro.mts` 退出码 0。抽样的八个类里只有 `MediaFailure` 的 `instanceof HarnessError` 为 `true`；其余七个的 `instanceof HarnessError` 都为 `false`，其中六个带 `code`（`invalid_tool_input`、`tool_execution_failed`、`asset-invalid`、`unavailable`、`invalid-input` 等），`DocumentStyleError` 只有文案；位置列表里的 `LegalKnowledgeSearchToolError` 未导出，读码确认它同样继承 `Error` 并带 `code`；对四域 `class .*Error extends` 的静态列举显示，没有一个 `*Error` 类以 `HarnessError` 为基类；唯一的 `HarnessError` 子类是 `MediaFailure`。核心只在错误是 `HarnessError` 时把 `{ name, code }` 写进 `tool/result.error`（`packages/core/tools/src/pipeline.ts:690`–`:694`）；`batch.ts:256`–`:263` 只在 `result.error.info` 存在时落事件。`tools.spec.ts:2959` 与 `:2975` 把两条路径分别写成「HarnessError 保留 name/code」与「非 HarnessError 只保留 message」。`tool-office` 还把 `OfficeKitError` 改写成普通 `Error`（`packages/document/tool-office/src/index.ts:289`–`:298`），`RemoteError` 同样不是 `HarnessError`（`packages/typert/protocol/src/remote-error.ts:12`）。会话界面按 `node.error.name: node.error.code` 渲染轨迹（`packages/client/ui-trajectory/src/client/layout.ts:1113`），没有 `error` 时只剩泛化失败。
- 影响：模型看到的仍是 `Error: <message>`，业务结论不受影响；受影响的是 `tool/result` 事件、轨迹界面和按错误码路由的消费者。专利、文献、文档、法律四个域的工具失败在会话记录里只有文案，没有 `name`/`code`；同一类「输入非法」与「服务不可用」在 UI 与遥测里无法区分，域内已经维护的 `code` 到边界处被丢掉，`PatentToolError`/`LiteratureToolError` 的 `details` 也没有进入事件。`AGENTS.md` 要求「Coded errors and expected tool failures use `HarnessError`」，当前只有视频域满足。
- 最小修复建议：让上述工具错误类继承 `@deepseek-ai/dsh-llm` 的 `HarnessError`（`patent-tools`、`tool-literature`、`doc-template`、`video-mode` 已声明该依赖；`doc-style`、`office-kit` 可保留纯库错误，在 `doc-template`、`tool-office` 的工具边界转成 `HarnessError`）。`tool-office` 的 `officeFailure` 保留 `OfficeKitError` 的 `code`，`RemoteError` 在工具边界转成 `HarnessError`。每个域补一条用例：注册一个抛该域错误的工具，断言 `result.error.info` 的 `name`/`code`。若要防回归，可在 `tools/result` 测试里断言「域内工具失败必有 `info.code`」，并把「带 `code` 的 Error 子类必须继承 `HarnessError`」加进静态门禁。
- 预估工作量：M
- 是否可自动化：是（每个域一条工具失败用例；静态门禁可扫 `class .*Error extends Error` 且带 `readonly code` 的声明）
- 状态：new

## E 维度汇总（Day 40）

D34–D40 新增 E 维度编号 29 条，今日追加 F-CROSS-004 一条，共 30 条；严重度分布为 High 6、Medium 18、Low 6。D1–D33 已登记的 E 维度条目（如 F-PAT-001、F-DOC-002、F-LEG-003、F-VID-001）仍按原状态跟踪，不并入本表。

| 主题 | 发现 | 共同失败方向 |
|---|---|---|
| 缺值、未知值或显式 `false` 被当作满足或中性 | F-PAT-040、041、042、045、048、049；F-LEG-011、012；F-VID-013 | 空 quote、无要素、未提取到问题、缺字段、解析不出理由、空产物数组都落到 passed/covered/settled，结果里没有「未评估」 |
| 同一事实两套解析或两次读取 | F-PAT-039、052；F-DOC-008、009；F-LEG-013；F-VID-014 | 两个独立实现、两次读取或两个后端给出不同结论 |
| 持久状态没有对账 | F-PAT-047、050、051；F-VID-011、012、013 | 续跑、重规划、沿革快照、预算与 journal 在写入后不再核对 |
| 法定期限与日期口径 | F-PAT-053、054；F-LEG-014 | 单一参数跨年度套用、可覆盖法定期间、默认 UTC |
| 上游数据形状 | F-PAT-055；F-DOC-009 | null 元素与转义竖线改变解析结果 |
| 校验条件、行级一致性与错误身份 | F-PAT-043、044、046；F-DOC-010；F-VID-015；F-CROSS-004 | 校验条件不一致、回退过宽、同一格重复行，或失败码在边界丢失 |

同一发现可能跨两个主题（如 F-DOC-009），表中的行数不等于编号数。

Day 41 的合并候选：F-PAT-040/041/046（对比表覆盖与行校验）、F-PAT-042/048/049（门禁缺输入）、F-PAT-051/052（沿革与指南修订口径）、F-DOC-008/009（渲染器分叉）、F-VID-011/012/013（终态结算）、F-LEG-011/012（未知值与布尔默认）。F-PAT-039/043/044/045、F-VID-014/015、F-CROSS-004 暂不并入其他条目。

## 修复记录

### 批次 E2：权项引用单一解析（2026-11-16）

用户要求按建议顺序全部修复后完成。`claim-chart` 的引用关系推导与 `claim-lint` 的形式自检改为共用 `claim-lint/references.ts` 的一份解析，删除两套句式、全角数字与区间规则。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-039 | 引用语识别、编号表达式与区间展开收口到 `references.ts`；两处调用方只选择搜索窗口（`claim-lint` 要求引用语位于权项正文开头，`claim-chart` 允许带前缀的引用语落在特征部分、无前缀的引用语限于引言）。句式同时接受 `根据`／`如`／`按照`／`依` 与全角数字。倒序或跨度超过 1000 的区间按可行范围展开，并记入 `ClaimRef.referenceDefects`；`validateClaimRefs` 新增 `reference-range`，`claim_lint` 以 `reference-direction` 报出，不再把这类引用语收成空数组并标为独立权利要求 | `claim-lint/references.ts`（新增）、`claim-lint/parse.ts`、`claim-lint/checks.ts`、`claim-lint/types.ts`、`claim-chart/runtime/claim-refs.ts`、`claim-chart/protocol/types.ts`、`claim-chart/runtime/invalidity-conclusion.ts` |

**行为变化**：`如权利要求 1 所述`、`按照权利要求 1 所述`、`依权利要求 1 所述` 与全角数字引用现在在 `claim_lint`、`domain_check`、`claim-breadth`、`amendment-reserve` 里都判为从属权利要求；`1-35` 正常展开为 1 至 35。倒序或超限区间（如 `3-1`、`1-2000`）仍按端点或升序展开，同时在结论与 lint 报告里留下缺陷；对比表 JSON 的 `claims` 可能新增 `referenceDefects`，旧图表缺少该字段时行为不变。

**既有测试行为**：`claim-refs.spec.ts` 的区间上限用例改为锁定新语义（`1-35` 展开、`1-2000` 只留端点）；`claim-lint.spec.ts` 的 `1 至 999999999` 用例补上 `referenceDefects` 断言。新增两套解析对同一文本的一致性断言、前缀与全角数字用例、lint 的倒序／超限发现用例，以及结论渲染两种区间缺陷的用例。

验证：`pnpm exec vitest run packages/patent/patent-core/tests packages/patent/patent-tools/tests` 通过（203 文件、3977 用例，4 skipped）；五个改动源码文件在聚焦 `--coverage.include` 下均为 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`pnpm run test:snapshot -t patent-invalidation-chain` 通过；`verify-persistence-changes` 无变化。

### 批次 E3：门禁缺输入 fail-closed（2026-11-16）

用户要求按建议顺序全部修复后完成。三条发现都属「输入缺失被读成通过或未评估」，改动只影响缺输入与声明漂移的路径。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-042 | `problem-check` 未提取到技术问题时写 `problem_check_passed: false`，报告改为「本次未执行（不计为通过）」；`legal-gaps` 的 `problem` 检查新增 `notAssessed`。`evaluateCheckpoint` 把「报告写明未执行」放在失败判定之前：没有判定对象的检查记 `not-assessed`，不再记 `failed` 或 `passed` | `patent-core/src/atoms/handlers/builtin/problem-check.ts`、`patent-tools/src/atoms/legal-gaps.ts` |
| F-PAT-048 | `notice` 非空但 `parseOfficeAction` 识别不到驳回理由时，两条双输入规则写入 `dualInputSkipped`，新增 `dualInputNoticeIssue` 写明原因；工具结果显式写「通知书未识别到驳回理由」 | `patent-tools/src/tool/rule-check.ts` |
| F-PAT-049 | `resolveStructuralGate` 增加可选的工具入参读取器，工具已注册时核对每个 `textArgs` 是否为该工具入参，`strict` 条目升级为加载失败；运行期两个门禁在适用条目的制品入参缺失时按「门禁无法执行」拒绝调用 | `patent-rule/src/runtime/structural-gate.ts`、`patent-rule/src/runtime/citation-gate.ts`、`patent-rule/src/index.ts` |

**行为变化**：创造性流程里缺技术问题不再让 A22.3 阻断项显示通过，汇总头把它计入未评估。`rule_check` 收到解析不出驳回理由的通知书时不再输出「无违规」，而是列出 PR-OA-008/009 未评估及原因。结构门禁与引用门禁在 `textArgs` 写错时不判定任何制品：工具已注册时加载期即报告（`strict` 失败），工具尚未注册时（内置 preset 的 `patent-document` 晚于 `patent-rule`）由运行期「声明的入参未提供」拒绝兜底。

**既有测试行为**：`problem-check-atom.spec.ts` 两条「放行并说明原因」用例改为 `problem_check_passed: false` 且报告含「本次未执行」，原断言锁住的正是本条缺陷。`legal-gaps` 的判定顺序调整只影响「报告写明未执行且失败键为 false」的输入，既有证据与受理用例未改写。

验证：`pnpm exec vitest run packages/patent/patent-core/tests packages/patent/patent-tools/tests packages/patent/patent-rule/tests` 通过（230 文件、4510 用例，4 skipped）；五个改动源码文件在聚焦 `--coverage.include` 下均为 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`pnpm run test:snapshot -t patent-` 11 个专利会话全部通过；`pnpm run test:docs` 30 passed。

### 批次 E4：指南效力单一来源（2026-11-16）

用户要求按建议顺序全部修复后完成。采用推荐口径：2026 年修订未改动的节继续按 2023 年文本作为现行条文；`versions` 覆盖的 43 节用 2026 年文本；改号后未被复用的旧路径维持未核验。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-052 | `decideSectionValidity` 删除「`supersededBy` 覆盖即整节已修订」的兜底：不在 `versions` 也不在 `staleSections` 的节判 `active`，与 `verifyCitation` 一致；旧编号路径判 `unverified` 并带 `stalePath`；声明了 `supersededBy` 却没有任何修订记录时失败关闭。`rule-lock` 的 `stale` 只在废止或旧编号路径时为 true，报告把旧路径写成「旧编号失效」，已修订的条文不再标「已失效」 | `patent-law/src/citator.ts`、`patent-law/src/rule-lock.ts`、`patent-law/src/types.ts` |

**行为变化**：`queryValidity` 对 1241 条未修改的指南节（含创造性三步法 3.2.1.1）由 `revised` 改为 `active`，`rule-lock` 不再把它们写成「已修订 ⚠️已失效」。6 条旧编号路径中，编号被 2026 年版复用的 5 条按新节判定，原 4.2.1.3 维持未核验。已修订的法条与指南节保持 `stale: false`。

**既有测试行为**：`citator.spec.ts`、`branches.spec.ts`、`rule-lock.spec.ts` 中把 staleSection 与 `supersededBy` 断言为 `revised` 的用例改为新口径；新增随包资产断言锁住 3.2.1.1、6.4 与 6 条旧路径的结论一致性。

验证：`pnpm exec vitest run packages/patent/patent-law/tests` 通过（15 文件、328 用例）；`citator.ts` 与 `rule-lock.ts` 在聚焦 `--coverage.include` 下均为 100%；`patent-core` 与 `patent-tools` 全量 3974 用例通过（4 skipped）；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`pnpm run test:snapshot -t patent-` 11 个会话通过；`pnpm run test:docs` 30 passed。
### 批次 E5：法律证据 fail-closed（2026-11-16）

用户要求按建议顺序全部修复后完成。两条发现都把「缺输入」或「明确否定」读成通过或中性。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-LEG-011 | `LEGAL-EVI-007` 的四条分支拆开：未填写 `witnessHasConflict` 时产出 `passed: false`、`notAssessed: true` 的发现；仅 `false` 报「无利害关系」通过，`true` 且已披露报「已披露」，`true` 未披露报 critical 失败。`LegalEvidenceFinding` 增加可选 `notAssessed`，摘要与综合推理把它单列为「未评估」，不计入严重问题 | `legal-evidence/src/evaluators/witness-testimony.ts`、`legal-evidence/src/types.ts`、`legal-evidence/src/engine.ts`、`legal-evidence/src/tool/evaluate-evidence.ts` |
| F-LEG-012 | 电子数据与证人证言的合法性判定补上 `formLegal === false` 分支：扣 0.15 并写「形式合法性存疑」，与通用合法性判定的方向一致 | `legal-evidence/src/evaluators/electronic.ts`、`legal-evidence/src/evaluators/witness-testimony.ts` |

**行为变化**：证人利害关系未知时，`evaluate_legal_evidence` 的摘要输出「未评估 1 项」，不再把它当成「无利害关系」通过，也不计入严重问题；工具报告的规则行以「未」标记未评估项。电子数据与证人证言明确填写形式不合法时，同一组已给收集合法与来源的输入里，合法性分数分别由 0.85 降至 0.70、由 0.80 降至 0.65，理由写明形式合法性存疑。

**既有测试行为**：`branches.spec.ts` 的「三种冲突结果」用例补第四条未填写分支；`tool.spec.ts` 新增摘要断言。既有 `witnessHasConflict: false` 的通过断言不变。

验证：`pnpm exec vitest run packages/legal` 通过（23 文件、434 用例）；四个改动源码文件在聚焦 `--coverage.include` 下均为 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`pnpm run test:snapshot -t legal` 通过；`pnpm run test:docs` 30 passed。
### 批次 E6：交付门禁与后台审批（2026-11-16）

用户要求按建议顺序全部修复后完成。两条都在交付路径上：一条让立案构建绕过了引用核验，一条让后台运行绕过了人工审批。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-017 | preset 的 `citationGate` 增加 `build_patent_filing` / `textArgs: ['draft']`，与渲染路径共用同一份引用判定；`structuralGateText` 已递归读取草案对象里的字符串 | `bundle/web-app/presets/patent.patch.yml`、`bundle/web-app/tests/patent-preset.spec.ts`、`patent-rule/tests/citation-gate.spec.ts` |
| F-PAT-018 | `approveStageGates: true` 时，`approveStageIds` 在任何运行方式下都被拒绝，后台运行不再回到「暂停后自报续跑」；后台运行在审批门暂停，需在前台重跑让审批服务取用户决策 | `patent-tools/src/tool/patent-workflow-run.ts`、`patent-tools/src/config.ts`、`patent-tools/tests/patent-workflow-run.spec.ts`、`patent-tools/README.md`／`.zh.md`、`bundle/web-app/presets/patent.patch.yml`、`docs/upgrade-guide/v0.2.2-rc.3/patent-workflow-background-approval/` |

**行为变化**：`build_patent_filing` 的草案出现索引拒绝的引用时，调用在落盘前被拒绝，不再只依赖一次会话内的 `law_verify`。开启审批门的部署里，后台运行带非空 `approveStageIds` 会收到 `invalid_tool_input`；需要审批的后台工作流改在前台重跑。`approveStageGates` 关闭的部署保持原契约。该收紧已写入升级指南。

**既有测试行为**：`patent-workflow-run.spec.ts` 原有一条「审批服务缺失时接受 approveStageIds」用例，断言的正是可被后台绕过的旧行为；现改为拒绝，并新增后台运行同一输入被拒绝的用例。`approveStageGates` 关闭时的放行用例保留。

验证：`pnpm exec vitest run packages/patent/patent-tools/tests packages/bundle/web-app/tests` 通过（127 文件、2359 用例，4 skipped）；`patent-workflow-run.ts` 在聚焦 `--coverage.include` 下为 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`pnpm run test:snapshot -t patent-` 11 个会话通过；`pnpm run verify-cordis-config` 366 个配置通过；`pnpm run verify-upgrade-guides` 通过。

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

### 批次 E1：对比表覆盖与行校验（2026-11-16）

用户确认按 E 维度顺序开始修复后完成。只改 claim-chart 的校验与结论推导，不新增工具参数。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-040 | 源文可读时，计入覆盖的 `literal`／`anticipation`／`literal-construction-dependent` 必须带非空 `quote`；`not-found` 仍可留空 | `claim-chart/runtime/mapping-machine.ts`、`atoms/handlers/builtin/chart.ts` |
| F-PAT-041 | 引用链上的权项没有任何要素时，该路径 `covered` 为 false，并新增 `missingReferredClaims`；结论写「所引权利要求 N 没有要素，不能并入」，不再写「已并入…全部要素」 | `claim-chart/runtime/mapping-machine.ts`、`claim-chart/runtime/invalidity-conclusion.ts`、`claim-chart/protocol/types.ts` |
| F-PAT-043 | 源文可读时空 pin-cite 与格式校验共用同一条件，不再无条件调用 `validatePinCite` | `atoms/handlers/builtin/chart.ts` |
| F-PAT-044 | `segments.size > 0` 且要素的 claimNo 没有对应段落时报错；只有切分结果为空时才回退全文 | `claim-chart/runtime/element-validator.ts` |
| F-PAT-046 | 同一要素与同一目标出现多行时打回重做 | `atoms/handlers/builtin/chart.ts` |

**行为变化**：空 quote 的覆盖行、无段落的 claimNo 与重复行现在打回重做；源文可读的空 pin-cite 不再被误拒；引用链缺要素时的结论文本改写。有效图表与既有快照不变。

**既有测试行为**：`element-validator.spec.ts` 的多 claim 用例原本把第二条权项写在同一行，`splitClaimSegments` 只认行首编号，该输入在新规则下会把第二条权项当成无段落；用例改为换行分隔。`atoms-coverage.spec.ts` 的多 claimNo 用例把第二项要素挂在原文没有的第二条权项上，新规则会判为无段落；用例改用两条权项的原文。两处断言的「多 claim 共存」行为不变。

验证：`pnpm exec vitest run` 的 `patent-core` 全量（1761 用例）通过；五个改动文件在聚焦 `--coverage.include` 下均为 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`pnpm run test:snapshot -t patent-claim-chart` 通过。

### 批次 E9：同义词资产降级写进 `rule_check` 结果（2026-11-17）

用户要求继续修复后完成。只改 `rule_check` 的结果字段与渲染，不改规则判定。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-002 | `loadSynonymsAsset()` 的 `warnings` 并入结果的新字段 `assetWarnings`，渲染时追加「资产警告」行；工具描述说明资产缺失时同义词匹配退化为纯关键词；`RuleCheckDeps` 增加可选 `synonymsAsset` 注入以便断言降级路径 | `patent-tools/src/tool/rule-check.ts` |

**行为变化**：同义词资产缺失或解析失败时，`rule_check` 结果带 `assetWarnings`（此前静默丢弃），模型不再把降级后的判定当成完整资产的结果。资产正常时结果字段不变。

**既有测试行为**：`engine-tools.spec.ts` 新增一条用例注入带警告的资产结果，断言 `assetWarnings` 与渲染文本；`patent-oa-response` 的固定工具 schema 只更新了 `rule_check` 描述一行，其余快照不变。

验证：`pnpm exec vitest run packages/patent/patent-tools/tests/engine-tools.spec.ts packages/patent/patent-tools/tests/drafting-engine.spec.ts` 通过；`rule-check.ts` 聚焦覆盖率 100%；`pnpm run test:snapshot -t patent-` 11 passed；`pnpm run typecheck` 5/5；`pnpm run lint` 0。
### 批次 E7：法条索引名字表复位（2026-11-17）

用户要求继续修复后完成。只改 `legal-law` 名字表的生命周期，不改索引格式与引用判定策略。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-LEG-001 | 每次加载索引前（同步加载、异步加载、`createLegalLawIndex` 首次读清单）把名字表复位为手工索引的四部法，再注册本次索引声明的法律名与标题别名；上一次目录的名字与别名不再残留 | `legal-law/src/baseline.ts`、`legal-law/src/reference.ts` |

**行为变化**：同进程先加载 A 目录、再加载 B 目录时，解析器只识别 B 声明的法律名。A 独有的法律名不再被识别成法条引用，其「第 N 条」片段改由 `unrecognized` 报告，不再因 `not-indexed` 命中默认 `block`；`legalLawNames()` 返回最近一次加载的集合。

**既有测试行为**：`baseline.spec.ts` 新增三条用例（同步加载、异步加载、先后读取两个清单），锁定名字替换与「旧名字退化为未识别片段」的失败方向。

验证：`pnpm exec vitest run packages/legal/legal-law/tests` 138 用例通过；`baseline.ts`、`reference.ts` 在聚焦 `--coverage.include` 下均为 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`verify-translation-pairing` 重录后通过。

### 批次 E8：证据通用规则改由 YAML 驱动（2026-11-17）

用户要求继续修复后完成。只改 `legal-evidence` 通用规则的来源，不改三性评分与类型判定器。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-LEG-002 | `checkGeneralFindings` 改为遍历 YAML 的 `general` 条目：`check` 经固定映射（`hasFactToProve`／`collectionLegal`）取判定函数，`ruleId`、`severity` 取自资产；未知 `check` 在加载期记警告且该条不执行。未加载资产时沿用与随包资产一致的两条默认通用规则 | `legal-evidence/src/engine.ts`、`src/types.ts`、`assets/legal-evidence-rules.yaml` |

**行为变化**：部署修改 YAML 里 `LEGAL-EVI-GEN-001`／`GEN-002` 的 `severity` 现在会改变发现与「严重问题」计数；删除条目即不再执行该通用检查。类型专属规则的 `check` 仍是声明性元数据，判定逻辑位于各类型判定器。

**既有测试行为**：`engine.spec.ts` 新增四条用例（YAML 声明驱动 id/severity、资产不声明通用规则时不执行、未知 `check` 记警告、未加载资产时保留两条默认规则）；`rule-table.spec.ts` 的 YAML↔发现对应断言不变。

验证：`pnpm exec vitest run packages/legal/legal-evidence/tests` 173 用例通过；`engine.ts` 聚焦覆盖率 100%；`pnpm run typecheck` 5/5；`verify-translation-pairing` 重录后通过。
### 批次 E10：DOCX 渲染识别围栏代码块（2026-11-17）

用户要求继续修复后完成。只改 `docx-kit` 的 Markdown 块解析，不改 DOCX 写入结构。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-DOC-001 | `parseMarkdown` 增加围栏状态机：`` ` ``／`~` 三连以上开栏（缩进至多 3 格、信息串丢弃），同字符且不短于开栏的闭栏行结束；栏内每行按原样生成等宽段落 run，`#`／`|`／`**` 不再参与标题、表格或行内解析 | `docx-kit/src/markdown.ts` |

**行为变化**：含围栏代码块的模板与渲染源不再被静默改写——栏内 `#` 行不再变成标题、`|` 行不再拼成表格、`**` 不再变成加粗；行内缩进与行尾空格保留。信息串与围栏标记本身不写入 DOCX，文本投影也不还原围栏。

**既有测试行为**：`markdown.spec.ts` 新增 14 条围栏用例（标题/表格/加粗不再生效、信息串、`~` 栏、闭栏长度、缩进与行尾空格、未闭栏、开栏缩进、表格中断、空行、反引号信息串、短于三连）；`docx-render.spec.ts` 新增一条渲染断言（等宽字体、无标题层级、无表格）。非围栏输入的解析结果不变。

验证：`pnpm exec vitest run packages/document/docx-kit/tests` 153 用例通过；`markdown.ts` 聚焦覆盖率 100%；`pnpm run typecheck` 5/5；`verify-translation-pairing` 重录后通过。

### 批次 E11：视频 journal 与账本改用版本守卫写入（2026-11-17）

用户要求继续修复后完成。只改 `video-mode` 的持久写入与冲突报告，不改工具参数与媒体执行路径。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-VID-001 | 读取时先 `stat` 取版本再读文本，写入改用 `replaceIfVersion`（文件不存在时 `createIfAbsent`）；`FS_STALE_VERSION`／`FS_NOT_OBSERVED` 触发重新读取并合并，连续三次失败以新码 `MEDIA_STORE_CONFLICT` 报告。项目文档的 `mutateProjectFile` 按 `ProjectFileIo` 返回的版本守卫发布；`writeProject` 初始化改为守卫创建。`withKeyLock` 保留为进程内优化 | `video-mode/src/store.ts`、`src/project.ts`、`src/tools/project.ts`、`src/types.ts` |

**行为变化**：两个进程并发追加 journal／账本时，输掉竞争的一方重新读取并合并，不再静默覆盖；持续冲突报 `MEDIA_STORE_CONFLICT`。项目初始化不再覆盖已有项目文件（`FS_NOT_OBSERVED`）。`ProjectFileIo.read` 改为返回 `{ text, version }`、`write` 接收版本，仓库内消费者已同步更新。

**既有测试行为**：`project.spec.ts` 原先靠「读两次比对」模拟并发，现改为假 IO 在守卫写入时抛 `FS_STALE_VERSION`，并新增非冲突写入透传、初始化拒绝覆盖、stat 与读取之间被删除三类用例；`store.spec.ts` 新增 journal／账本竞争合并、守卫创建竞争、持续冲突与删除即缺席用例。测试用 `ctx.fs.writeText` 注入竞争写者，不改产品代码。

验证：`pnpm exec vitest run packages/experimental/video-mode/tests` 276 用例通过；`store.ts`、`project.ts` 聚焦覆盖率 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0；`verify-translation-pairing` 重录后通过。
### 批次 E12：知识库安装改为直接改名提交（2026-11-17）

用户要求继续修复后完成。只改 `knowledge-core` 的提交助手与测试。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-CROSS-003 | `commitTempSibling` 删除 `rmSync(output)`，直接把临时文件 rename 到输出；覆盖日志移到 rename 成功之后，失败时既不丢旧库也不留假日志 | `knowledge-core/src/install-fs.ts` |

**行为变化**：输出已存在时，rename 失败（`ENOSPC`、`EACCES`、跨设备）现在保留上一份 `knowledge.db`／`legal.db` 与临时文件，并把错误原样抛给安装命令；成功路径的覆盖日志文案不变。

**既有测试行为**：`install-fs.spec.ts` 新增一条注入 `renameSync` 抛 `ENOSPC` 的用例，断言旧输出仍为 `old`、临时文件仍在、日志为空。既有成功用例断言不变。

验证：`pnpm exec vitest run packages/law/knowledge-core/tests` 通过；`install-fs.ts` 聚焦覆盖率 100%；`pnpm run typecheck` 5/5；`verify-translation-pairing` 重录后通过。
### 批次 E13：换位审查摘要改称关键词覆盖率（2026-11-17）

用户要求继续修复后完成。只改 `adversary-review` 的摘要与结果标记，不改关键词判定。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-006 | 摘要把启发式数值写成「关键词覆盖率：X%（确定性启发式，非实体论证评估）」；`AdversaryReviewReport` 增加固定 `deterministic: true`；原子输出增加 `adversary_review_deterministic` 并在描述中标明确定性；`computeReviewConfidence` 的 JSDoc 说明该值不是实体论证置信度 | `patent-core/src/adversary/review.ts`、`src/atoms/handlers/builtin/adversary-review.ts` |

**行为变化**：模型与用户不再看到「整体置信度：87.5%」这种伪置信度；摘要明确写出来源与局限，原子结果带 `deterministic: true`。`overallConfidence` 字段保留数值（内部与既有消费者使用），语义改为关键词覆盖率并在类型注释中写明。

**既有测试行为**：`adversary-review.spec.ts` 的摘要断言改为「关键词覆盖率」与确定性限定，并断言不再出现「整体置信度」；原子输出 schema 增加 `adversary_review_deterministic`。`patent-oa-chain` 录制会话刷新一行输出文本，其余片段不变。

验证：`pnpm exec vitest run packages/patent/patent-core/tests/adversary-review.spec.ts packages/patent/patent-core/tests/adversary-branches.spec.ts` 61 用例通过；`review.ts`、`adversary-review.ts` 聚焦覆盖率 100%；`pnpm run test:snapshot -t patent-oa-chain` 通过。
### 批次 E14：`patent-teams` 复用共享原子写（2026-11-17）

用户要求继续修复后完成。补齐批次 A 留下的 F-PAT-003 第 4/4 处。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-003（4/4） | `patent-teams` 删除本地 `replaceFileAtomicOrDirect` 与临时文件写入，`atomicWriteText` 改为委托 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`；共享写入器新增 `createParentDirectories`（默认创建，teams 关闭以保留「团队目录须先存在」）与 `directWriteFallback`（显式退化，保留 Windows 目标被占用时的直接写回） | `patent-teams/src/team-lock.ts`、`atomic-write/src/index.ts`、两包 `package.json`/`tsconfig.json` |

**行为变化**：团队状态写入获得共享实现的能力：`wx` 独占临时文件、文件 fsync、父目录 fsync、Windows 瞬态 rename 重试（指数退避至 8 次）。直接写回仍是显式退化路径，仅在临时文件完整落盘后启用；两个失败以 `AggregateError` 报出。`createParentDirectories: false` 保留原先「团队目录不存在即失败」的语义，避免路径写错时静默建树。POSIX 上不再重试 `EEXIST`/`ENOTEMPTY`（rename 覆盖文件的瞬时占用只在 Windows 场景成立）。

**既有测试行为**：`state.spec.ts` 删除本地 `replaceFileAtomicOrDirect` 的 9 条注入用例（能力已移到共享包），`state-fs-failure.spec.ts` 补两条 `renameWithRetry` 非 Error/无 code 的判定用例；共享包新增 3 条用例覆盖拒绝建父目录、直接写回成功、直接写回也失败。`state-fs-failure.spec.ts` 原有的临时文件清理吞错用例继续通过，因为共享写入器保留同样的清理失败处理。

验证：`pnpm exec vitest run packages/util/atomic-write/tests packages/patent/patent-teams/tests` 112 用例通过；`atomic-write/src/index.ts`、`team-lock.ts` 聚焦覆盖率 100%；README 中英文同步并重录配对。
### 批次 B：失败方向统一（2026-11-17）

用户要求继续修复后完成。批次 B 的同义词警告一项已由 E9 处理，本批收口其余三处：配置不可用不再静默回退，取消不再报成内容问题。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-004 | `loadBrandFromPath` 只在未配置时返回空品牌；配置了但文件缺失/不可读、JSON 非法、顶层或 `documents.patent` 不是对象、值不是字符串时抛 `DocumentRenderError`；`renderPatentDocument` 删除「文件不存在则警告并回退」分支 | `patent-document/src/document/brandInjector.ts`、`renderPatentDocument.ts` |
| F-LEG-003 | 权重声明为非数值、`severity` 声明为非法值时追加加载警告并点明回退值；字段缺省仍静默使用默认值 | `legal-evidence/src/rule-set.ts` |
| F-DOC-002 | 读取失败分支先 `exec.signal.throwIfAborted()`，逐文件循环每轮检查中止；取消以取消错误拒绝，不产出 `unreadable` 报告 | `document-deliver/src/tool.ts` |

**行为变化**：`brandPath` 写错或主题文件损坏会让渲染失败（`invalid_tool_input`），不再静默使用默认品牌；`document_deliver` 在取消后停止读取后续文件并以取消错误返回；证据规则资产的非法 `severity`／权重会出现在 `getWarnings()` 中。

**既有测试行为**：`brand-injector.spec.ts` 把「缺失/损坏返回空品牌」改为四类失败断言；`render-patent-document.spec.ts` 的缺失品牌用例改为期望 `DocumentRenderError`；`branches.spec.ts` 的警告条数从 5 改为 6 并断言新文案。新增取消用例覆盖 `document_deliver` 中途中止。

验证：三个包的测试共 153 用例通过；`rule-set.ts`、`brandInjector.ts`、`renderPatentDocument.ts`、`document-deliver/src/tool.ts` 在聚焦覆盖率下均为 100%；升级指南 `brand-path-must-be-usable` 已创建并重录配对。
### 批次 C：媒体配置单一默认源（2026-11-17）

用户要求继续修复后完成。批次 C 的通用规则 YAML 驱动一项已由 E8 处理，本批收口 `resolveMediaConfig` 的默认值重复。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-VID-005 | `resolveMediaConfig` 改为调用 `Config(config)` 取全部标量默认值，删除 13 个 `??` 字面量；后端段在 spread 前剥离，仅启用时以解析后的 settings 出现；保留 `approvalThresholdCny` 的 finite 校验（schema 的 `min` 让 `NaN` 通过，会让确认门失效） | `video-mode/src/media.ts` |

**行为变化**：Loader 展示的默认值与运行时值来自同一 schema；非法数值的报错改为 schema 的字段化消息（`$.waitMs expected number >= 1 but got -1`）。`approvalThresholdCny: NaN` 仍以明确错误拒绝。

**既有测试行为**：`media-runtime.spec.ts` 的非法边界用例改为匹配字段名；新增一条「13 个标量默认值等于 `Config({})`」的护栏用例；`siliconflow.spec.ts` 补一条省略 `apiKey`/`pollMs` 时的默认值用例。

验证：`pnpm exec vitest run packages/experimental/video-mode/tests` 268 用例通过；`media.ts` 聚焦覆盖率 100%；`pnpm run typecheck` 5/5；`pnpm run lint` 0。
### 批次 D：plantask 单进程契约显式化（2026-11-17）

用户要求继续修复后完成。批次 D 的 legal-law 名字表复位与视频持久写入已分别由 E7、E11 处理，本批收口 plantask 的进程内状态语义。

| 发现 | 处理 | 文件 |
|---|---|---|
| F-PAT-011 | README 已声明「挂起计划与轮次计数器只在服务实例内、重启丢失、会话事件不回读」，本批在 `approve`／`reject` 的 JSDoc 写明重启后的失败方式，并新增「重启后服务不恢复挂起计划」用例锁定该契约 | `patent-workflow/src/index.ts`、`tests/service.spec.ts` |

**行为变化**：无运行时行为变化；契约由文档与用例明确。重启后的 `approve`／`reject` 继续报「no pending plantask」，与原实现一致。

**既有测试行为**：`service.spec.ts` 新增一条重启模拟用例（旧 service 停等后销毁，新 service 上决策失败）；既有「重复决策」用例不变。

验证：`pnpm exec vitest run packages/patent/patent-workflow/tests/service.spec.ts --coverage --coverage.include=packages/patent/patent-workflow/src/index.ts` 22 用例通过，`index.ts` 覆盖率 100%。

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
| OBS-008 | `benchmarks/` 的 9 个目录都是会话、折叠、终端与浏览器重连，没有专利域用例 | C 维度不能从现有性能门禁读到冷启动、单次工具或全流程基线；Day 20 改用一次性本地脚本测确定性路径，模型与网络未计入 | 专利域若要进持续门禁，应在 `benchmarks/` 加一条用户路径，审阅脚本不留在仓库里。Day 21 已用一次性脚本测本地缓存和 `knowledge-lite.db`，检索网络与 PDF 仍未计入。Day 22 用一次性脚本测了团队状态文件、邮箱和一次运行结果落盘，模型耗时未计入。Day 23 用一次性脚本测了文书渲染、输出读取和拷贝，LibreOffice 引擎未启动。Day 24 用一次性脚本测了法律域合成库、法条按需加载和证据规则解析，模型与网络未计入。本机默认查询库不存在。Day 25 用一次性脚本测了视频轮询睡眠、桩下载、参考图读入编码、工作室串行 stat、进程内锁，以及用睡眠脚本代替 ffmpeg 的取消，模型与云端网络未计入，真实 ffmpeg 未启动。Day 26 用一次性脚本测了共享子进程的取消宽限、16 路立即退出和 spill 目录，模型与网络未计入；真实 ffmpeg、Chrome、Python、Inkscape 与 LibreOffice 未启动 | new |

## 记录规则

- 安全发现写清"谁在什么条件下能访问什么资源"。
- 精简发现写"位置—删什么/换什么—预期净减少的复杂度或代码量"。
- 优化发现必须附证据；没有证据的只标为"可选观察"。
- 测试缺口写具体用例：输入、期望行为、边界或错误路径。
- 疑似密钥只记文件、行号、类型和"已脱敏"，不写明文。
