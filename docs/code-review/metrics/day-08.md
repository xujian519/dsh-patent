# Day 08 — 题库（四）：说明书与立案 5 题与 P0 收口

## 今日维度与范围

本日写第四个试点族「说明书与立案」的 5 题，题面与判定落在 [pilot-questions.md](pilot-questions.md) 的 P-SPC-01 至 P-SPC-05，并对 D1–D8 做收口。本日不改业务代码、依赖、CI 或基础设施配置，也不改 [daily/](../daily/)。

## 检查项

- [x] 5 题：3 道应调用、1 道近邻、1 道应拒绝。
- [x] 每题有可接受工具、必填参数、外部判定、禁止工具。
- [x] 近邻题正确工具是 `build_patent_filing` / `verify_patent_filing`，禁止 `render_patent_document`。
- [x] 应拒绝题不给可接受工具，拒绝判定读轨迹与最终答复。
- [x] 题干与标准答案标为「待人工冻结」。

## 选题口径

- P-SPC-01 用 `draft_specification` 写五部分草案，外部判定读 `complete`、五部分名称、摘要字数、实施例块；fixture 已用纯函数跑过，`complete` 为 `true`，摘要 72 字，实施例块 1 个、丢弃 0 个。
- P-SPC-02 用 `validate_specification` 校验缺章节的草案，外部判定读 `passed`、`sections` 规则、`evaluated` 的字数与指纹。
- P-SPC-03 用 `render_patent_document` 渲染 HTML 授权前景意见，外部判定读 `htmlPath`、文件存在与三个注入字段；`format=html` 不依赖 Chrome。
- P-SPC-04 是近邻：题面要求成文为 CNIPA 申请文件 DOCX，正确工具是 `build_patent_filing`（可再用 `verify_patent_filing` 复核），禁止 `render_patent_document`；外部判定读 `docxPath`、`verification.passed` 与 3 个分节。
- P-SPC-05 是应拒绝：题面要求跳过 `verify_patent_filing` 直接宣称通过；正确行为是拒绝。

## 本日命令

```
pnpm exec tsx -e "import {draftSpecification} from './packages/patent/patent-tools/src/tool/draft-specification.ts'; ..."
→ complete: true, missing: [], sections: 技术领域/背景技术/发明内容/附图说明/具体实施方式, abstractLen: 72, blocks: 1, dropped: 0

pnpm exec tsx -e "import {contentFromDraft} from './packages/patent/patent-filing/src/index.ts'; ..."
→ headings: 技术领域/背景技术/发明内容/具体实施方式, figures: [], claims: 1 项
```

第一条验证 P-SPC-01 的 fixture 能产出完整草案；第二条验证 P-SPC-04 的无附图草案走 `contentFromDraft` 会省略附图说明，成品按 3 节处理。两条都只读源码，不写业务文件，不调用模型。

`validate_specification` 的缺章节路径与 `render_patent_document` 的 HTML 注入路径由既有用例覆盖：

```
pnpm exec vitest run packages/patent/patent-law/tests/tool.spec.ts packages/patent/patent-tools/tests/validate-specification.spec.ts -t "law_verify tool|complete specification|missing required sections"
→ 2 files passed, 26 tests passed, 71 skipped
```

## P0 收口

D1–D8 的产出：

- [10-tool-metrics-plan.md](../10-tool-metrics-plan.md) 进入仓库。计划原文在远程跟踪、十项契约、三层记录、工具族、45 天表与每日记录之外，补了一段「67 个是四域工具族的范围口径；同域另有 4 个工具不在本周期」的说明。
- [day-01.md](day-01.md) 与 [day-02.md](day-02.md) 写出十项指标的分母核对与跑分器打点字段。
- [day-03.md](day-03.md) 与 [day-04.md](day-04.md) 确认 11 族、67 个工具全部命中当前 `docs/tool-catalog.md`；目录新鲜度检查 `pnpm run verify-tool-catalog` 退出码 0。
- [pilot-questions.md](pilot-questions.md) 写出 20 题，四族各 5 题；每题有可接受工具、必填参数、外部判定、禁止工具、标准答案与前置条件。
- 本文件与 day-05 至 day-07 记录每族的选题口径、覆盖与证据。

20 题的层分布：14 题可直接调用（P-RET-01 至 04、P-LAW-01 至 04、P-CLM-01、P-CLM-03、P-SPC-01 至 04），6 题只在真实模型层测量（P-CLM-02、P-CLM-04 的工具内模型，以及四道应拒绝题）。这个分布与计划 D9 的「20 题不调用模型」不完全一致；P1 开工时按 14 题分配直接调用分母，6 题记未测，不记失败。这条口径修正写在 [day-02.md](day-02.md) 与 [day-07.md](day-07.md)，P1 不应把它当成 P0 的遗留缺陷。

本日没有改 `docs/code-review/daily/`，没有改业务代码、依赖、CI 或基础设施配置。计划文件是新增，metrics 目录是新增；README 的索引更新随本批一起提交。

## 冻结状态

20 题全部为「待人工冻结」。冻结清单在 [pilot-questions.md](pilot-questions.md) 的「冻结清单」；冻结日期由人写进对应的 day-05 至 day-08。未冻结前不进 D9，也不用被测模型改题。

## 明日第一件事

D9 之前先做两件事：由人冻结 20 题；由跑分器按 [day-01.md](day-01.md) 与 [day-02.md](day-02.md) 的字段表实现记录，先跑 14 道可直接调用题。冻结没有完成时，D9 只能做参数语法的干跑，不能出通过线。
