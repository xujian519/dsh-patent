# Agent Note: 文档模式预览与规模优化

Status: proposed

[English](2026-11-02-document-mode-optimization.md) | 中文

## 问题

文档 preset 服务的交付管线在最终文件登记之前，中间工作对整个用户不可见：brief → 大纲 → 分章撰写 → 渲染 → 质量门 → `document_deliver` → `turn/end`。工作室标签（`ui-document-studio`）已经通过 `write`、`edit` 与可变的 `str_replace_editor` mutation 折叠出交付物列表，工作稿一写盘就进入该列表；缺口在于生成过程中用户看不到、也跟不上它们。另一个独立问题是渲染工具在每次写盘时仍把整篇文档回灌模型上下文，而长报告根本没有章级文件。

四个缺口，按影响排序：

| 缺口 | 证据 | 后果 |
|---|---|---|
| 生成中工作稿不可见 | 自动切换只响应成功的 `document_deliver`（`auto-switch.ts` 的 `hasDeliverRegistration`）；工作室只在选中项变化时读一次文件（`StudioView.tsx` 的 `selectedPath` effect），没有文件版本依赖 | 交付前用户看不到任何东西；文件被重写后预览仍是旧内容 |
| 单次模板渲染把全文回灌模型 | 即使传了 `output_path`，`writeRenderedDocument` 仍把 `content` 与 `markdown` 留在工具结果里；`.docx` 还会带 base64（`render-doc-template.ts`） | 一篇两万字的报告会让会话后续每个请求多背两万字符 |
| 长文没有章级产物 | `document-report` 要求按章撰写，但落盘仍是一份 `report.md` 加一份 `report.html` | 没有可逐章查看、逐章完成、被跟随的中间文件；模型整篇重写终稿 |
| 预览止步于文本头加 HTML iframe | `.md` 按纯文本显示；`.html` 只读默认 2 MiB 的 byte window，更大的页面被截断；`.docx` / `.pptx` / `.pdf` 只能转侧栏 | 5 MB 的 Markdown 只能看到开头，大 HTML 渲染成半截页面 |

2026-11-02 的调研文档建议通过侧栏 watch 产品化、compaction 改动与新会话事件解决前三项。当前代码显示归属不同：侧栏已经跟随 `file` Resource 的 metadata 刷新，spill 已经挂在 base bundle，预览已经从磁盘读取而不是读被裁剪的工具结果。这个修正重要，因为产物协议会新增一个包，而路径约定与现有工具调用已经携带所需事实。

### 审计范围与输入

本文以当前仓库代码为准，而非只核对调研文档。外部产品机制（OpenHands 的 mutation counter、Claude Code 的同 URL 原地更新、Quarto 的保存即重渲染、Milkdown 的渐进式 Markdown、AI SDK 的同 ID 对账、Continue 的产物上传）沿用调研文档 2026-11-02 的检索记录，本文不重复核验；凡与本仓库代码冲突，以代码为准，分歧记入“曾考虑的替代方案”。

阅读面：

- `packages/client/ui-document-studio/`——工作室视图、交付物折叠、自动切换、预览读取
- `packages/client/ui-sidebar-documentpreview/`——侧栏预览、`autoRefresh`、Markdown / HTML / Office / PDF 渲染
- `packages/api/workspace-files/`——有界读取、分页、`changes` 文件观察、`file` Resource
- `packages/document/doc-template/`——`render_doc_template` 的写盘路径与结果渲染
- `packages/document/document-deliver/`——登记、确定性核验、结果元数据
- `packages/bundle/web-app/presets/document.patch.yml` 与 `packages/bundle/web-app/skills/document/*`
- `packages/compaction/compaction-tool-result-pruner/`、`packages/spill/*`
- [文档交付工作室](../../implemented/feature/2026-08-23-document-delivery-studio.zh.md)、[文档模式工作台](2026-08-23-document-mode-workbench.zh.md)

### 当前交付时序

```text
User request
  └─ document preset starts
      ├─ document-brief        → writes brief.md (if the skill follows through)
      ├─ outline               → usually only in chat, not written
      ├─ writing               → one write produces report.md (or index.html)
      ├─ rendering             → render_doc_template, or hand-written HTML
      ├─ document-quality-gate → model self-check
      ├─ document_deliver      → registers files, format, P0/P1, machine verification
      └─ turn/end
            └─ ui-document-studio sees a successful registration → setActiveView('document')
```

已确认的事实：

- 交付物折叠已经通过 `document-deliverables.ts` 的 `mutationPath` 包含 `write` / `edit` / 可变 `str_replace_editor` 路径。`brief.md` 与 `report.md` 在写盘成功的那一刻就进入工作室列表。
- 自动切换只响应成功的 `document_deliver` 结果，且可能发生在最终回复仍在流式输出时。
- 工作室预览在 `selectedPath` 变化时读一次；它不订阅文件版本，也不调用 Resource。
- 侧栏预览由 `file` Resource 的 metadata 变化驱动（`TextPreview.tsx`）；工作室没有接这条链路。
- `workspace-files` 已有文件观察（`changes.ts`），`file` Resource 已经处理订阅共享、重连、缺失文件继续观察与绝对路径归一化。
- spill 已挂在 base bundle；pruner 只在 compaction 压力下运行。两者都不解决“渲染结果低于 spill 阈值却仍回灌全文”的问题。
- 预览通过 `workspaceFiles.readBytes` 从磁盘读取，因此被裁剪的工具结果永远不会成为预览内容。

### 代码证据

| 事实 | 位置 | 影响 |
|---|---|---|
| 产物列表来自 mutation 加登记 | `ui-document-studio/src/client/document-deliverables.ts`（`mutationPath`、`producedFromTimeline`） | 工作稿在交付前就已列出；问题是可见性与刷新 |
| 自动切换只认 `document_deliver` | `ui-document-studio/src/client/auto-switch.ts`（`hasDeliverRegistration`） | 质量门之前工作室不接管屏幕 |
| 切换发生在登记结果 | `ui-document-studio/src/client/index.ts`（`preset auto-switch`） | 用户可能还没读完交付摘要就被切走 |
| 预览只读一个默认 2 MiB 的 byte window | `ui-document-studio/src/client/file-reads.ts` | 大 HTML 被截断后仍进 iframe |
| 预览只依赖 `selectedPath` | `ui-document-studio/src/client/StudioView.tsx` | 文件被重写后不刷新 |
| 选中项固定在 `produced[0]` | `ui-document-studio/src/client/StudioView.tsx` | 新章节不会自动进入预览 |
| Markdown 按纯文本渲染 | `ui-document-studio/src/client/StudioView.tsx`（`isTextPreviewable`） | 工作稿可读性差 |
| `render_doc_template` 写盘仍回全文 | `doc-template/src/tool/render-doc-template.ts`（`renderDocumentResult`、`writeRenderedDocument`） | 单次调用把整篇文档塞进后续每个请求 |
| `.docx` 的 base64 只在结果值里 | 同上；`skills/document/document-word/SKILL.md` 第 4 步 | 技能教模型解码 `content`，模型实际只看到渲染后的 markdown |
| 空状态探测只认成品扩展名 | `ui-document-studio/src/client/workspace-probe.ts`（`DELIVERABLE_EXTENSIONS`、`MAX_DEPTH`） | `chapters/*.md` 仍按工作稿列出；探测不承担章节进度 |
| `file` Resource 提供 live metadata | `workspace-files/README.md` § client file resources | 工作室可以拿到版本变化，无需自建第二条 watch 流 |

## 提案

四个用户可见目标，分三个阶段交付：

1. **写盘即出现。** 任何写盘的工作稿都出现在工作室列表，不需要等登记。
2. **写盘即刷新。** 已选中的文件被重写后，预览在一秒内更新，用户不需要重新点选。
3. **跟随当前章节。** 新写出的章节文件成为选中项；用户可以暂停跟随。
4. **交付前可读。** Markdown 渲染为排版文本，HTML 完整渲染或明确转侧栏，二进制格式转侧栏。

原则：

- **磁盘是内容事实源。** 会话日志记录谁写了什么、声明了什么；预览永远从磁盘读当前字节。
- **日志是声明事实源。** 章节、成品与质量门都从已记录的 `tool/call` / `tool/result` 派生；新增模型可见输入时优先用工具调用，不新增会话事件类型。
- **预览与 compaction 分离。** 被裁剪的工具结果永远不作为预览来源。
- **显式优先。** 写盘路径、格式与篇幅预算由调用方显式给出；不在 `run()` 里隐藏默认值。
- **失败可见。** 文件不存在、预览过大、读失败、跟随暂停，都要有本地化提示，不静默退回。
- **不引入生成中整文流。** 章级文件加文件观察已经覆盖“边写边看”；token 级文档流不在范围内。

### 机制选型

| 机制 | 用法 | 结论 |
|---|---|---|
| `file` watch / `file` Resource | 工作室预览跟盘刷新；侧栏已在用 | 主路径 |
| 交付物折叠 | 工作室列表、章节分组、进度 | 主路径 |
| 已记录的工具调用 | 章节状态、交付登记 | 需要时使用；不新增事件 |
| 自定义 SSE | 工具结果已是结构化事件 | 不用 |
| 聊天 token | 只放摘要、进度、选择题 | 保持 |
| CRDT | 单用户生成管线没有并发编辑要对账 | 不用 |
| 虚拟化 | 超大 Markdown 预览 | P2 |

外部机制映射到现有机制：`file` Resource 的版本取代 mutation counter；产物路径就是身份，预览不换地址；章节文件写盘触发重读该文件，而不是整篇重编译；同一文件多次重写仍是一行（按 Host 规范路径去重），对应同 ID 对账。

### 目标数据流

```text
Model ──write/edit──▶ disk (brief.md / outline.md / chapters/NN.md / report.md / report.html)
  │                        │
  │ tool/call + result     │ file Resource (stat + version)
  ▼                        ▼
Session log ──client fold──▶ studio list (working drafts / deliverables) ──▶ preview (readBytes / paged read)
  │
  └─ document_deliver ──▶ gate badges, machine verification
```

### P0：写盘即预览

P0 不改协议，不新增包。

#### P0-1：渲染工具写盘只回路径

`render_doc_template` 即使传了 `output_path` 仍返回 `content`（完整文档）与 `markdown`（正文），`renderDocumentResult` 还把 `--- document ---` 加全文拼进模型可见文本；`.docx` 的结果值还带 base64。

改动：

1. `RenderDocTemplateOutput` 把 `content` / `markdown` 改为可选；写盘后 `writeRenderedDocument` 剥离这两个字段，返回 `{ template, format, fileName, mimeType, encoding, residual, warnings, path, bytes }`。
2. `renderDocumentResult` 分两路：
   - 有 `path`：输出头部、`Written to <path> (<bytes> bytes)`、残余占位符、警告，再加一行说明正文已落盘、需要复核时用 `read` 读取。删掉 `--- document ---` 块。
   - 无 `path`：文本格式保持现状，`docx` 直接失败并要求 `output_path`。模型看不到结果值里的 base64，技能里的解码指示本来不可执行。
3. 工具说明改为：交付文件一律传 `output_path`；写盘后结果为路径、字节数、残余占位符与警告。
4. `document-word` 技能删掉 base64 回退；不传 `output_path` 即失败。
5. `legal` preset 的交付技能要求传 `output_path`，当前只写“渲染 `.docx`”。

结果契约：

| 调用 | 结果 |
|---|---|
| `format: markdown/html` + `output_path` | 无 `content` / `markdown`；有 `path` 与 `bytes` |
| `format: docx` + `output_path` | 同上；包只写盘，绝不进结果 |
| `format: markdown/html` 无 `output_path` | 仍返回 `content` / `markdown`（小文档的显式选择） |
| `format: docx` 无 `output_path` | 失败，提示必须写盘 |

测试：

- `doc-template/tests/tools.spec.ts`：写盘结果文本不含 `--- document ---`；`value.content` 与 `value.markdown` 为 `undefined`。
- `doc-template/tests/output-path.spec.ts`：docx 写盘后结果无 base64；无 `output_path` 的 docx 调用失败。
- `snapshots/web/legal-preset/tool-schemas.expected.json`：schema 变更后刷新。
- `document-preset.spec.ts` 与 `document-prompt-consistency.spec.ts` 与新结果契约一致。

风险：直接读 `content` 的自动化会中断。仓库内消费方是模型与技能，没有客户端读取 `content`；按预发布 API 处理，更新全部消费方。

#### P0-2：工作室预览通过 `file` Resource 跟盘刷新

`useResource` 是每个 slot 组件都有的标准 prop（`resources` 包的 `GlobalStandardProps`）。`workspaceFiles` 的 `file` provider 已经做 stat、变更观察，并与侧栏预览共享订阅。工作室需要：

1. 把预览内容抽成 `PreviewPane` 子组件，调用 `useResource<'file'>(fileAddressFor(sessionId, cwd, selectedPath))`。
2. 以 `meta.value?.version` 作为读取 effect 的依赖；版本变化就重新 `readFileText` / `readFileTextComplete`。请求带 id，丢弃过期结果。
3. `autoRefresh` 默认开启，预览栏加一个本地化开关；关闭后只保留手动刷新。
4. 文件消失时显示“文件已被删除”，保留最后一次内容并标注；文件重新出现时 Resource 会再次给出 metadata。
5. 没有选中文件时不挂载 `PreviewPane`，避免对空地址建立订阅。

工作室不自建 `$stream`：`workspaceFiles.changes` 可用，但 Resource 已经处理共享、重连、缺失文件与路径归一化；第二条流会与侧栏重复，还要重复处理重连与释放。

测试：

- `StudioView.client.spec.tsx`：stub `useResource`，改变 `version` 后断言重新读取；`autoRefresh` 关闭后不重读。
- 真实 registry 测试断言工作室与侧栏读同一地址时只开一条 host 流；工作室侧只断言订阅次数。
- 手工：`pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml`，写文档、打开工作室、在磁盘上改文件，观察预览更新。

风险：每次保存都重读会抖动。100 ms 合并窗口，同一 `version` 只读一次即可。Resource 的 `version` 是不透明令牌，不解析。

#### P0-3：预览渲染升级

Markdown：`.md` 用 `@deepseek-ai/dsh-client-ui-primitives` 的 `MarkdownText` 渲染，`variant="body"`，标签从工作室自己的 locale 取（`code.copy`、`code.copied`、`codeBlock.title`、`codeBlock.wrap`、`codeBlock.unwrap`、`footnotes`）。原始 HTML 按 `MarkdownText` 的默认安全策略处理，不额外开启。局部图片在 P0 只显示 alt 文本；P1 通过侧栏的 host 文件路由接 `pathImages`。

HTML：`.html` 改用 `readFileTextComplete`（host 完整读，上限 `maxFileBytes`，默认 32 MiB）。增加工作室 `Config.htmlPreviewMaxBytes`（默认 8 MiB）：超过就显示“文件过大，转侧栏预览”，不把巨型 HTML 塞进 iframe。未超过时保留 `sandbox=""` 的 iframe `srcDoc` 与现有安全策略。打印与导出继续用完整读取；截断时指向侧栏或原文件。

文本与代码保持 2 MiB byte window 与现有截断提示；P1-D 换成分页读取。二进制格式保留“转侧栏预览”按钮；工作室内联 Office 预览属于 P2。

测试：

- `.md` 渲染出标题、列表、代码块，而不是 `<pre>` 原文。
- `.html` 超过 `htmlPreviewMaxBytes` 时显示 handoff，不创建 iframe。
- `.html` 未超过时完整渲染；截断的半页路径不再存在。

#### P0-4：跟随最新产物

工作室状态增加 `follow`（默认开）。`produced` 增长且 `follow` 为真时，选中最后新增的一项。用户手动选中其他文件时 `follow` 自动关闭；预览栏的“跟随最新”开关可以重新打开。选中的文件被删除时，退回第一项并保留提示。

实现：用 `useRef` 记录上一次的 `produced.length`，只在增长时切换；重写同一文件不改变选中。不改变 `documentDeliverables` 的顺序——阅读顺序是 brief → outline → 章节，按更新时间排序会跳。文案走 locale，图标用现有 product 图标。

测试：新增 `chapters/01.md` 时选中它，新增 `chapters/02.md` 时选中 02。手动选中 `chapters/01.md` 后新增 03，选中不变；打开跟随后下一次新增再跟随。选中文件被删除时回到第一项。

#### P0-5：切换时机与可见性

切换由成功的 `document_deliver` 结果触发，可能发生在最终回复仍在流式输出时。

改动：

1. 增加 `hasDocumentProduced(entries)`：扫描成功的 mutation 调用，扩展名属于 `md/html/pdf/docx/pptx` 即认为本轮有工作稿。复用 `mutationPath` 的解析，不写第二套路径语法。
2. 只在事件窗口的最后一个事件是 `turn/end` 时切换。进入已结束的旧会话时最后一个事件通常也是 `turn/end`，行为不变。
3. 保留每个会话 entry 只切一次的 guard 与重试窗口。
4. 切换条件：preset 为 `document`，且成功登记或本轮产出了工作稿。

测试：中途出现 `write` 不切换，`turn/end` 后切换。进入已有登记的旧会话仍切换。用户手动切回聊天后，同一次会话 entry 不再被抢。

风险：文档会话里写临时 `.md` 也会触发切换。这是文档 preset 的预期行为，用户可一键切回；若产品认为过于主动，可要求 `document_artifact` 或 `document_deliver` 出现才切换。

#### P0-6：技能按章落盘

`document-report`：

1. brief 确认后先写 `outline.md`：章节树（H2 一层，最多两级）、每章一句话要点、每章来源清单。
2. 按章写 `chapters/01-<slug>.md`、`chapters/02-<slug>.md`……；每章开头是 H2，正文带来源。
3. 终稿用 shell 拼接，不让模型整篇重写：

   ```sh
   printf '# <title>\n\n' > report.md
   cat chapters/*.md >> report.md
   ```

4. `report.html` 由 `report.md` 渲染（P1-C 的文件到文件渲染器；没有该工具时按现有 HTML 步骤手写）。
5. `document_deliver` 只登记最终成品（`report.md`、`report.html`、可选的 `.docx`），不登记章节。
6. 少于三章或总篇幅约 5000 字以下时允许单份 `report.md`，避免短文档制造目录噪音。

已知边界：shell `cat` 不产生 `write` mutation，工作室要到 `document_deliver` 登记后才显示汇编出的 `report.md`；章节文件仍实时可见。要在登记前显示 shell 产物，需要 P1-B 的 `document_artifact`，或在最终文件出现后尽早登记。技能必须写明这一点，避免用户把“最终文件没出现”读成失败。

`document-brief` 与 `document-quality-gate`：brief 仍要求写 `brief.md`；质量门检查最终成品，章节是工作稿，P0/P1 核验仍按成品。

测试：`document-prompt-consistency.spec.ts` 继续通过。新增 keyless 快照：文档会话写 `outline.md`、两章与最终 `report.md`，工作室列表同时出现工作稿分组与成品。

### P1：章级产物与规模

#### P1-A：路径约定、分组与进度

分组不需要新协议。

- **成品**：有 `document_deliver` 登记的条目（带 `format` / `gate`），或基名属于最终成品约定且在 `chapters/` / `drafts/` 之外：`report.md`、`report.html`、`index.html`、`deck.html`、`<name>.docx`、`<name>.pptx`、`<name>.pdf`。
- **工作稿**：`brief.md`、`outline.md`、`chapters/**`、`drafts/**`，包括其中的 `.docx` / `.pdf` 草稿。
- **其他**：其余 mutation 路径（资源、临时文件），默认折叠。

标题栏显示 `成品 N · 工作稿 M · 章节 K`。`outline.md` 存在时解析其中的 H2 数量作为目标章节数，否则只显示已写数量；解析失败退化为计数，不影响列表。不引入持久化字段，全部从 `produced` 派生。

实现：在 `packages/client/ui-document-studio/src/client/grouping.ts` 增加纯函数 `groupProduced(produced)` 与 `chapterProgress(produced, outline?)`；列表渲染为两个分区，选中仍用完整列表的路径；空状态区分“没有工作稿”与“有工作稿但没有成品”。

测试：纯函数覆盖 brief / outline / chapters / 最终成品 / 混合 / 重复路径；视图测试覆盖两个分区、章节计数与分组变化后选中不丢失。

先不做工具，因为路径约定已经回答“写到第几章”。只有实时 `writing` 状态、`failed` 状态、自定义标题，或由 shell / 子代理写出的章节需要显式状态。

#### P1-B：`document_artifact` 工具（决策门）

只有在产品验收明确要求以下任意一项时才做：显示“第 7 章正在写”（`writing`）而不只是“已出现”；显示“第 7 章失败”（`failed`）；章节标题与文件名解耦；章节由 shell / 子代理写出，没有 `write` mutation 可折叠。

设计：新包 `packages/document/document-artifact/`，注册模型面工具 `document_artifact`，参数为 `{ path, kind: 'brief' | 'outline' | 'chapter' | 'html' | 'docx' | 'pptx' | 'pdf', status: 'writing' | 'ready' | 'failed', title?, order?, note? }`。`ready` 通过与 `document_deliver` 相同的 `ctx.fs` 解析与存在性检查要求文件存在；`writing` 允许文件尚未出现；`failed` 记录原因。结果是一行确认（路径、kind、status、title），不回正文。客户端折叠 `documentArtifacts`，按 Host 规范路径身份去重，同一 id 的最新状态覆盖旧状态，与 `documentDeliverables` 并列而不合并。工作室进度条读 `documentArtifacts`；聊天通过 `presentResult` 渲染紧凑的章节卡。`document_deliver` 仍是最终登记。

测试：工具单测覆盖路径解析、`ready` 缺失文件失败、`writing` 允许缺失、`failed` 带原因；折叠测试覆盖同 ID 覆盖、乱序记录、旧记录降级；新增工具 schema 与一次章节记录的会话快照；persona 与技能都提到该工具。成本 3–5 人日，含新包、preset 行、覆盖率与快照。

#### P1-C：文件到文件渲染（长报告的关键规模优化）

一篇三万字的报告目前还要模型再输出三万字 HTML，全部进入会话历史并被后续每个请求携带；这项输出成本大于预览问题。

在 `doc-template` 增加 `render_document_file`，参数 `{ input_path, output_path, format: 'html' | 'markdown', title?, style? }`。它通过 `ctx.fs` 读 `input_path`，用现有 `marked` 管线与文档样式渲染并写 `output_path`，只返回 `{ path, bytes, headings, words, warnings }`。HTML 渲染器补齐报告技能目前要求模型手写的最小能力：标题 `id` 锚点、目录、页脚（文档名、日期、版本）。`render_doc_template` 继续负责“模板 + 变量”的结构化文档，`render_document_file` 负责“汇编后的 Markdown → 成品”。`document-report` 改为章节 → `cat` 汇编 → `render_document_file`；视觉要求高的单页工件仍走 `document-html`。该工具默认只在 document preset 挂载；legal preset 要在 `legal.patch.yml` 中把它加在 `render_doc_template` 旁边。

测试：fixture Markdown → HTML，覆盖锚点、目录、页脚、代码块与表格；结果不含正文；输入缺失失败；输出路径受 fs policy 约束；500 KB 输入的渲染时间与内存有上界。

#### P1-D：分页预览

工作室目前只读 2 MiB，一篇 5 MB 的 Markdown 只能看到开头。侧栏已经用 `workspaceFiles.read` 分页（每页 5000 行），工作室可以复用。

在 `file-reads.ts` 增加 `readFilePage(path, offset)`，调用 `workspaceFiles.read(sessionId, path, { offset, limit })`。首次加载第一页；滚动到底或点“加载更多”读下一页直到 `eof`。Markdown 用 `MarkdownText` 的 `streaming={!eof}` 渲染累积文本，它能容忍分页边界切开的未闭合块。文本与代码同样分页；HTML 继续完整读取。版本变化时重置到第一页，并保留滚动位置或提示“文件已更新，已回到顶部”。

测试：多页累积、`eof`、版本变化重置、每次“加载更多”只请求一次；1 MB Markdown 的首屏时间与内存有上界（虚拟化属于 P2）。

#### P1-E：compaction 与预览隔离审计

预览已经通过 `workspaceFiles.readBytes` 读磁盘，不读被 pruner 替换的工具结果。补一条回归测试：构造一个大工具结果被 pruner 替换的会话，断言预览仍读到完整文件。测试只断言预览走 `workspaceFiles`，不依赖 pruner 内部实现，这样未来把预览改成读日志时会被拦住。

#### P1-F：章级子代理（可选，长文档）

适用于 20 章以上的报告或手册：主 agent 完成 `outline.md` 与风格约束后，为每章 spawn 一个写作子代理，输入章节目标、来源清单、风格与目标文件路径。子代理只写 `chapters/NN-*.md` 并回报路径；主 agent 负责一致性审阅、汇编与质量门，因此主上下文只保留大纲、章节摘要与路径。风险是跨章术语与语气漂移，需要主 agent 的审阅回合；先在一个真实长报告上试点，再写进技能。

### P2：大规模与长期

**虚拟化。** 触发条件：单文件 Markdown 超过 1 MB，或首屏渲染超过 2 秒。方案是按 heading 分块加 `content-visibility: auto`，或按约 140 KB 窗口做虚拟滚动。先测量再实现；P1-D 的分页已经覆盖大多数说明书。

**Office 内联预览。** 复用 `packages/document/office-to-pdf` 把 `.docx` / `.pptx` 转 PDF，再复用侧栏的 PDF body（`ui-sidebar-documentpreview`）。转侧栏仍是默认路径。内联预览需要把 PDF body 暴露成可复用组件，或让工作室直接打开侧栏的 PDF 标签；不在工作室里重新实现 Office 解析。触发条件：用户明确要求不离开工作台看 Word / PowerPoint。

**跨会话工作台。** 跨会话历史、检索与批量导出需要 Host 侧的 session projection 聚合查询，单独设计。当前工作室只折叠当前会话窗口，长会话早期 turn 会丢条目；这是 P0/P1 之外的已知限制。

**ACP 与 Typst 级 IR。** ACP 只在 DSH 嵌入 IDE 时需要；当前 Web 与 Desktop 不走编辑器代写。Typst 级增量 IR 只在 HTML / PDF 预览延迟成为主诉时才考虑；在此之前章级重渲染足够。

### 落地顺序与 PR 拆分

| 顺序 | 项 | 依赖 | 估算 |
|---|---|---|---|
| 1 | P0-1 渲染工具写盘只回路径 | — | 1 人日 |
| 2 | P0-2 工作室预览跟盘刷新（`useResource`） | — | 1.5 人日 |
| 3 | P0-3 Markdown 渲染、HTML 完整读取、二进制 handoff | P0-2 | 1.5 人日 |
| 4 | P0-4 跟随最新产物 | P0-2 | 0.5 人日 |
| 5 | P0-5 在 turn end 切换并扫描工作稿 | — | 1 人日 |
| 6 | P0-6 技能按章落盘 | — | 0.5 人日 |
| 7 | P1-A 分组与进度 | P0-4、P0-6 | 2 人日 |
| 8 | P1-C 文件到文件渲染 | P0-1 | 3–4 人日 |
| 9 | P1-D 分页预览 | P0-2 | 2 人日 |
| 10 | P1-B `document_artifact`（可选） | P1-A 验收 | 3–5 人日 |
| 11 | P1-F 章级子代理试点 | P0-6、P1-C | 1 人日 |
| 12 | P2 | 按需 | 10 人日以上 |

PR 拆分：PR-1 是 P0-1（工具契约、技能、快照，独立可回滚）。PR-2 是 P0-2 至 P0-4（工作室预览链路）。PR-3 是 P0-5 与 P0-6（切换时机与按章写作）。PR-4 是 P1-A 加 P1-D。PR-5 是 P1-C。PR-6 是决策门打开后的 P1-B。每个 GUI PR 附 keyless 快照与 GIF；每个模型可见变更刷新对应快照；每个新包满足单文件覆盖率要求。

## 曾考虑的替代方案

**生成中整文流或 token 级文档 SSE。** 章级文件加文件观察已经覆盖“边写边看”。整文流会与 compaction、断线重连与沙箱策略纠缠，且没有文件路径之外的新结果。

**CRDT 协同（Yjs / Lexical / Milkdown collab）。** 单用户生成管线没有并发编辑冲突要对账。

**把 HTML、DOCX base64 或全文推进聊天。** 与文档 persona 冲突，也让上下文不可控。写盘工具只回路径；`render_doc_template` 写盘后只回路径。

**从被裁剪的工具结果预览。** 预览读磁盘；被裁剪的结果永远不是内容来源。

**按 token 级重渲染整本说明书。** 章级重渲染加调页足够；Typst 级 IR 后置。

**为单用户生成管线新增 `SessionEventMap` 成员。** 工具调用已经是已记录事实；确实需要结构化状态时用 `document_artifact` 工具。

**在没有产品需求时新增 `document_artifact` 包。** 路径约定与分组已经回答大部分问题；新包会为一个展示字段增加工具、模型纪律、覆盖率与快照。

**把侧栏 watch 产品化，而不是工作室。** 侧栏已经跟随 `file` Resource 的 metadata 刷新；缺口恰好在工作室预览。调研文档把 P0-1 放在侧栏。

**把规模问题归因于 spill 与 pruner。** spill 已经挂载，pruner 只在 compaction 压力下运行。直接修的是 `render_doc_template` 的结果契约与 `.docx` 的 base64 回退。

**在生成中切到工作室。** 本提案在 `turn/end` 后切换，避免抢走流式回复；扫描工作稿保证交付前可见。

**新增 `document.artifact` 会话事件。** 本提案优先路径约定与分组，只在需要 `writing` / `failed` 状态时增加 `document_artifact` 工具，不扩展 `SessionEventMap`。

**把 compaction 与预览分离当成中等改动。** 预览已经读磁盘，只需补回归测试。

**把文件到文件渲染与章级子代理后置到 P2。** 它们直接降低最终 HTML 的模型输出成本，因此位于 P1 与 P2 之间，而不是排在虚拟化与 IR 工作之后。

## 验收标准

P0 在以下全部成立时算完成：

- 文档会话写出 `brief.md` 后，不调用 `document_deliver`，交付物标签就能看到它。
- 在磁盘上改写 `brief.md`，预览一秒内更新，不需要重新选中。
- 写出 `chapters/03-*.md` 后，预览跟到第三章。
- `.md` 显示为排版文本；`.html` 完整渲染或明确提供侧栏 handoff。
- 本轮回复完整显示后，工作室才接管。
- 传 `output_path` 时 `render_doc_template` 结果不含正文；两万字报告的后续请求不再多背两万字符。
- `document-word` 缺少 `output_path` 时失败并给出明确提示。

验证矩阵：

| 场景 | 断言 |
|---|---|
| 两万字报告，模板写盘 | 单次工具结果低于 2000 字符；后续请求不含正文 |
| 三章文档 | 工作室显示 3 个工作稿；跟随选中最后一章；刷新低于 1 秒 |
| 十章文档 | 分组计数正确；`outline.md` 的目标章节数正确 |
| 5 MB Markdown | P1-D 分页可读到末尾；首屏低于 2 秒 |
| 10 MB HTML | 超过 `htmlPreviewMaxBytes` 时转侧栏，不创建 iframe |
| 30 章加子代理 | 主上下文不保留章节全文；质量门仍能读到最终成品 |

命令：

```sh
pnpm exec vitest run packages/document/doc-template
pnpm exec vitest run packages/client/ui-document-studio
pnpm run test:gui
pnpm run test:snapshot -t document-deliver
pnpm run test:snapshot:refresh -t document-deliver
pnpm run test:web
pnpm run test:web:refresh
pnpm run doc-sync
pnpm run test:docs
pnpm run build:artifacts
pnpm run build:check
pnpm run typecheck
pnpm run lint
```

快照与 Web：结果文本变化后刷新 `snapshots/session/document-deliver/tool-schemas.expected.json` 与相关会话；P1-B 落地时新增章节记录的 keyless 快照；新增 `document-studio` Web 场景，seed 工作区（`brief.md`、`outline.md`、`chapters/01.md`、`chapters/02.md`）加文档会话，断言分组、跟随、Markdown 渲染与 HTML 的完整 / 超限两条路径。若快照 harness 不能 seed 文档会话，在同一 PR 补上支持，不能只留 jsdom 测试。

文档与生成器：更新 `doc-template` 与 `ui-document-studio` 的 README 及 `.zh.md`，覆盖结果契约、预览、跟随与 `useResource`；更新 document preset 的 persona 与技能；刷新生成的工具目录；把[文档模式工作台](2026-08-23-document-mode-workbench.zh.md)中已被本方案覆盖的部分标为已实现，或写新 note 取代，避免两份提案并存。本方案不涉及 CLI、配置键、持久化格式、SDK 或线协议，不需要 upgrade guide；`render_doc_template` 的结果变化写在包 README 与发布说明中。

手工脚本：启动 `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml`；新建文档会话，要求一份三章技术报告；确认 `brief.md` 与 `outline.md` 在 `document_deliver` 之前出现；在磁盘上改写 `chapters/02-*.md` 观察预览刷新，再写 `chapters/03-*.md` 观察预览跟随；确认回复完整结束后才切换；检查 `render_doc_template` 工具卡的结果只有路径、字节、残余占位符与警告；选一个 `.docx` 确认侧栏能渲染；记录写盘 → 列表出现 → 预览刷新 → 跟随新章节的 GIF。

## 风险

| 风险 | 表现 | 缓解 | 回滚 |
|---|---|---|---|
| 预览重读抖动 | 每次保存都重读，滚动位置跳 | 100 ms 合并；同一 `version` 只读一次；保留滚动位置 | 关闭 `autoRefresh` 开关 |
| Resource 订阅泄漏 | 切换文件后旧地址仍被持有 | `PreviewPane` 卸载即释放；真实 registry 测试断言订阅数 | 移除 `useResource`，回到手动刷新 |
| HTML 过大 | iframe 卡顿或内存高 | `htmlPreviewMaxBytes` 上限加侧栏 handoff | 调低上限 |
| 自动切换抢屏 | 用户正在读回复 | 只在 `turn/end` 切换；每个 entry 一次 | 改回只在 `document_deliver` 时切换 |
| 工具契约变更 | 外部自动化读取 `content` | 更新仓库内全部消费方；README 标明 | 保留 `content` 一个版本（不推荐） |
| 技能纪律依赖 | 模型不写 `chapters/` | 单份 `report.md` 仍可用；工作室退化为平铺列表 | 路径约定只做展示，不做硬性门 |
| 新工具成本 | `document_artifact` 需要新包、快照、覆盖率 | 决策门：先 P1-A；状态需求明确再做 | 不做 P1-B |
| 长报告渲染保真 | `marked` 样式不如手写 HTML | 视觉工件保留 `document-html`；报告走文件到文件渲染 | 模型手写 HTML 仍可用 |

## 附录：代码证据索引

| 主题 | 文件 | 关键符号 |
|---|---|---|
| 自动切换 | `packages/client/ui-document-studio/src/client/auto-switch.ts` | `hasDeliverRegistration` |
| 切换 effect | `packages/client/ui-document-studio/src/client/index.ts` | `preset auto-switch` |
| 产物折叠 | `packages/client/ui-document-studio/src/client/document-deliverables.ts` | `mutationPath`、`producedFromTimeline` |
| 视图读取 | `packages/client/ui-document-studio/src/client/StudioView.tsx` | `selectedPath` effect、`isTextPreviewable` |
| 预览读取 | `packages/client/ui-document-studio/src/client/file-reads.ts` | `readBytes` 窗口 / 完整读取 |
| 工作区探测 | `packages/client/ui-document-studio/src/client/workspace-probe.ts` | `DELIVERABLE_EXTENSIONS`、`MAX_DEPTH` |
| 模板渲染结果 | `packages/document/doc-template/src/tool/render-doc-template.ts` | `renderDocumentResult`、`writeRenderedDocument` |
| 文档报告技能 | `packages/bundle/web-app/skills/document/document-report/SKILL.md` | 按章撰写说明 |
| Word 技能 | `packages/bundle/web-app/skills/document/document-word/SKILL.md` | base64 回退步骤 |
| preset 组合 | `packages/bundle/web-app/presets/document.patch.yml` | `tool-document-deliver`、`doc-template`、pruner |
| spill | `packages/bundle/base/cordis.patch.yml` | `spill-local`、`spill-policy` |
| 文件观察 | `packages/api/workspace-files/src/index.ts` | `changes` |
| `file` Resource | `packages/api/workspace-files/README.md` | client file resources |
| 侧栏 autoRefresh | `packages/client/ui-sidebar-documentpreview/src/client/TextPreview.tsx` | `autoRefresh` |
| 工作室设计记录 | `../../implemented/feature/2026-08-23-document-delivery-studio.md` | 自动切换、沙箱、预览上限 |
| 工作台提案 | `2026-08-23-document-mode-workbench.md` | 四个缺口、v2 |
