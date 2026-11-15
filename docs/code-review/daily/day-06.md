# Day 6 — 2026-11-20

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-20）。

## 今日维度与范围

- 维度：A 安全缺陷
- 范围：专利域-1：patent-data、patent-tools 的外部输入到危险汇点
- 时间盒：90 分钟
- 预期产出：A 维度专利域候选发现；daily/day-06.md

## 检查项

- [x] 检查 CNIPR/nuo 请求参数是否进入 shell、脚本或文件路径。
- [x] 检查 ego-browser 子进程的 argv、env 与工作目录构造。
- [x] 检查模型工具输入到 URL、文件路径、命令的汇点。
- [x] 检查检索缓存键与跨案卷隔离。
- [x] 每条候选发现补充文件与行号证据。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 扫 `spawn`/`exec`/`fetch`/`URL` | `patent-data` 只有 ego-browser 一条子进程通道，无 HTTP 自建请求；`patent-tools` 只有 `workbench-link-patent-case.ts:395` 一处 `fetch`，其余走 `ctx.patentData` |
| 读四个脚本生成器 | `cnipr-script.ts` 的 PDF 直链、法律状态、关键词检索三个脚本；`patent-pdf-download-ego.ts` 的批量下载脚本 |
| 读子进程边界 | `ego-session.ts`（argv/stdin/env/cwd）、`subprocess-runner.ts`（超时与输出上限）、`freecad-renderer.ts`、`inkscape-renderer.ts`、`graphviz-renderer.ts` 的 argv |
| 读输入校验 | `patent-pdf-download.ts` 的 `validatePatents`、`normalizePatentNumber`、`resolveDatedOutputDir`，以及同域 `resolveConfinedPath` 的两个使用者 |
| 读 URL 约束 | `CNIPR_PDF_URL_PATTERN`、`normalizeCniprPdfUrls`、Google Patents 的链接选择表达式与 `response.url === pdfUrl` 判定 |
| 检索缓存隔离 | `patent-cache.ts` 的键由通道与归一化参数构成，未见跨案卷共享可变状态 |

## 发现

- **F-PAT-014**（High，A）：`patent_pdf_download` 的输出目录只做 `resolve(cwd, outputDir)`，绝对路径与 `..` 都能落盘，并作为 ego-browser 子进程的 `cwd`；同域 `patent-document`/`patent-filing` 都走 `resolveConfinedPath`。
- **F-PAT-015**（Medium，A/B）：PDF 兜底下载用固定的 `<target>.tmp` 且不独占创建，存在符号链接预置覆盖；同时缺 fsync 与 Windows 重命名处理。这是批次 A 遗漏的第五份原子写。
- **F-PAT-016**（Low，A）：ego-browser 子进程继承完整 `process.env`；同批 FreeCAD 子进程只传最小环境。

定向结论中确认已处理、不立发现的项见 [05-findings.md](../05-findings.md) 的「Day 6 定向结论：已处理的外部输入」。

## 修复（同日，批次 A2）

用户确认「先修这两条」后执行，只动 `patent_pdf_download` 一条链路：

- F-PAT-014：显式 `outputDir` 改走 `resolveConfinedPath`，与 `patent-document`、`patent-filing` 一致；参数描述同步改为要求留在工作目录内。
- F-PAT-015：兜底下载改调 `writeFileAtomic`，删掉固定的 `<target>.tmp` 与手工清理。

行为变化：工作目录之外的绝对路径现在被拒绝（`invalid_tool_input`）。`index.spec.ts` 的接线用例原本传绝对临时目录，改为传 `.`，并新增两条用例覆盖拒绝与符号链接预置。

验证：`pnpm exec vitest run packages/patent/patent-tools/tests` 2221 通过、4 skipped；`pnpm run typecheck` 5/5 通过。

## 假设验证/推翻

- H05：**部分确认**。脚本注入面已正确处理——CNIPR 与 PDF 下载脚本的参数全部经 `JSON.stringify` 嵌入，脚本走 stdin、子进程 argv 全是数组；直链主机与响应 URL 都有匹配约束。但同一批输入的两条下游没处理：输出目录的包含性（F-PAT-014）与临时文件的独占创建（F-PAT-015）。
- H10：**新增一条相关观察**。ego-browser 的输出以 `EGO_<tag>:` 单行 JSON 回传，解析在 `extractTaggedJson`，页面文本本身不进会话事件；是否需要单独记录原始回传，Day 11 一并判断。
- H03、H06、H07：本轮未触及。

## 未决问题

1. F-PAT-014 的严重度取决于产品对「模型能否写任意目录」的取舍：若保留该能力，应改为部署级 `Config` 白名单，而不是模型参数。
2. `patent_pdf_download` 的 `patent` 归一化只拒绝 `\` 与 `..`，未处理 Windows 保留设备名（`CON`、`NUL`）与尾部点/空格；是否需要在 Day 34 的正确性维度补一条边界用例。
3. `workbench-link-patent-case.ts:395` 的回环 `fetch` 留到 Day 8 与其它 webServer 调用一起看。

## 明日第一件事

Day 7：专利域-2，检查 `patent-knowledge`、`patent-rule`、`patent-law`、`patent-fees` 的 SQL/FTS 查询是否参数化、索引与规则资产路径是否可被输入影响、引用核验失败是否 fail closed。
