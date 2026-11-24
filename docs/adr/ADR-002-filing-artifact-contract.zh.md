# ADR-002：申请文件产物契约

[English](ADR-002-filing-artifact-contract.md) | 中文

状态：Accepted。日期：2026-11-24。

## 摘要

披露工作流的成功终态（terminal state）必须由确定性装配器（assembler）收成一份通过 `validateSpecDraft` 的 `SpecDraft`。HTML、PDF、DOCX 与附图的默认写入根是 ADR-001 案卷目录。本文记录已接受的决定，不改装配器，也不改写入路径。

## 背景

`packages/patent/patent-workflow/src/workflow/manifests.ts` 中的 `patent_disclosure_v1` 保留 `claims_draft`、`specification` 等文本键。这些键不是 `SpecDraft`。`SpecDraft` 与 `validateSpecDraft` 在 `packages/patent/patent-core/src/draft/`。把装配留到事后手组，或交给模型再写，出件可以通不过 `validateSpecDraft`，也可以在不点名缺口的情况下补上缺字段。

HTML 与 PDF 在 `packages/patent/patent-document/`。DOCX 在 `packages/patent/patent-filing/`。两者在既不传输出目录也不传案号时使用 `DEFAULT_OUTPUT_DIR`，其值为 `<cwd>/.dsh/documents`。传入案号时，`packages/patent/patent-core/src/paths.ts` 的 `resolvePatentOutputDir` 写到 `<cwd>/data/cases/<案号>/outputs`。`packages/patent/patent-tools/src/tool/generate-patent-figure.ts` 的附图使用相对目录 `patent/figures`。`packages/patent/patent-tools/src/config.ts` 的 `figureOutputDir` 缺省为同一相对目录，并相对工作区根解析。案卷根的配置字段是 `workbenchCaseRoot`。[ADR-001](ADR-001-matter-folder-index.zh.md) 已把案卷目录定为真源。在案卷旁边再长一棵目录，会把同一个案卷的文件拆开。下文的决定写明这些缺省的替换。

## 决定

- 披露工作流的成功终态必须由确定性装配器装配。装配器是纯函数，不是模型再写。装配结果是通过 `validateSpecDraft` 的 `SpecDraft`。
- 出件（HTML、PDF、DOCX）与附图的默认写入根是 ADR-001 案卷目录。`workbenchCaseRoot` 仍是工作根目录的配置字段。一个案卷是该根目录下的 `<案号>/` 目录。
- 旧的 `data/cases` 与 `.dsh/documents` 只在调用方显式传入该路径时可用。
- 无法解析案卷目录且没有显式覆盖时，写入失败，不得回落 `<cwd>/.dsh/documents` 或 `<cwd>/data/cases/<案号>/outputs`。
- 中间表示（intermediate representation）是 `packages/patent/patent-core/src/draft/` 的 `SpecDraft`，必须通过 `validateSpecDraft`。
- 工作流内部仍可使用 `claims_draft`、`specification` 等文本键。成功终态必须能够装配。「再手组一份结构」不是默认可省略的步骤。
- 缺字段时失败并点名缺口。模型不得补写。
- 案卷目录内的子目录名沿用 `patent-workspace-layout` 这个 skill（技能）已有的名字。本决定不新造目录名。

## 后果

本批范围是装配器与 `validateSpecDraft`、把默认写入根改为案卷目录、仅在显式传入时使用旧路径、按下述验收补测试，以及落盘本 Accepted 记录。装配器、默认根与测试由后续票实现。

验收由后续票实现：

1. 用披露链成功终态 fixture（测试前置数据）调用装配器，结果必须通过 `validateSpecDraft`。改必填字段或丢掉关键文本键必须失败并点名缺口，不得静默出件。
2. 已解析案卷目录且不传输出目录时，成品必须写在该案卷目录内，不得落到 `<cwd>/.dsh/documents`，也不得落到 `<cwd>/data/cases/<案号>/outputs`。
3. 显式传入旧路径时仍可写到旧位置。
4. 无法解析案卷目录且无覆盖时必须失败，不得回落旧默认。
5. 同一份 `SpecDraft` 经 HTML 与 DOCX 通道，权项项号、图号与表题不得分叉。

下列做法被禁止：

- 把 `data/cases` 或 `.dsh/documents` 重新变成隐含默认。
- 用模型再写代替装配器。
- 把案卷正文写入云端或 `knowledge.db`。
- 另建与案卷并列的 `data/cases` 或 `.dsh/documents` 树。
- 把范围外事项塞进本批。

## 不在范围内

本决定不改生成算法，不重写出件模板，也不重写 Python 成文引擎。本决定不合并 HTML 渲染器与 DOCX 渲染器。本决定不做 HITL 粒度、实用新型硬上限、docx 回读，也不做工作稿红标与申报稿禁彩色分流。

本决定不重开 [ADR-001](ADR-001-matter-folder-index.zh.md)。工作台仍只做索引。案卷正文不进云端，也不进 `knowledge.db`。

本决定默认不改工作台 UI。若出件路径会出现在面板上，那是后续另拆的事项。

## 遗留风险

下列事项保持开放。本文不为此扩大产品范围。

- 工作台打开案卷时，会话工作目录是否已等于案卷目录，尚未深读工作台。
- 子目录名沿用现有布局 skill。本文不新造目录名。
- 终态要补哪些字段才能通过 `validateSpecDraft`，尚未用 fixture 跑通。该证明是 T2。
- 现有依赖旧默认路径的脚本和测试，须改为显式覆盖或改用案卷目录。该切换是 T3。
