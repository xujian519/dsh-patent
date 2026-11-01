# #651 导出面清理 — 执行计划与记录

- 依据：[xujian519/dsh-patent#651](https://github.com/xujian519/dsh-patent/issues/651)（父 [#645](https://github.com/xujian519/dsh-patent/issues/645)）。
- 扫描产物：`tmp/export-surface-scan/`（`scan.mjs`、`zero-ref.json`、`file-local.json`、`triage-sheet.md`）。
- 约束：不恢复 Knip / 不新增全仓死导出门禁（[`2026-08-19-remove-knip`](../notes/archived/process/2026-08-19-remove-knip.md)）。
- 与 [#655](https://github.com/xujian519/dsh-patent/issues/655) 边界：本计划只处理导出关键字与零引用符号，不接线专利零消费模块。

## 0. 执行原则

1. 先重扫落盘，再分流，再按风险分 PR；禁止盲剥入口文件的 `export`。
2. 删除项必须有零引用证据；SPECIAL-KEEP / PUBLIC-API 必须写保留理由。
3. 每个批次跑触及包 vitest + 相关门禁；不新增 `as unknown`、无理由 suppress。
4. 公开 barrel 上的删除走 upgrade guide。

## 1. 基线漂移（2026-11-01 重扫）

| 指标 | Issue #651 (2026-10-31) | 修正口径重扫（EXP-01 后） |
|---|---:|---:|
| 定义语料 | 3,777 `src` | 3,779 `src` |
| 导入语料 | （未写明） | `src` + `tests`（测试深引用计入） |
| 零引用（本地声明） | 48 | **86**（type+interface **19**） |
| 仅本文件 export（非入口） | 1,039 | **1,368** |
| 浓度序 | patent-tools → better-sidebar → liveshare… | 同序（133 / 108 / 71 / …） |

口径：只计 `function|class|interface|type|enum|variable` 的本地 `export`，不计 barrel `reexport`；外部引用含命名导入、`export *` 传递，以及 **tests/** 对 `src` 的导入。

## 2. 任务总览

| ID | 优先级 | 任务 | 状态 |
|---|---|---|---|
| EXP-00 | P0 | 一次性 AST 重扫 + triage 表 | 完成 |
| EXP-01 | P0 | DELETE-safe 零引用删除（PR-A） | 完成（§3 + UseChatNode 等第二批） |
| EXP-02 | P1 | SPECIAL-KEEP 保留说明（PR-B） | 完成（核心 AssertNever / stub） |
| EXP-03 | P1 | PUBLIC-API 文档（PR-C） | 完成（CUA 别名 / WorkerExecutionRecord / ContextForm） |
| EXP-04 | P2 | 仅本文件 export 按包剥离（PR-D*） | 完成：非 publicStar 候选已剥；深路径/脚本引用已恢复 |
| EXP-05 | P3 | 验收、更新 #651/#645 | typecheck + verify-export-jsdoc 已过；待提交/关 issue |

## 3. EXP-01 DELETE 清单（已改）

| 符号 | 文件 | 动作 |
|---|---|---|
| `SidebarOk` / `SidebarErr` | `client/better-sidebar/src/wire.ts` | 删除接口 |
| `RosterPreset` | `client/ui-agent-preset/.../settings-store.ts` | 删除类型别名 |
| `ApprovalInteractionKind` | `client/ui-approval/.../slots.ts` | 删除类型别名 |
| `TodoBoardTranslate` | `client/ui-todo-board/.../locales.ts` | 删除类型别名 |
| `coordinate` | `client/ui-chat/.../common.ts` | 删除死函数 |
| `FsDiffMeta` | `fs/tool-fs/src/diff.ts` | 删除类型（meta 仍以 `unknown` 传递） |
| `ExaSearchRequest` | `web/web-search-exa/src/types.ts` | 删除接口 |
| `PerplexityRequest` | `web/web-search-perplexity/src/types.ts` | 删除接口 |
| `catalogSnapshotEntrySchema` / `catalogQuerySchema` | `host/plugin-market/src/catalog-schema.ts` | 删除未接线 schema |
| `ShareAuditEntry` | `experimental/liveshare/.../share-types.ts` | 删除（保留 `ShareAuditEntryView`） |
| `ForkViewer` | `experimental/liveshare/.../fork-policy.ts` | 删除 |
| `OWNER_LOGIN_REQUIRED` / `RELAY_UPGRADE_REQUIRED` | `experimental/liveshare/src/owner-identity.ts` | 删除未用常量（线协议仍用字面量） |
| `Fetch*Payload` + `FetchIdentity` | `experimental/inspector/.../network/observation.ts` | 删除；保留 `InspectorHeader` / `InspectorEventSourceMessage` |

## 4. SPECIAL-KEEP / PUBLIC-API（待 PR-B/C）

见 `tmp/export-surface-scan/triage-sheet.md`：`NoUnclassifiedEndpoint`、Vite `node-module-stub`、`posixPath` 成员、生成 catalog、`llm-pi-ai` 编译期断言；以及 CUA / `WorkerExecutionRecord` 等经 `export *` 上架的类型。

## 5. 验证命令

```sh
node tmp/export-surface-scan/scan.mjs
pnpm exec vitest run <touched-packages>/tests
pnpm run typecheck
pnpm run verify-export-jsdoc
pnpm run verify-client-ui-i18n   # 若触及 locale 导出
```

## 6. 不做的事

- 不恢复 Knip；不把扫描器挂进 hygiene。
- 不并入 #648 / #654 / #655。

## 7. 执行记录

- 2026-11-01：完成 EXP-00（修正：tests 计入导入图）。
- 2026-11-01：EXP-01 删除 §3 清单；聚焦 vitest 835 + 425 通过。
- 2026-11-01：EXP-02 为 AssertNever / Vite stub / llm-pi-ai 断言补「有意零引用」说明。
- 2026-11-01：EXP-04 试点剥 `BoardCard`/`BoardColumns`/`FetchCommands`/`MenuSection`/`PlanAddress`/`PanelPins`/`ConnectionWebSocketEventMap`。
- 2026-11-01：EXP-01 续删 `UseChatNode*`、`ConsumeTokenGuard`、`ZoomLocaleKey`、inspector 死类型、`ChildCreateInputs`；EXP-03 为 CUA/`WorkerExecutionRecord`/`ContextForm` 补公开面说明。
- 2026-11-01：EXP-04 批量剥 `patent-tools`(133)、`better-sidebar`(108)、`liveshare`(71)、`inspector`(56)、`apps/desktop`(44)、`ui-schedule`(34)、`webworker-runtime`(33) 及后续若干包；修复扫描器对 `@pkg/src/foo.ts` 深路径解析；恢复测试仍导入的 13 个符号。
- 2026-11-01：`verify-export-jsdoc` 绿；修 liveshare `LIVESHARE_VIEWER_GLOBAL` JSDoc 与 import 顺序。
- 2026-11-01：长尾 demote 清零后 typecheck 暴露深路径/脚本引用，已恢复：`runCli`、`runSelectedSubprocessRunner`、Cordis `name`（headless/web-app）、`PrefsSchema`、`optionalStringArray`、`ConversationSession*Props`、`readDesktopCorePackageSet`、`welcomeWindowOptions`、`TypertWorkerError`/`decoratorPlugin`、`detailPath`。
- 终态重扫：零引用 **75**；非入口 file-local **136**（publicStar **124** + 有意保留深引用 **12**）；`demoteLeft` **0**（扫描里 12 项为恢复后仍无 src 导入的测试/脚本出口）。
- 验收：`pnpm run typecheck` 5/5 通过；`verify-export-jsdoc` 通过。未提交；关 #651/#645 待用户授权提交与评论。
