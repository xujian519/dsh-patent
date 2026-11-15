# 仓库结构地图

本页只写结构，不写发现。四域代码通过 Cordis 插件组合进 `dsh` profile；每个包声明自己的服务、工具或纯库导出。

## 技术栈

- 语言：TypeScript（ESM，`"type": "module"`），Node `>=24.9.0`，pnpm 11.28.5。
- 运行时架构：Cordis 全插件式 Agent Harness；服务通过 `ctx` 暴露，工具注册在 `ctx.tools`，事件使用声明合并。
- 构建：`tsc` 产出类型，`tsdown` 打包运行时；Web 前端由 Vite 构建。
- 测试：Vitest 4，单元测试与快照测试分配置；CI 覆盖率门禁为 `packages/*/*/src` 每文件 100%。
- 静态检查：oxlint（类型感知），`pnpm run duplication` 做跨文件克隆检测，`pnpm run doc-sync` 做文档门禁。

## 四域包表

| 域 | 包 | 角色 | `ctx` key |
|---|---|---|---|
| 专利域 | `patent-data` | nuo/CNIPR 检索 provider 与 ego-browser 子进程 | `patentData` |
| 专利域 | `patent-knowledge` | `knowledge.db` 的 FTS、法条、wiki、知识图谱查询 | `patentKnowledge` |
| 专利域 | `patent-core` | 纯专利领域库：ModelPort、atoms、checker、claim-chart、证据、推理 | — |
| 专利域 | `patent-workflow` | workflow / flexible-plan / plantask 状态机与 HITL 审批 | `patentWorkflow` |
| 专利域 | `patent-tools` | 模型可见专利工具集 | `ctx.tools` |
| 专利域 | `patent-teams` | 多 Agent 团队、任务板、邮箱 | `patentTeams` |
| 专利域 | `patent-rule` | 规则引擎、合规资产、`tools/post-execute` 输出门禁 | 策略插件 |
| 专利域 | `patent-document` | 专利文档渲染、品牌注入、PDF | `ctx.tools` |
| 专利域 | `patent-filing` | CNIPA 立案组装、DOCX 构建、格式与内容断言 | `ctx.tools` |
| 专利域 | `patent-deadline` | 期限算术、送达日、节假日顺延 | `ctx.tools` |
| 专利域 | `patent-law` | 法条索引与引用核验 | `ctx.tools` |
| 专利域 | `patent-fees` | 费用索引与定价 | `ctx.tools` |
| 专利域 | `patent-index-asset` | 法条与费用索引的资产格式 | 纯库 |
| 专利域 | `writing-patterns` | 写作范式语料、选择、`<writing_skills>` 编译、质量评分 | `ctx.tools` + section |
| 专利域 | `methodology` | TRIZ 40 原理与矛盾矩阵 | section + tool |
| 专利域 | `tool-literature` | arXiv/OpenAlex/Semantic Scholar/Crossref 连接器 | `ctx.tools` |
| 文档模式 | `document-deliver` | `document_deliver` 交付记录 | `ctx.tools` |
| 文档模式 | `docx-kit` | Markdown 到 DOCX、DOCX 文本读取 | 纯库 |
| 文档模式 | `doc-template` | 中文模板渲染为 Markdown/HTML/DOCX | `ctx.tools` |
| 文档模式 | `doc-style` | 语气、文风、反模式、免责声明模型 | 纯库 |
| 文档模式 | `office-kit` | LibreOffice 授权转换、队列、缓存 | `ctx.officeKit` |
| 文档模式 | `tool-office` | `office_render`/`office_convert`/`office_recalculate` | `ctx.tools` |
| 法律模式 | `legal-knowledge` | 判例、法规、司法解释、指导性案例查询 | `legalKnowledge` |
| 法律模式 | `legal-law` | 法条索引与引用核验 | `ctx.tools` |
| 法律模式 | `legal-evidence` | 证据三性评分 | `ctx.tools` |
| 法律模式 | `law-core` | 法条引用机制 | 纯库 |
| 法律模式 | `knowledge-core` | 知识库查询机制 | 纯库 |
| 视频模式 | `video-mode` | `ctx.media`、项目文档、EDL、四个工具 | `ctx.media` + `ctx.tools` |
| 视频模式 | `video-bundle` | 视频预设、技能、Web studio 的组合层 | 组合包 |
| 视频模式 | `ui-video-studio` | Web 客户端视频工作台 | 客户端插件 |

## 入口点

- CLI：`apps/cli` 提供 `dsh` 与 `dsh web`；profile 由 `packages/boot` 与 bundle 组合。
- Web：`apps/web` 前端，`dsh web` 提供 Host 服务。
- 桌面：`apps/desktop` Electron 壳。
- 四域组合入口：
  - 专利模式：`packages/bundle/web-app/presets/patent.patch.yml`。
  - 文档模式：`packages/bundle/web-app/presets/document.patch.yml`。
  - 法律模式：`packages/bundle/web-app/presets/legal.patch.yml`。
  - 视频模式：`packages/experimental/video-bundle/presets/video.patch.yml`。

## 认证与凭据

- 凭据抽象在 `packages/credentials`：凭据引用、记录、环境变量覆盖 `.env`、需要人工确认的授权流程。
- 四域的外部凭据：DeepSeek API key；nuo/CNIPR 的浏览器会话；MiniMax、SiliconFlow、ComfyUI 的 API key 或本地地址。
- 专利检索通过 `patent-data` 的 ego-browser 子进程与 CNIPR 脚本执行，不持有独立 MCP 桥。

## 数据存储

- 专利与法律知识库：`knowledge.db`（SQLite FTS5），由 `patent-knowledge` 与 `legal-knowledge` 查询；`knowledge-core` 提供共享查询机制。
- 会话：JSONL 持久化，事件日志是模型可见内容的权威记录。
- 视频项目：`video/<id>/project.json`，带任务 journal 与预算账本。
- 专利缓存：`patent-data` 的检索缓存。
- 文档交付：`document-deliver` 把交付文件、格式与质量门禁状态写入会话日志。

## 外部依赖

| 依赖 | 使用方 | 失败时的可见行为 |
|---|---|---|
| DeepSeek API | 四域的模型调用 | 请求失败或超时 |
| nuo-patent / CNIPR | `patent-data` | 检索失败、回退或报错 |
| OpenAlex / arXiv / Crossref / Semantic Scholar | `tool-literature` | 单个源失败 |
| LibreOffice | `office-kit` | 转换不可用 |
| ffmpeg / ffprobe | `video-mode` | 渲染或探测失败 |
| ComfyUI | `video-mode` 本地 provider | 本地任务失败 |
| MiniMax / SiliconFlow | `video-mode` 云 provider | 云端任务失败或计费异常 |

## 测试与 CI

- 测试命令：`pnpm run test`、`pnpm run test:coverage`、`pnpm run test:e2e`、`pnpm run test:snapshot`、`pnpm run test:web`。
- 覆盖率：`vitest.config.ts` 对 `packages/*/*/src` 设 `perFile: true`、语句/分支/函数/行均为 100%；存在按平台与重套件的豁免机制。
- CI：`.github/workflows/ci-fork.yml` 的 `node-checks` 运行 typecheck、lint、duplication、专利 OAS gold、单元测试、`test:docs`、模块图与客户端域图；另有 built-suites、snapshots、web-snapshots、hygiene、coverage、benchmarks、python-checks 等 lane。

## 四域数据流（结构级）

```text
用户/模型
  → 预设（patent/document/legal/video）
  → 模型可见工具（ctx.tools）
  → 领域服务（patentData/patentKnowledge/patentWorkflow/patentTeams/officeKit/legalKnowledge/media）
  → 纯库与共享机制（patent-core/law-core/knowledge-core/docx-kit/doc-style）
  → 外部系统（检索源/Office/ffmpeg/云 provider）
  → 会话日志、项目文档、交付记录
```

## 专利域核心数据流（Day 2）

- `patent-tools`：`src/index.ts` 的 `apply` 调 `registerPatentTools(ctx, config)`（`src/wiring.ts`）。注册 37 个模型可见工具与 9 个本包 atom；读取 `agentDefaultModel`、`llm`、`attachments`、`patentKnowledge`、`patentData`、`writingPatterns`、`jobs`、`approval`、`subprocess`、`webServer` 十个服务。
- `patent-core`：无 ctx 依赖的引擎与契约库；`PatentModelPort` 在 `model-port.ts`；持久化与路径在 `persist-utils.ts`/`paths.ts`；工作流契约在 `workflow/`。它不是无副作用库，含文件读写与资产加载。
- `patent-workflow`：`PatentWorkflow` 服务；`runWorkflow` 追加 `patent/workflow-run`/`patent/evidence-ledger`/`patent/legal-gaps`；`runPlantask` 驱动 `planning → awaiting_approval → executing → awaiting_feedback → replanning → finished`，审批走 `ctx.get('approval')`，缺失时 fail closed。
- 模型调用：6 个 LLM 消费工具经 `loggedToolModel` 追加 `patent/model-call`；端口由 `buildModelPort` 从 Config 或部署默认路由构造，缺配置时 fail loud。
- 外部 I/O：`ctx.subprocess`（Graphviz/Inkscape/FreeCAD）、`ctx.patentData`（CNIPR/ego-browser/PDF）、LLM 流、workbench 回环 HTTP；文件写入覆盖附图、索引、笔记、案卷日志与 `data/cases/<caseId>/outputs`。

## 专利域外围数据流（Day 3）

- 资产与算术：`patent-rule`（`assets/rules/`，挂 `tools/post-execute` 门禁）、`patent-law`（`assets/law/` 与 `assets/lineage/`）、`patent-fees`（`assets/fees/`）、`patent-deadline`（`assets/work-calendar/`，加载期校验）、`writing-patterns`（`assets/patterns/`）、`methodology`（TRIZ JSON 资产）。
- 文档与立案：`patent-document` 用模板 HTML + 品牌变量 + `ctx.subprocess` 渲染；`patent-filing` 用 `申请文件模板.docx` + `申请文件.json`，并用 `unpackedFsPath` 处理 ASAR 解包。
- 知识、检索与团队：`patent-knowledge` 只读打开 `knowledge.db`；`patent-data` 用 `ctx.subprocess.spawn` 跑 ego-browser 与 CNIPR 脚本；`patent-teams` 用 `ctx.subagents` spawn 成员，状态在 `team.json` 与 `inbox/`；`tool-literature` 经 `globalThis.fetch` 访问四个文献源。
- 失败可见行为：`patent-deadline` 日历缺失使部署失败；`patent-knowledge` 库缺失或版本不符抛错；`patent-rule` 同义词缺失降级为关键词匹配并警告。

## 文档/法律/共享域数据流（Day 4）

- 文档模式：`office-kit` 用 `@deepseek-ai/libreoffice-kit` + `ConversionQueue` + `OutputStore` + scratch 清扫；`docx-kit` 是纯字节 ZIP/OOXML 库；`doc-template`/`doc-style` 读 `assets/` 并投影；`document-deliver` 用 `ctx.fs.readBytes` + `extractDocxText` 做交付门禁；`tool-office` 注册 render/convert/recalculate 三个工具。
- 法律模式：`legal-law` 用 `assets/law/` 与 `law-core` 决策，默认 `unverified` 为 `block`；`legal-evidence` 用 `assets/legal-evidence-rules.yaml`，缺资产 fail loud；`legal-knowledge` 提供 `ctx.legalKnowledge` 与显式安装。
- 共享机制：`law-core` 是引用机制纯库，`knowledge-core` 是 FTS/查询机制纯库；legal 直连，patent 经 `patent-core` 再导出。

## 视频模式数据流（Day 5）

- `video-mode`：`ctx.media` 注册合成、ComfyUI、MiniMax 视频、MiniMax 语音与 SiliconFlow 五类 provider；项目文档在 `video/<id>/project.json`，任务 journal 在 `tasks.json`，预算账本在 `budget.json`；EDL 经 `edl.ts` 校验后由 `ctx.subprocess` 调 ffmpeg。四个工具为 `media`、`video_project`、`video_assemble`、`video_deliver`。
- 预算与账本：`media generate` 提交前比较 `max(projectCost, ledgerCost)` 与剩余预算；非 CNY 估算或超过审批阈值要求 `confirm_cost`；账本按 `taskId` 幂等，按“分”累加。
- 并发：`withProjectLock` 是进程内锁；`mutateProjectFile` 用读后重试三次检测跨进程写入，冲突抛 `MEDIA_PROJECT_CONFLICT`。
- `video-bundle`：`src/index.ts` 为纯导出；组合在 `cordis.patch.yml` 与 `presets/video.patch.yml`，挂载 `video-mode` 与 `skills/video` 下六个技能。
- `ui-video-studio`：通过 `workspaceFiles` Remote 只读 `project.json`/`budget.json`/`tasks.json`；对话节点从 `video_project` 结果元数据收集项目路径，`media` 结算提升 revision。

## 结构风险面（只列位置，不下结论）

- 大包：`patent-tools`（约 4.05 万行）、`patent-core`（约 3.26 万行）承载最多逻辑，边界最容易渗透。
- 子进程与脚本：`patent-data` 的 CNIPR/ego-browser 路径、`office-kit` 的 LibreOffice 路径、`video-mode` 的 ffmpeg 路径。
- 外部 provider：`video-mode` 的四个云/本地 provider、`patent-data` 的检索 provider、`tool-literature` 的四个文献源。
- 持久化：`knowledge.db`、会话 JSONL、`video/<id>/project.json`、专利缓存、交付记录。
- 组合层：四个 preset 手工列包，新增或改名包时容易漂移。
- 专利域进程内状态：`patent-workflow/src/index.ts` 的 `pending` 与 `rounds` 是内存 Map，重启不恢复。
- 专利域默认路径：`patent-tools/src/wiring.ts` 的笔记、索引与附图输出默认基于 `process.cwd()`。
- 资产定位：`patent-rule`/`patent-law`/`patent-fees`/`patent-deadline`/`writing-patterns`/`methodology` 用包内 URL 直接读；只有 `patent-filing` 显式处理 ASAR 解包，`patent-document` 尝试两种候选路径。
- 失败方向：`patent-rule` 同义词缺失降级，`patent-deadline` 日历缺失 fail loud，`patent-knowledge` 库缺失或版本不符 fail loud。
- 视频并发：`video-mode` 的项目写入是进程内锁 + 读后重试，跨进程冲突不是文件锁。
- 视频恢复：ComfyUI/MiniMax/SiliconFlow 实现 `resume`，合成 provider 没有。
