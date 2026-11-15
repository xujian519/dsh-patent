# Day 9 — 2026-11-23

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-23）。

## 今日维度与范围

- 维度：A 安全缺陷
- 范围：文档模式：office-kit、docx-kit、doc-template、doc-style、document-deliver、tool-office
- 时间盒：90 分钟
- 预期产出：A 维度文档域候选发现；daily/day-09.md

## 检查项

- [x] 检查 office-kit 的子进程 argv、临时目录与清理。
- [x] 检查 docx-kit 的 ZIP 解压路径穿越与大小限制。
- [x] 检查 doc-template 的变量替换与 HTML/Markdown 注入。
- [x] 检查 document-deliver 与 tool-office 的输入边界。
- [x] 记录候选发现与证据。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 扫 office-kit 的进程与临时目录 | `office-kit` 自身不拼 argv；LibreOffice 调用在 `@deepseek-ai/libreoffice-kit` 内，入口由使用方的 `import.meta.resolve` 解析，不来自模型输入 |
| 读 scratch 与 outputs | `mkdtemp` 建私有目录、输入文件 `wx` + `0o600`、`finally` 清理；启动清扫只处理真实目录且跳过链接与联结 |
| 读 zip.ts | `readZip` 按 `maxArchiveEntries` 与 `maxUncompressedBytes` 限流；entry 名只解码、不当文件路径 |
| 读 doc-template 渲染链 | 模板 id 按 manifest 校验；HTML 变量经 `escapeVariables`，链接与图片只放行 http/https/mailto 与相对地址；落盘经 `ctx.fs` |
| 查 document-deliver/tool-office | 读取经 `ctx.fs` 并带字节上限；DOCX 解析复用 `ZipReadLimits` |

## 发现

**无。** 今日范围未发现可执行的安全缺陷。

定向结论（记录以免后续重复怀疑）：

- **office-kit 的临时目录与清理是完整的**：每次转换一个 `mkdtemp` 目录，输入以 `wx` + `0o600` 写入（拒绝预置符号链接），输出在 `finally` 里递归删除，删除失败只记警告不掩盖原错误；启动清扫按名字正则、真实目录、mtime 截止三重过滤，跳过链接与联结。
- **ZIP 路径穿越当前不可达**：`readZip` 不解码后拼接任何文件路径，包内没有"按键名解压到磁盘"的 API；`document-deliver` 只做内存抽取。`readZip` 经 `./src/*` 子路径对外可达，若将来有消费者按 entry 名落盘，需要自带名字校验——已记入未决问题。
- **doc-template 的两个面都已处理**：模板 id 先按 `manifest.json` 白名单校验再拼路径；HTML 输出里变量经 `escapeVariables`，链接与图片经 `isDeliverableUrl` 拒绝 `javascript:`、`data:`、`vbscript:` 与协议相对地址，且剥离空白与控制字符后再判协议。
- **落盘走部署策略**：`render_doc_template` 的 `output_path` 经 `ctx.fs.resolve` 再由 `ctx.fs.writeText`/`writeBytes` 写入，被部署拒绝时调用失败——与 F-PAT-014 的 `node:fs` 直写形成对照，是专利域那条修复应当对齐的写法。

## 假设验证/推翻

- H03：**定向未证实，仍不立发现**。office-kit 的队列、缓存、scratch 与输出存储都有显式释放；取消与超时路径的完整验证留到 Day 23 的资源生命周期维度。
- H05：**文档域方向已确认无问题**。模板注入与路径穿越两条汇点都做了边界处理。
- 其余假设本轮未触及。

## 未决问题

1. `docx-kit` 的 `readZip` 不对 entry 名做穿越校验；当前无落盘消费者，但如果将来加"解压到目录"的能力，需要在 `readZip` 或新 API 内拒绝绝对路径与 `..` 段。留到 Day 39 复核是否已有新消费者。
2. `render_doc_template` 的 `output_path` 允许绝对路径，安全性完全依赖部署的 fs 策略；若某部署挂的是不限制的本地后端，这里与 F-PAT-014 是同一类敞口。是否要在工具层也加包含性校验，留到 Day 38 与交付门禁一起定。
3. `office-kit` 的转换在 `libreoffice-kit` 内，argv 与子进程环境不在本仓可审范围；Day 23 读该包时补。

## 明日第一件事

Day 10：法律模式与共享机制，检查 `legal-law`、`legal-evidence`、`legal-knowledge` 的输入边界、索引加载与"未核验"语义是否可被绕过。
