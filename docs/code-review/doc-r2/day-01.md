# 第二轮 · 文档模式全量复审 · Day 01（2026-11-28）

## 范围

`packages/document` 六个包（`document-deliver`、`office-kit`、`docx-kit`、`doc-template`、`doc-style`、`tool-office`）与 `packages/client/ui-document-studio`，合计约 1.2 万行 `src`、48 个 spec、927 个用例。只读审阅，不改业务代码；发现写入 [05-findings.md](../05-findings.md) 的「第二轮」小节，编号 F-DOC-011 起。

## 命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm exec vitest run packages/document/{document-deliver,office-kit,docx-kit,doc-template,doc-style,tool-office} packages/client/ui-document-studio` | 第 1 次：1 failed / 927 passed（`office-kit/tests/provider.spec.ts`，`warn` 被调用 2 次）；第 2 次同命令：48/48 文件、927/927 用例通过 |
| `pnpm exec vitest run packages/document/office-kit/tests/provider.spec.ts` | 39/39 通过 |
| 同范围加 `--coverage`，`include` 限定七包 `src` | 语句 99.9%（3184/3187）、分支 100%、函数 99.51%、行 99.88%；唯一 0% 文件是 `office-kit/src/identity.ts`，因其唯一覆盖者 `scripts/brand-constructor-compat.spec.ts` 不在本次过滤范围，非覆盖缺口 |
| `node /tmp/doc-check-perf.mjs`（导入构建产物 `document-deliver/lib/index.js`） | 占位符密集文本：32 KiB 39 ms、64 KiB 127 ms、128 KiB 501 ms、256 KiB 1959 ms、512 KiB 7553 ms、1024 KiB 29901 ms；同尺寸正文 3 ms |

## 单元结论

**U1 document-deliver**：读完全部四个源文件。确认三条新发现。`checks.ts` 的 `lineOf` 对每条命中重扫行起点，配合「先收集全部草稿、再在 `report` 里截断」，在 4 MiB 读取上限下退化为约 8 分钟的单线程阻塞（F-DOC-011，已量测）；未闭合的 `<pre>`/`<code>` 把余下全文并入引用范围，残余占位符由 block 降为 warn（F-DOC-012）；`char_budget` 对每个登记文件逐个套用（F-DOC-013）；同一文件的两种拼写可重复登记（F-DOC-014）；缺 ack 与未知样式抛裸 `Error`（F-DOC-015）。`fenceRanges`、`htmlBodyText`、`headingSpans` 的已知限制（属性值内的 `>`）与 README「已知限制」一致，不重复记录。围栏、内联代码、注释、属性值、行内 HTML 的排除逻辑与 F-DOC-010 的修复一致。

**U2 office-kit**：读完 `index.ts` 的 provider/生命周期部分、`queue.ts`、`scratch.ts`、`locate.ts`、`outputs.ts`。队列的读者引用计数、合并去重、取消与释放顺序、跨会话清扫的年龄下限（`max(timeoutMs × 2, 2 min)`）与目录名格式校验均自洽；配置校验拒绝 `maxSourceBytes < maxInputBytes`，不会出现永不满足的排队项。唯一新发现是 F-DOC-017 的测试抖动。`scratch.ts` 与 `outputs.ts` 的 `.catch(... => [] as Dirent[])` 是多余断言，随 F-DOC-005 一并记录。

**U3 docx-kit**：读完 `zip.ts` 的写入器与读取器。EOCD 回扫、中央目录边界、声明大小与偏移、每个条目按 `remaining` 限流的解压上限、CRC 校验都按不可信输入处理；预算为 0 时最多多解 1 字节且已被注释说明。未发现新缺陷，DOCX 投影未做真实样本复核（见未测项）。

**U4 doc-template**：读完 `vars.ts`、`tool/render-doc-template.ts` 与 `store.ts` 的渲染入口。单次替换、必填/类型校验、`applyDefaults` 的覆盖顺序、`output_path` 写盘后只回路径与字节数均与提案一致。占位符长于 80 字符不参与替换也不报残留，是提取与替换共用的既有限制，两侧口径一致，不记为缺陷。

**U5 ui-document-studio**：读完 `PreviewPane.tsx`、`StudioView.tsx` 的两个关键 effect、`auto-switch.ts`、`file-reads.ts`、`document-deliverables.ts` 的折行逻辑。`useResource` 的版本重读在依赖里带 `current` 对象但引用稳定；`cancelled` 覆盖了每个 `setState`；跟随逻辑按 `produced` 增长触发、手动选择即暂停、选中文件消失时回退到首个文件；`decodeByteWindow` 的边界在 `end = 0` 时正确跳过。未发现新缺陷。locale 文案集中在 `locales.ts`，未命中硬编码检查。

**U6 doc-style**：读完 `load.ts` 与 `placeholders.ts`，并抽查 `parse.ts` 的失败方向。目录缺失、资产损坏、零样式都按 `DocumentStyleError` 失败，禁止词表全为中文词，不存在拉丁词边界误报。

**U7 tool-office**：复核 F-DOC-005。现有 8 处类型断言，其中 `index.ts:445` 的 `processPathFromHostPath(result.path) as string` 掩盖 `string | undefined`，是唯一可能把 `undefined` 交给客户端的路径；其余断言的校验前提都在同函数内成立。`tool-office.spec.ts` 98 个用例全绿。

**U8 横向扫描**：七包无 `as unknown` 新增（唯一一处 `JSON.parse(argsRaw) as unknown` 是既有基线）、无 `.skip`/`.only`、无 `FIXME`/`TODO`/`XXX`；注册均通过 `ctx.effect`/`ctx.on` 返回 disposer；模型可见的工具参数与结果都登记到会话事件。

## 假设与验证

F-DOC-017 的根因是「假设」：`provider.spec.ts` 在文件级共享 `ctx` 与 `ctx.logger.warn`，前一个用例 mount 时启动的 `scratchSweep` 可能在下一个用例装好 spy 之后才落地 warning。证据是三组运行结果不一致，未在本地插桩证实具体落地时序。

F-DOC-011 的结论不是假设：曲线由构建产物实测得到，且与 `lineOf` 的线性扫描实现一致；4 MiB 外推值未实测，只按 1 MiB 的 29.9 秒与二次增长推算。

## 未测项

本机没有 LibreOffice，`office-kit` 的真实转换、字体回退与 `tool-office` 的跨格式产物未验证；相关结论只覆盖队列、路径、预算与错误分流。DOCX 验收读取未用真实文档复核，`docx-kit` 的结论限于 ZIP 与 OOXML 解析代码本身。GUI 层未跑 `pnpm run test:gui`，U5 结论来自客户端单测与源码。

## 下一步

先修 F-DOC-011（可用性与阻塞风险最高），再处理 F-DOC-012 的门禁绕过，随后把 F-DOC-017 的测试隔离与 F-DOC-005 的 `as string` 一并收口；F-DOC-013 至 F-DOC-016、F-DOC-018 为 Low，可合并成一批。
