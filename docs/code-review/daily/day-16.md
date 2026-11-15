# Day 16 — 2026-11-30

## 今日维度与范围

- 维度：B 代码质量与精简
- 范围：文档模式全域（`docx-kit`、`office-kit`、`doc-template`、`doc-style`、`document-deliver`、`tool-office`）
- 时间盒：90 分钟
- 预期产出：B 维度文档域候选发现；daily/day-16.md

## 检查项

- [x] 检查 docx-kit/OOXML/ZIP 与 doc-template 渲染的重复。
- [x] 检查 office-kit 队列、缓存与错误类型的重复。
- [x] 检查 document-deliver 校验与工具注册的重复。
- [x] 标记文件体量热点。
- [x] 为每项精简建议写净减少量。

## 实际执行

**范围与体量（10 分钟）**：`find … -name '*.ts' -exec wc -l` 得 `doc-style/src` 7 文件 821 行、`doc-template/src` 13 文件 2259 行、`document-deliver/src` 4 文件 1790 行、`docx-kit/src` 8 文件 1760 行、`office-kit/src` 9 文件 1445 行、`tool-office/src` 3 文件 672 行，合计 44 文件 8747 行；jscpd 报 42 个文件、8712 行（它自己的文件统计口径，不影响克隆结论）。文档域没有 Day 13 那种单文件超 700 行的热点，前十为 `document-deliver/src/tool.ts` 688、`document-deliver/src/checks.ts` 613、`office-kit/src/index.ts` 499、`docx-kit/src/zip.ts` 478、`tool-office/src/index.ts` 427、`doc-template/src/store.ts` 372、`document-deliver/src/registration.ts` 343、`docx-kit/src/xml.ts` 338、`doc-template/src/tool/render-doc-template.ts` 329、`office-kit/src/queue.ts` 317。

**克隆检测（10 分钟）**：`npx jscpd packages/document/*/src`（仓库 `.jscpd.json`，默认 60 token / 6 行）得 **0 克隆，41 个文件**；降到 40 token / 4 行后得 **2 组、22 行（0.25%），42 个文件**。两组是同一根因的两处实例：`doc-template/src/store.ts:73` ↔ `tool/render-doc-template.ts:27`（15 行 / 42 token）与 `office-kit/src/queue.ts:15` ↔ `types.ts:61`（9 行 / 40 token），见 F-DOC-006。除此之外文档域没有别的克隆，重复全部落在类型声明层而不是逻辑层。

**检查项 ①：docx-kit/OOXML/ZIP 与 doc-template 渲染（20 分钟）**：三处都只有一份实现。① DOCX 写出：`doc-template/src/renderers/docx.ts:13` 只有一行 `import { renderDocx as renderDocxPackage } from '@deepseek-ai/dsh-docx-kit'` 并直接委托，doc-template 没有第二份 OOXML 写出器，三个渲染器里只有 `docx.ts` 碰 OOXML。② DOCX 读入：`document-deliver` 复用 `docx-kit` 的 `extractDocxText`、`ZipReadLimits` 与 `DEFAULT_ZIP_READ_LIMITS`，F-DOC-003 的收口仍生效，域内没有第二个 ZIP 读取路径。③ XML 工具：`docx-kit/src/xml.ts` 的 `scanXml`/`buildXmlTree`/`escapeXmlText`/`decodeXmlText` 是唯一实现，`markdown`/`html` 两个渲染器不解析 XML。模板变量引擎同样只有 `doc-template/src/vars.ts` 一份（`createVarSchema`/`extractPlaceholders`/`substitutePlaceholders`/`validatedResolve`），两个工具都经 `store.ts` 的 `validatedResolve` 进入。样式投影也没有两份：`doc-style/src/projection.ts:105` 的 `toRenderStyle` 只做一次 `DocumentStyle → RenderStyle` 转换，渲染器消费 `RenderStyle`；`doc-style` 无 frontmatter 解析，`doc-template/src/frontmatter.ts` 解析 Markdown frontmatter，输入不同。唯一重复是请求类型按字段重写，见 F-DOC-006。

**检查项 ②：office-kit 队列、缓存与错误类型（15 分钟）**：读了 `queue.ts`（317 行）与 `outputs.ts`（218 行）的完整保留与淘汰面。内存缓存是 `ConversionQueue.ready`（`Map<OfficeKitKey, Stored>`，按 `maxCachedEntries` 与 `maxCachedBytes` 淘汰，`retain()` 还要同步清理 `aliases`）；磁盘存储是 `OutputStore`（每会话私有目录 + `retentionMs` 过期 + `maxOutputStoreBytes` 预算 + 启动清扫 + 删除失败仍计入预算并留待重试）。两者都能被描述成「按条目数与字节预算淘汰」，但抽象成共享淘汰器要把 Map 键、别名失效、磁盘删除与失败记账三件事一起参数化，净复杂度为负，**判为非重复**；若 Day 19 出现第三处再说。错误类型不重复：`office-kit` 只有一个 `OfficeKitError`（`errors.ts:5`），`doc-style` 的 `DocumentStyleError`（`types.ts:148`）与 `doc-template` 的 `DocTemplateError`（`types.ts:242`）各自携带本包的错误码表，按包区分是合法的边界。配置面也没有第二份默认：`office-kit/src/index.ts` 的 20 处 `.default(` 已经是唯一来源，`apply` 与 `ConversionQueue` 直接读 `config.x`。

**检查项 ③：document-deliver 校验与工具注册（20 分钟）**：三个模块的职责是可分的——`checks.ts`（613 行）是确定性文本检查，`registration.ts`（343 行）是质量门禁 helper（P0 清单、格式判定、不可读原因、brief 探测、路径解析），`tool.ts`（688 行）是 schema 与一次登记的编排。**没有第二份实现**：`checkDocumentText` 一处、`checkDeliverables` 一处，`checkDeliverable` 内部的 docx/text 两支共用 `reasonField` 闭包与 `READ_CAP_REASON_PREFIX` 判定；`registration.ts` 的 `resolveTarget` 被 `briefReferenceWarnings` 与 `resolveAckIdentities` 共用，是单点；`resolveUnreadableReports` 的「原因文本」与 `tool.ts` 的 `reasonField` 输入不同（`unreadable_ack` 对 `mismatch`），不是同一件事。`checks.ts:600`/`:608` 的两处 `?? DEFAULT_*` 是 `checkDocumentText` 的**函数选项**默认值，没有对应的 schema，不属于 F-DOC-004 的配置双源；四个包的 `Config` 全部是 `z<Partial<Config>, Config>`，schema 是唯一默认源。

**检查项 ④：体量热点（10 分钟）**：按上文前十逐个判断归属。`document-deliver/src/tool.ts` 688 行是四个阶段（公共类型 71–177、入参管线 202、检查执行 310–397、结果渲染 409–493、工具注册 494–688）合成一个工具，内聚且已被 `registration.ts` 抽走过一次门禁 helper，**不建议再拆**；`checks.ts` 613 行是五个检查项加共享的报告构造器；`office-kit/src/index.ts` 499 行是 provider 服务、配置与路由；`docx-kit/src/zip.ts` 478 行是 ZIP 中央目录解析与限额。今日没有需要开「拆分」发现的文件，也没有超过 700 行的文件。

**检查项 ⑤：净减少量（10 分钟）**：唯一精简建议是 F-DOC-006 的组合改法，净减少约 −30 行，并把两处漂移点收敛为一处权威声明。

**机械复核（5 分钟）**：① `git grep -n '?? *DEFAULT_' -- packages/document` 得 2 处，都在 `document-deliver/src/checks.ts:600`/`:608` 的函数选项默认值，**不是** Config 双源——修正 Day 15 末尾「文档域 `?? DEFAULT_` 为 0」的口头判断。② `git grep -c '\.default(' -- packages/document` 得 doc-template 6、document-deliver 7、office-kit 20、tool-office 5，全部位于各包 `Config` schema，`apply` 内无二次兜底。③ `git grep -n 'export const Config' -- packages/document` 得 4 处，全部 `z<Partial<Config>, Config>`，F-DOC-004 的修法在文档域没有回归。④ jscpd 两种阈值各复跑一次（0 组 / 2 组 22 行），JSON 报告在 `/tmp/jscpd-doc16`，逐组读上下文后归入 F-DOC-006。⑤ pathspec 复现记一笔：在 `packages/document` 子目录下写 `git grep -- 'packages/document/*/src'` 会静默返回 0 命中，必须从仓库根或用裸目录前缀 `packages/document` 才有效。

## 发现

新增 1 条，含净减少量：

| ID | 标题 | 净减少 |
|---|---|---|
| F-DOC-006 | 跨模块请求类型按字段重写而非组合（`RenderRequest`、`OfficeImagesRequest`） | 约 −30 行 + 两处静默漂移点收敛 |

今日净减少合计约 −30 行。与既有发现的关系：F-DOC-006 与 F-VID-006（`StrictRequest` 与 `MediaTaskRequest` 字段全同）是同一根因的第三处实例，三条可在一次改动里改完；F-DOC-003（ZIP 限额）与 F-DOC-004（配置默认值）今日复核均仍生效，无回归。

## 假设验证/推翻

H03（office-kit 异常路径可能泄漏子进程或临时文件）与今日范围相邻但不重叠：今日读的是 `ConversionQueue` 的保留/别名/淘汰与 `OutputStore` 的过期/预算/清扫，两者都有单点归属，没有发现重复的清理路径。取消与超时路径不在 B 维度范围，仍按原计划留到 Day 23 定向验证，状态不变。

H06（测试缺口集中在 provider 与 CLI 边界）今日未展开：文档域 `document-deliver` 2 个测试文件、`tool-office` 2 个，与假设描述一致，但判定留给 Day 27–33。

其余假设与文档域无交集，不更新。

## 未决问题

1. F-DOC-006 改用 `extends` 后，`verify-export-jsdoc` 对继承字段的文档要求需要先确认：仓库规则是「heritage-declared members 的文档留在声明处」，但该门禁对 `interface X extends Y` 里新声明的 `outputPath` 是否要求独立 JSDoc、对继承字段是否要求重复，实施前跑一次门禁确认。
2. `office-kit` 的 `OfficeImageOptions` 放哪里需要一次边界判断：`src/types.ts` 的规则是「声明本包的 seam 词汇」，而 `Omit<OfficeImagesRequest, …>` 是派生类型，算不算 seam 词汇没有先例；放 `queue.ts` 则形成「内部模块从公开类型派生」的依赖方向。倾向前者（`types.ts` 里写一行 `OfficeImageOptions`），执行前再读一次 `types.ts` 的分工声明。
3. `document-deliver/src/tool.ts` 688 行距 Day 13 用的 700 行线只差 12 行，若后续再加检查项或参数，结果渲染（`renderResult`/`statusText`/`describeCheck`/`checksMeta`，409–493）是天然的抽出口。今日判为不需要拆分，记在此处以免下次重新论证。

## 明日第一件事

Day 17（法律模式与共享机制全域：`legal-evidence`、`legal-knowledge`、`legal-law`、`knowledge-core`、`law-core`）第一件事：先跑 `npx jscpd packages/legal/*/src packages/law/*/src --min-tokens 40 --min-lines 4`，再按 H02 把两套检索骨架逐层比对——`knowledge-core` 的 `SqliteFtsTable`/`SqliteBackedEngine`（法律域）与 `patent-knowledge/src/shared/knowledge-fts.ts` 的 `KnowledgeFtsSearchBase`（专利域）——判定 F-PAT-030 与 F-LEG-004 能否合并成一条跨域发现，还是各自域内闭合；这一步也决定 Day 19 的收尾清单里要不要留一条「检索骨架统一」的候选。
