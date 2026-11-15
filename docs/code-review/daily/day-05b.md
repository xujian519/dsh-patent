# Day 5b — 2026-11-15 D1–D5 代码质量复审（补充轮）

> 本页是计划外补充轮。D1–D5 只做定向，未判定缺陷；本轮把那些结构观察落实成可执行发现，记录在 [05-findings.md](../05-findings.md) 与 [06-priority.md](../06-priority.md)。

## 今日维度与范围

- 维度：B 代码质量与精简，兼收 E 正确性信号
- 范围：D1–D5 已定向的 30 个包——专利域 17 包、文档模式 6 包、法律模式 3 包、共享机制 2 包、视频模式 3 包
- 时间盒：约 150 分钟（五路并行只读审阅，加人工复核）
- 预期产出：可执行的发现清单、候选优先级与根因分组

## 检查项

- [x] 对四域分别做只读深审，覆盖重复、死代码、抽象错位、复杂度、命名与契约、类型安全、错误处理、注释准确性。
- [x] 对每条高严重度结论做独立复核，证伪或降级不可复现的项。
- [x] 记录工具证据与退出码，区分机器可测与只可人工判断的项。
- [x] 把发现落到 `05-findings.md`，把排序与根因落到 `06-priority.md`。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 五路只读深审（专利核心组、专利外围组、文档组、法律组、视频组） | 均只读，未修改任何文件；各组返回带文件行号的结论 |
| `pnpm run duplication` | exit 0；3885 文件 / 804,636 行，0 处克隆；运行环境为默认 Node v22.22.3（有 engines 警告，不影响扫描） |
| 类型逃逸计数（`any` / `as unknown` / 非空断言） | patent 82/159/575；document 18/11/13；legal 11/0/44；law 0/0/1；video-mode 5/0/0 |
| TODO 标记扫描 | 13 处命中，其中 `patent-core/src/adversary/` 6 处（3 处源码、3 处 `lib/` 构建产物）均自认“确定性骨架，完整版需模型” |
| 关键结论逐条复核 | 复核 20 条，确认 18 条，证伪 1 条，降级 1 条（见下） |
| `git status --short` | 仅 `M scripts/translation-pairing.manifest.json` 与 `?? docs/code-review/`，未产生业务代码改动 |

## 结论概览

共 29 条发现：High 9、Medium 10、Low 10；无 Blocker。候选 P0 9 条、P1 10 条、P2 6 条、P3 4 条。

分域看：

- **专利域 13 条**。最重的是原子写：仓库已有 `packages/util/atomic-write`（`wx` 独占创建、Windows 瞬态重试、文件与父目录 fsync、跨进程文件锁），`patent-tools` 已在用，`patent-core` 未声明，四包又各写一份。其次是 `patent-document` 在 POSIX 上无条件“先删后改名”，以及 `adversary-review` 用关键词启发式渲染出“整体置信度 87.5%”。
- **文档模式 5 条**。最重的是 `docx-kit` 的 Markdown 解析没有围栏代码块分支，围栏内的 `#` 行会被渲染成标题、`|` 行会被拼成表格——交付的 DOCX 与源文本静默不一致。另有 OOXML 限额与插件默认值两处双源。
- **法律模式 5 条**。最重的是 `legal-law` 的名字表是模块级只增状态（会造成假拦截），以及 `legal-evidence` 的 YAML 通用规则从不参与判定——改 `severity` 完全不生效。
- **视频模式 6 条**。最重的是 journal 与账本没有跨进程写守卫，而 `ctx.fs` 已提供 `replaceIfVersion`；其次是成功任务缺 `output_path` 时不清 journal、不记账。

## 复核与更正

- **证伪**：`knowledge-core` 根入口同时导出纯函数与 `node:fs` 安装助手。消费者只有 `patent-core`、`patent-knowledge`、`legal-knowledge` 三个 Node 侧包，不进入客户端构建，不构成实际问题；不立发现。
- **降级**：`patent-core` 自称“Pure TypeScript library”。README 正文已限定为“no `ctx` dependency”，且明确“the package registers nothing”，描述准确；只有 `package.json` 的 description 少了限定语，记为观察，不立发现。
- **推翻**：Day 3 提出的“资产定位不一致”。`patent-rule`/`law`/`fees`/`deadline`/`writing-patterns` 用单层 `../assets` 且在主进程内经 Electron fs 垫片读取；`patent-document`/`filing` 因嵌套更深或资产交给 Python 子进程，必须用双候选路径加 `unpackedFsPath`。两类在 ASAR 下都能命中，真正的问题是失败方向不一致。
- **机器证据的边界**：`jscpd` 在默认阈值下 0 处克隆，说明本轮“重复”全是语义级重复，克隆门禁抓不到；这类问题只能靠固定实现位置加 lint 规则防回归。

## 假设验证/推翻

- H01：**部分确认**。`patent-core` 无 `ctx` 依赖成立，但有 5 个 src 模块直接做 fs I/O；README 已限定语义。是否搬迁留到 Day 13。
- H02：**确认**。决策层共享成立（两域同一 `decideArticleCitation`），检索骨架层未收拢——两域各有一份 SQLite 检索基类，`knowledge-core` 只共享阶梯函数。
- H07：**出现新形态**。“未核验降级”之外，`legal-evidence` 的 YAML 规则是“看起来是门禁、实际不参与判定”；这比降级更隐蔽，Day 38 复核交付链路时一并检查。
- H10：**确认缺口**。`patent-workflow` 的 `patent/model-call` 在流异常时不落事件；视频 journal 可能因跨进程写丢失。两者都违反“Model-visible ⟺ logged”。
- H06：**待验证**，本轮未做测试缺口专项。

## 未决问题

1. 优先级公式让所有 High 且可能性不低于中的条目落入 P0，候选 P0 因此有 9 条。本轮把 P0 解释为“最高修复优先级”而非“停线”，正式口径留到 Day 42。
2. 批次 A（复用收口）已按用户确认实施，结果见下节。
3. `legal-evidence` 的通用规则若改为 YAML 驱动，会改变现有评估结果的门槛来源，需要先确认是否有部署依赖当前硬编码行为。

## 批次 A 实施（同日）

用户确认后执行「复用收口」，这是本轮唯一一次业务代码改动，超出计划原先“只写文档”的约束。

改动：

- `patent-core`、`patent-document`、`patent-tools` 的原子写改为委托 `@deepseek-ai/dsh-atomic-write`；`patent-document` 的无条件先删后改名随之删除。
- `patent-tools` 的 `knowledge-note-file-writer` 改从 `patent-core` 导入 `atomicWriteJson`。
- `docx-kit` 导出 `DEFAULT_ZIP_READ_LIMITS`；`office-kit` 与 `document-deliver` 改引同一常量。
- `document-deliver` 与 `doc-template` 的 `Config` 改为必填字段加 `z<Partial<Config>, Config>`，schema 成为唯一默认源。
- 共享包 `writeFileAtomic` 修正“临时文件清理失败覆盖原始错误”，由既有测试暴露。

保留项：`patent-teams` 的 `atomicWriteText` 保留其 Windows 直接覆写降级；`F-VID-005` 留到批次 B。

验证：`pnpm run typecheck` 5/5 通过；`pnpm run lint` exit 0；`pnpm exec vitest run` 267 个测试文件、5128 用例通过、4 skipped；模块图检查通过。

## 明日第一件事

Day 6：进入 A 安全维度，先看 `patent-data` 与 `patent-tools` 的外部输入到危险汇点：CNIPR/nuo 请求参数、ego-browser 子进程的 argv/env、PDF 下载脚本与文件路径。
