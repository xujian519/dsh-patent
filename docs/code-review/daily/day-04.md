# Day 4 — 2026-11-18

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-18）。

## 今日维度与范围

- 维度：定向与基线
- 范围：文档模式、法律模式与共享机制：document 6 包、legal 3 包、law 2 包
- 时间盒：120 分钟
- 预期产出：文档/法律/共享域数据流笔记；更新 01-repo-map.md；daily/day-04.md

## 检查项

- [x] 记录 office-kit 的子进程、队列、缓存与临时目录入口。
- [x] 记录 docx-kit 的 OOXML/ZIP 解析入口。
- [x] 记录 doc-template、doc-style、document-deliver 的数据流。
- [x] 记录 legal-knowledge 的 FTS 与安装入口。
- [x] 记录 legal-law、legal-evidence 的决策入口与 law-core/knowledge-core 的消费点。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 列出 11 包 `src` 结构 | document 6 包、legal 3 包、law 2 包 |
| 统计工具注册 | `document-deliver` 1、`doc-template` 2、`tool-office` 3、`legal-law` 1、`legal-evidence` 1、`legal-knowledge` 可选 1 |
| `grep` 子进程/队列/缓存/临时目录 | `office-kit` 的 `queue.ts`、`scratch.ts`、`outputs.ts`、`output.ts`；`docx-kit` 的 `zip.ts` |
| `grep` ZIP 限额 | `office-kit` 与 `document-deliver` 默认均为 10,000 条目 / 250MB 未压缩；`docx-kit` 由调用方传 `ZipReadLimits` |
| 读关键实现 | `office-kit/src/index.ts`、`docx-kit/src/zip.ts`、`legal-law/src/verify.ts`、`legal-evidence/src/engine.ts`、`legal-evidence/src/index.ts`、`law-core/src/index.ts`、`knowledge-core/src/index.ts` |

## 数据流笔记

### 文档模式

- `office-kit`：`ctx.officeKit` 提供 `convert`、`convertTo`、`recalculate`、`renderImages` 等操作。`locate.ts` 动态定位并导入 `@deepseek-ai/libreoffice-kit`，`queue.ts` 做前台/后台队列、取消与内容寻址缓存，`scratch.ts` 用 `mkdtemp(tmpdir()/dsh-office-kit-*)` 并在首次转换与 dispose 时清扫旧目录，`outputs.ts` 按 Session 保存输出并按保留期与字节上限淘汰，`output.ts` 做完整 PDF/PNG 校验与字节上限。来源读取走 `ctx.get('workspaceFiles')` 与 `ctx.get('fs')` 的授权接口；`ctx.on('session/disposed')` 释放输出，`ctx.effect` 统一 dispose 队列、缓存、转换器与远端生命周期。
- `tool-office`：注册 `office_render`、`office_convert`、`office_recalculate`；读取 `ctx.get('officeKit')`、`ctx.get('llm')`、`ctx.get('attachments')`、`ctx.get('subagents')`。
- `docx-kit`：纯字节库；`zip.ts` 的 `readZip(bytes, limits)` 检查 `maxArchiveEntries` 与 `maxUncompressedBytes`，`writeZip` 构造 OOXML 包，`ooxml.ts` 生成 `word/document.xml` 片段，`docx-read.ts` 抽取文本。无文件系统与子进程依赖。
- `doc-template`：`assets/` 模板经 `loader.ts` 读取，`store.ts` 管理模板，`renderer-registry.ts` 选择 `renderers/` 下的 Markdown/HTML/DOCX 渲染器；`renderers/docx.ts` 复用 `docx-kit`，不另写 OOXML writer。注册 `list_doc_templates` 与 `render_doc_template`。
- `doc-style`：`assets/` 风格模型经 `load.ts` 读取，`parse.ts`/`placeholders.ts`/`projection.ts` 投影为 prompt、渲染样式与免责声明；纯库。
- `document-deliver`：注册 `document_deliver`；`tool.ts` 先用 `ctx.fs.readBytes` 按 `maxCheckBytes` 读取，再用 `extractDocxText` 按 `ZipReadLimits` 解析；`checks.ts` 做质量门禁，`registration.ts` 把 `not-a-zip` 等失败码映射成用户可读消息。

### 法律模式

- `legal-law`：`assets/law/` 随包，`baseline.ts` 读取索引，`reference.ts` 解析引用，`verify.ts` 调 `law-core` 的 `decideArticleCitation` 与 `resolveCitationDecisionPolicy`。默认策略为 `mismatch`/`outOfRange`/`notIndexed`/`unverified` 均 `block`，`unmatched` 为 `warn`——未核验不会静默通过。注册 `legal_law_verify`。
- `legal-evidence`：`engine.ts` 做确定性三性评分，`rule-set.ts` 解析 `assets/legal-evidence-rules.yaml`，`evaluators/` 按证据类型判定。`index.ts` 的 `apply` 调 `loadEngine`：规则资产缺失或不可解析时抛 `LegalEvidenceRuleAssetError`，插件加载失败；单条规则校验失败只记为警告并写 logger。引擎内部的默认权重只在直接构造、不传 YAML 的库用法下生效。注册 `evaluate_legal_evidence`。
- `legal-knowledge`：`ctx.legalKnowledge` 服务，`case-law/`、`judicial-interpretation/`、`legal/`、`shared/` 分别承载查询与 FTS；`install.ts` 显式安装，插件加载不自动运行；可选 `legal_knowledge_search` 工具。

### 共享机制

- `law-core`：纯引用机制库，导出引用文本规范化、引用抽取、命题重叠评分、逐条决策与引用工具脚手架；无文件系统依赖。`legal-law` 直接消费；`patent-law` 经 `patent-core` 再导出消费。
- `knowledge-core`：纯查询机制库，导出 FTS 帮助函数、FTS 到 LIKE 的降级阶梯、查询清洗、关键词切分、结果上限、法条有效性与安装文件操作、真实路径归一化。`legal-knowledge` 与 `patent-knowledge` 直接消费；`patent-core` 为专利域再导出。

## 发现

代码级发现：无。Day 4 只做定向，不判定缺陷。

结构观察（待对应维度确认）：

1. `office-kit` 的资源生命周期是完整的：队列、内容寻址缓存、按 Session 的输出存储、scratch 清扫、`ctx.effect` 统一 dispose；H03 在定向层面未见泄漏，取消与异常路径留到 Day 9/23 验证。
2. OOXML 限额一致：`office-kit` 与 `document-deliver` 默认均为 10,000 条目 / 250MB 未压缩；`docx-kit` 把 `ZipReadLimits` 交给调用方。两份默认值一致，暂未发现同档文件在一个门禁通过、另一个失败的情况。
3. `legal-law` 的默认策略对 `unverified` 是 `block`，不是 `warn`；这是 H07 的反向证据。`patent-law` 的默认策略是否同样 fail-closed，留到 Day 36 对照。
4. `legal-evidence` 缺规则资产会直接使插件加载失败，不是静默降级；引擎内部的默认权重只服务直接库用法。该行为与 `patent-deadline` 的日历校验一致，可作为 fail-loud 的参照。
5. 共享机制本身是纯库，但消费路径不对称：`legal-law` 直连 `law-core`，`patent-law` 经 `patent-core` 再导出。Day 17 对照两域调用点。
6. `tool-office` 除 `officeKit` 外还读取 `ctx.get('llm')` 与 `ctx.get('subagents')`；用途留到 Day 9/30 确认。

## 假设验证/推翻

- H02：**部分确认**。`law-core` 与 `knowledge-core` 是纯机制库；不对称在消费路径，不在库本身。Day 17 继续。
- H03：**定向未证实**。`office-kit` 有显式队列、缓存、scratch 清扫与 dispose；取消/异常路径留到 Day 9/23。
- H07：**出现反向证据**。`legal-law` 默认把 `unverified` 判为 `block`，`legal-evidence` 缺资产 fail loud；`patent-law` 的默认策略仍待 Day 36 对照。
- H06：文档域的 `document-deliver` 与 `tool-office` 测试文件数偏少，Day 27 起按高风险表面核对。
- H09：preset 未触及，仍待 Day 5/19。

## 未决问题

1. `tool-office` 的 `ctx.get('llm')` 与 `ctx.get('subagents')` 具体用途，需要在 Day 9/30 追调用链。
2. `office-kit` 的 scratch 清扫在跨进程与排队场景下是否足够，留到 Day 23。
3. `patent-law` 的默认引用策略是否与 `legal-law` 一样 fail-closed，留到 Day 36。

## 明日第一件事

Day 5：读视频模式（`video-mode`、`video-bundle`、`ui-video-studio`）的 provider、项目文档、EDL、预算账本与客户端数据流，并补跑可行的 typecheck/lint。
