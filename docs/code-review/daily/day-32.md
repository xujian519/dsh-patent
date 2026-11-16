# Day 32 — 2026-12-16

## 今日维度与范围

- 维度：D 测试缺口
- 范围：跨域失败路径：网络、权限、磁盘、部分写入
- 时间盒：90 分钟
- 预期产出：D 维度跨域候选发现；daily/day-32.md

## 检查项

- [x] 列出网络超时与取消的用例缺口。
- [x] 列出权限拒绝的用例缺口。
- [x] 列出磁盘满与只读的用例缺口。
- [x] 列出部分写入与恢复的用例缺口。
- [x] 写具体测试用例建议。

## 实际执行

**基线（10 分钟）**：Node `v24.19.0`。不改业务代码。今日没有重跑全仓 `test:coverage`，也没有重跑四域测试套件。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、F-VID-001 至 F-VID-010 不重测。没有启动 ffmpeg、Chrome、LibreOffice，也没有访问云 provider。

**网络超时与取消（20 分钟）**：文献下载在 `paper-download.spec.ts:589` 卡住直链，`:614` 卡住记录拉取，`:642` 卡住浏览器抽取，文案都是 `paper_download timed out`。`:747` 与 `:804` 在连接器拉取和 PDF 拉取期间传播调用方取消。`network-fetch.spec.ts:57` 中止在途请求，`:193` 在重试等待期间接受父信号，`:251` 把本地中止标为超时。PDF 兜底在 `patent-pdf-download.spec.ts:772` 把挂起的 fetch 记为 `network_timeout`，`:615` 把已取消的 ego 运行记为 `tool_aborted`。`patent-pdf-download-ego.spec.ts:116` 把脚本超时记为 `tool_execution_failed`，`:136` 转发调用方信号。Office 队列、CNIPR 和视频 provider 的超时与取消已在 Day 30、Day 29 和 Day 31 对过，今日不重开。

**权限拒绝（15 分钟）**：`errno.spec.ts:11` 把 `EACCES` 与 `EPERM` 映射为 `FS_PERMISSION_DENIED`。`fsio.spec.ts:1029` 把不可写的父目录映射为同一代码，`:1089` 把不可读文件映射为同一代码，`:828` 在 Windows 替换被 `EACCES` 拒绝后仍读到旧内容。`engine-package.spec.ts:125` 注入安装目录的 `EACCES`。`tool-office.spec.ts:608` 与 `:631` 带上 `permission denied` 和 `FS_PERMISSION_DENIED`。`state.spec.ts:803` 重试 `EPERM`，`:874` 注入 `EACCES`。`project.spec.ts:84` 让项目读取在权限错误时抛出。`document-deliver.spec.ts:919` 把不可读稿件记为 `permission denied`。`figure-inkscape-renderer.spec.ts:379` 断言原子写的 `EACCES`。

**磁盘满与只读（15 分钟）**：专利、文档、法律、`law` 和视频的 `src` 里没有 `ENOSPC` 或 `EROFS` 分支。`errno.ts:30` 把其余 errno 收成 `FS_IO_ERROR`，`errno.spec.ts:14` 用 `ELOOP` 锁住这条默认。附图索引、起草笔记和工作流保存把注入的 `disk full` 收成警告：`figure-output.spec.ts:39`、`drafting-engine.spec.ts:1102`、`workflow-store.spec.ts:104`。这些路径今日不另开编号。

**部分写入（25 分钟）**：本地文件系统的整文件写入走 `writeFileAtomic`。替换失败时 `fsio.spec.ts:838` 断言旧内容仍在，临时目录被清掉。共享 `atomic-write` 的 Windows 改名重试在 `atomic-write.spec.ts:183` 耗尽后不留临时兄弟文件。视频的项目、账本和 journal 经 `ctx.fs.writeText` 走同一条发布。知识库安装不走这条缝。`commitTempSibling`（`install-fs.ts:59`）在输出已存在时先 `rmSync`（`:62`）再 `renameSync`（`:64`）。成功覆盖由 `install-fs.spec.ts:82` 断言。改名失败没有用例。专利与法律安装都调用它（`patent-knowledge/src/install.ts:212`，`legal-knowledge/src/install.ts:110`）。这是 F-CROSS-003。F-PAT-001 与 F-VID-004 不重开。

## 发现

- [F-CROSS-003](../05-findings.md)：知识库安装覆盖时先删输出，改名失败没有用例。

下面这些已有断言，不够格单列：

1. 文献下载、文献传输、PDF 兜底的超时和调用方取消已有直接断言。Office、CNIPR 和视频 provider 的同类断言留在各自日卡。
2. `EACCES` 与 `EPERM` 的文件系统分类、不可写目录、不可读文件、Office 安装目录、工具拒绝、团队锁、视频项目读取和稿件不可读已有直接断言。替换被拒绝后保留旧内容已有断言。
3. 附图索引、起草笔记和工作流保存在注入 `disk full` 后给出警告，且不把该错误当成成功。`ENOSPC` 落入 `FS_IO_ERROR` 的默认分支已由 `ELOOP` 锁住。

同构观察、不另开编号：视频经 `ctx.fs.writeText` 发布项目、账本和 journal。失败时保留旧文件的断言在 `fsio.spec.ts:828`。F-VID-004 的 ffmpeg 覆写不在本条重开。

## 假设验证/推翻

H06 仍待验证。今日网络超时、取消和权限拒绝大多已有断言。新缺口在知识库安装的先删后改名（F-CROSS-003）。覆盖率豁免留到 Day 33。H01–H05、H07–H10 的验证点不在今日，状态不改。H03 维持 Day 23 的句子。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。本卡不把某个文件写成 100%。
2. 没有把磁盘写满，没有把目录改成只读再安装知识库，也没有启动 ffmpeg、Chrome、LibreOffice 或云 provider。
3. 没有注入失败的 `renameSync` 再跑 `install-fs.spec.ts`。结论来自 `:62` 先于 `:64`，以及 `:82` 只断言成功覆盖。

## 明日第一件事

Day 33（D 测试缺口：覆盖率豁免审计与 D 维度汇总）第一件事：审计 coverage-exempt 清单和 vitest 平台排除项，列出四域未覆盖文件，判断豁免是否合理，并汇总 D 维度。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、F-CROSS-003、真实 ffmpeg、云 provider、LibreOffice 和 Chrome 不要重测。H09 的旧数字不要改。
