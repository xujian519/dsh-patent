# Agent Note: 成文步骤验收自己写出的成品

Status: implemented

[English](2026-11-18-filing-build-accepts-its-own-output.md) | 中文

## Problem

`build_patent_filing` 写出 DOCX 后，返回的是它以为自己写了什么的计数。进入交付件的缺陷恰恰是这些计数看不见的：某一节声明了却没承载内容、页眉缺失或错位、编号断档、图序错位。`verify_patent_filing` 读成品，能抓到这些，但它是一次可选的第二次调用——模型得记得去调；而 preset 的交付门禁只能记下本会话里某个工具返回过 `passed: true`，记不了交付的那份文件就是被验过的那份。

## Decision

- `buildFiling` 对刚写出的路径跑 `verifyFiling`，把结论作为必填字段 `FilingBuildResult.verification` 返回。引擎的每个调用方都拿到验收结论，不必有人记得去要。
- 验收不通过是成功的领域结果：调用正常返回，`verification.passed` 为 false，成品留在盘上。这与引擎既有的立场一致——引擎非零退出仍是已报告的领域结果；同时让写出的文件与其结论待在一起：抛错会把「文件已存在」搬进错误信息，诱导调用方认为成文失败。
- 验收完全产不出报告——子进程失败或输出不可解析——则抛 `PatentFilingError` 并点名已写出的路径。此时结果未知，不能让调用方以为什么都没写。
- `VERIFY_RESULT_SCHEMA` 移到 `schemas.ts`，两个工具都从那里导入，成文结果的 `verification` 字段与 `verify_patent_filing` 的结果因此不会各自漂移。
- 验收放在引擎而不是工具包装层，因为写出与验收是同一次操作。包装层只覆盖本工具的调用方；引擎覆盖 `buildFiling` 的每一个消费者。

## Alternatives considered

- **把 `verify_patent_filing` 加进 preset 的交付门禁前置。** 门禁会要求模型调用它，但证明的仍是本会话里某次 `verify_patent_filing` 通过了——不是它读的是这一次成文的文件。
- **在 `build-patent-filing.ts` 里于 `buildFiling` 返回后跑验收。** 引擎保持单一职责，但结论落在引擎已经拥有的结果类型之外，第二个引擎消费者会静默拿到一份没有验收的成品。
- **验收失败就抛错。** 文件已在盘上；抛错会把一份写出的文件报成失败的成文，并把断言明细塞进错误字符串。
- **以验收结论把关，不通过的成品不保留。** 删除或扣下文件会藏起模型需要检视的产物，而缺陷在草案里，不在文件是否存在。

## Consequences

- 每次成文多启动一个 Python 子进程。成文本就依赖随包解释器，因此不新增失败类别，两次调用共用配置的 `timeoutMs`。
- `FilingBuildResult` 增加一个必填字段：每个消费者与测试替身都要构造 `verification`。工具 schema 与渲染文本增加了结论行；不通过时，结论行点名成品已在盘上，下面逐条列出未通过的断言。
- 模型成文后不再需要补一次 `verify_patent_filing`；该工具保留，用于验收不是本会话成文的文件。

## Testing

- 引擎（`packages/patent/patent-filing/tests/engine.spec.ts`）：通过的验收返回 `verification.passed` 与同一路径；不通过的报告正常返回、`verification.passed` 为 false 且文件留在盘上；不可解析的报告以点名已写出路径的错误拒绝。子进程替身按 `--out` 写出文件，因为验收会读它。
- 工具（`packages/patent/patent-filing/tests/tools.spec.ts`）：通过时渲染出 `验收：✅ 断言全部通过（…）`；不通过时渲染出「成品已写出」的结论行与逐条断言。
- 组合（`packages/patent/patent-filing/tests/loader-composition.spec.ts`）：经真实 Loader 由工具运行时派发的成文调用，把验收行带回模型可见文本。
- 门禁：本次改动上 `pnpm run typecheck`、`pnpm run lint`、`pnpm run test:docs`、`pnpm run hygiene`、`pnpm run build` 与 `pnpm run test:snapshot -t patent` 全部通过。
