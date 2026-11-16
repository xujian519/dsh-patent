# Day 33 — 2026-12-17

## 今日维度与范围

- 维度：D 测试缺口
- 范围：覆盖率豁免审计与 D 维度汇总
- 时间盒：90 分钟
- 预期产出：D 维度汇总与豁免审计；daily/day-33.md

## 检查项

- [x] 审计 coverage-exempt 清单。
- [x] 审计 vitest 平台排除项。
- [x] 列出四域未覆盖文件。
- [x] 判断豁免合理性。
- [x] 汇总 D 维度并更新假设状态。

## 实际执行

**口径（10 分钟）**：Node `v24.19.0`。不改业务代码。今日没有重跑全仓 `test:coverage`，也没有重跑四域测试套件。本卡所说的「未覆盖」是每文件门禁的 `coverage.exclude` 匹配到的源文件，不是已纳入文件内部的未测分支，也不报每文件百分比。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不重测。没有启动 ffmpeg、Chrome、LibreOffice，也没有访问云 provider。H09 的旧数字不改。

**重套件豁免（15 分钟）**：`scripts/coverage-exempt.ts` 的 `coverageExemptHeavySuites` 有 9 个成员。成员规则写在文件头：一套件能豁免，仅当它在进程内执行到的、已被覆盖率纳入的文件，都已由其他套件盖满；聚合仍会不插桩再跑这些套件。9 个成员是 `packages/typert/*/tests/**`、`packages/experimental/webworker-runtime/tests/**`、`scripts/gen-client-catalog.spec.ts`、`scripts/install-lefthook.spec.ts`、`scripts/oxlint-contract.spec.ts`、`scripts/change-scope.spec.ts`、`scripts/persistence-schema.spec.ts`、`scripts/persistence-epoch-header.spec.ts`、`packages/experimental/webworker-packer/tests/image-loadable.spec.ts`。没有专利、文档、法律、`law`、`video-mode`、`video-bundle`、`ui-video-studio` 的套件。`DSH_COVERAGE_EXEMPT_HEAVY` 只有值为 `1` 时，`vitest.config.ts:151` 才把这些 exclude 放进 thread-safe（`:237`）和 process-bound（`:256`）；其他非空值会抛错。今日没有设置该变量，也没有启动插桩门禁。

**平台排除（15 分钟）**：`platformUnsupportedTests`（`vitest.config.ts:76`）由 `windowsUnsupportedTests`（`:45`）和 `nonLinuxWebWorkerTests`（`:69`）组成，挂在 `test.exclude`（`:215`），不从 `coverage.include` 里拿掉源文件。Windows 项是 bash、ssh、sandbox-local、subprocess 与 webworker 的部分套件。非 Linux 项是 webworker 的 `fs-watch-stream.spec.ts` 与 `sandbox-stack.spec.ts`。覆盖率尾部再铺开四组源排除：`windowsUnsupportedCoveragePackages`（`:78`）、`windowsOnlyCoverageExclusions`（`:86`）、`windowsRunnerCoverageExclusions`（`:101`）、`pwshCoverageExclusions`（`:130`），在 `:445`–`:448` 展开。它们指向 shell、subprocess、sandbox-windows-acl、session lease、cua-macos、forge 与 pwsh。`ui-video-studio` 不在客户端 GUI 债务排除里。命名排除从 `:277` 到 `:444` 没有专利、文档、法律、`law` 或视频三包的路径。专利包的注释在 `:289`–`:294`：按包豁免，已发布的专利包都纳入每文件门禁。

**四域门禁不量的文件（25 分钟）**：`coverage.include` 是 `packages/*/*/src/**/*.{ts,tsx}`（`:266`）。四域按目录计 30 个包、639 个 `src` 的 ts/tsx：专利 16 包 513 个，文档 6 包 44 个，法律 3 包 36 个，`law` 2 包 16 个，`video-mode` 22 个，`video-bundle` 1 个，`ui-video-studio` 7 个。全局排除 `packages/*/*/src/types.ts`、`bin.ts`、`worker.ts`（`:273`–`:275`）和 `oxlint-contract-*.ts`（`:300`）只打在包的 `src` 根上。四域命中 20 个文件，没有 `worker.ts`，没有 `oxlint-contract-*.ts`。嵌套的 18 个 `types.ts` 不匹配这条 glob，仍在 include 里。`law` 两包、`video-bundle`、`ui-video-studio` 以及 `patent-document`、`patent-index-asset`、`patent-rule`、`patent-tools`、`tool-literature`、`document-deliver`、`tool-office` 的 `src` 根没有被这四条 glob 命中。

| 域 | 门禁不量的包根文件 |
|---|---|
| 专利 | `methodology`、`patent-core`、`patent-data`、`patent-deadline`、`patent-fees`、`patent-filing`、`patent-knowledge`、`patent-law`、`patent-teams`、`patent-workflow`、`writing-patterns` 的 `src/types.ts`；另有 `patent-knowledge/src/bin.ts` |
| 文档 | `doc-style`、`doc-template`、`docx-kit`、`office-kit` 的 `src/types.ts` |
| 法律 | `legal-evidence`、`legal-knowledge`、`legal-law` 的 `src/types.ts` |
| 视频 | `video-mode/src/types.ts` |

**豁免是否合理（10 分钟）**：合理，且没有藏住四域关键路径。重套件成员符合文件自己的成员规则，平台项排除的是别的操作系统或 webworker 对照套件。包根 `types.ts` 的可执行同伴是词表常量、错误类和 `assertNever`，这是 `packages/AGENTS.md` 写明的词表文件。多出来的两个函数：`headingLevelOf`（`docx-kit/src/types.ts:193`）由 `docx-kit/tests/index.spec.ts:27` 断言 3 与 7；`isPatternCategory`（`writing-patterns/src/types.ts:71`）的调用在已纳入门禁的 `pattern-store.ts:252`。`patent-knowledge/src/bin.ts` 是自执行入口。`vitest.config.ts:267`–`:271` 写明导入 bin 会在单测进程里启动它，入口胶水由子进程用例覆盖。`bin.spec.ts:10` 只断言 `--help`。`:49` 的安装调用进入已纳入门禁的 `install.ts`。这 20 个文件不够格另开编号。

**D 维度汇总（15 分钟）**：D27–D32 新编号 9 条，状态都是 new。Day 31 视频域没有新编号。C 阶段的 F-PAT-032 不计入这 9 条。8 条 Medium，1 条 High。这 9 条都在门禁已经纳入的文件里：删掉监听摘除、sha1 字段或先删后改名，现有成功用例仍然通过。行与分支 100% 盖不住这种断言缺口。豁免清单没有把它们排除在门禁之外。

| 簇 | 成员 | 落点 |
|---|---|---|
| 成功返回后没有锁住监听摘除 | F-PAT-033、F-PAT-035、F-PAT-037、F-DOC-007 | `patent-tools` 附图截止期、`patent-teams` 等待、`patent-document` PDF 渲染、`office-kit` 队列 |
| 成功路径没有锁住校验、终态或处置 | F-PAT-034、F-PAT-036、F-PAT-038、F-LEG-010 | PDF 清单 sha1、`patent-teams/src/state.ts:38` 的未完成依赖、nuo 检索抛错、未核验引用的处置投影 |
| 覆盖安装先删输出再改名 | F-CROSS-003 | `knowledge-core` 的 `install-fs.ts`，专利与法律安装都调用 |

## 发现

发现：无。

下面这些不够格单列：

1. 9 个重套件成员都不在四域。成员规则要求被它们执行到的、已纳入门禁的文件由其他套件盖满，聚合仍不插桩重跑。
2. 平台 `test.exclude` 与 Windows、pwsh 的源排除指向 shell、subprocess、sandbox、session lease、cua、forge 和 webworker，不指向四域包。
3. 四域 20 个被全局 glob 丢掉的文件是包根词表和一条安装入口。词表同伴与 `--help` 子进程用例已有着落，安装逻辑在 `install.ts`。

同构观察、不另开编号：四条监听摘除已经各有编号（F-PAT-033、F-PAT-035、F-PAT-037、F-DOC-007）。今日不合并，也不把包根 `types.ts` 收成一条新的跨域编号。

## 假设验证/推翻

H06 改为部分推翻（Day 33）。9 条新缺口里，监听摘除、清单 sha1、依赖终态和引用处置都在已纳入每文件门禁的库与插件文件里。F-PAT-038 是检索 provider 的抛错。视频、CNIPR、Office 和 PDF 的失败路径在各自日卡里已有断言。四域唯一的 bin 是已写明的安装入口，没有形成 CLI 聚集。

H08 改为推翻（Day 33）。重套件清单、平台排除和命名源排除都没有拿掉四域关键路径。门禁不量的 20 个文件是文档化的词表与入口胶水。D 阶段的 9 条缺口留在门禁已经量的文件里，原因是断言太弱，不是豁免清单。

H01–H05、H07、H09、H10 今日不改。H03 维持 Day 23 的句子。H09 的旧数字维持 Day 19 的写法。

## 未决问题

1. 全仓 `test:coverage` 今日没有重跑。619 个仍在 include 里的四域源文件不写成 100%。
2. 没有在 Windows 上重跑平台排除。结论来自 `vitest.config.ts` 里的路径数组。当前主机是 macOS，非 Linux 的 webworker 对照套件会从测试收集里去掉，它们的源本来就在 webworker 排除里。
3. `patent-knowledge` 的 bin 除 `--help` 外没有子进程用例。今日没有执行安装，也没有启动 ffmpeg、云 provider、LibreOffice 或 Chrome。

## 明日第一件事

Day 34（E 正确性与边界：专利域-1，`patent-tools` 与 `patent-core`）第一件事：检查类型边界与 unknown 输入、claim 与 evidence 的业务不变量、错误码与失败报告、静默降级，并附证据。F-PAT-032 至 F-PAT-038、F-DOC-007、F-LEG-010、F-CROSS-003、F-VID-001 至 F-VID-010 不要重测。不要启动真实 ffmpeg、云 provider、LibreOffice 和 Chrome。H09 的旧数字不要改。
