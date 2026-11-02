---
kind: upgrade-guide
description: "writing-patterns:skills section 改为携带紧凑索引，不再编译每条模式的步骤；stagePatterns 把工作流阶段映射到 3–5 条模式。"
---

# 写作模式改为索引并按阶段供给

[English](guide.md) | 中文

## 变更

`writing-patterns:skills` 系统提示词 section 现在携带 `<pattern_index>` 块：每条模式一行，给出 id、类目与名称，不再把每条模式的摘要、步骤、应遵循规则与应避免规则编译进提示词。随包语料下索引为 1,819 字符；原先十条模式的全量块为 17,461 字符，把当前十八条模式全部编译则需 27,234 字符。模型经 `query_writing_patterns` 取得模式正文。

`sectionCategories` 现在决定索引列出哪些模式。随包语料由十条增至十八条，新增用最接近现有技术反打独权的三步法自检、A26.3 实施例矩阵、33 条修改预埋、单一性、功能性限定、软件方法/装置/介质三件套、马库什并列下位与数值范围退路。

插件新增可选的 `stagePatterns` 配置：工作流阶段 id 到 3–5 个模式 id 的映射。插件挂载时按已加载语料解析该映射，并提供 `writingPatterns` 服务（`patternsForStage`、`compiledForStage`、`stageIds`），原子在该服务中读取本阶段模式。模式 id 未知或重复、数量超出 3 到 5，都会使插件加载失败；向服务查询部署未声明的阶段会抛错。随包 `patent` 预设为 `draft_claims`、`draft_specification`、`spec_check`、`enablement_report`、`claim_breadth` 与 `response-plan` 声明了映射。

固定或解析提示词 section 的部署、设置 `sectionCategories` 的预设，以及期望提示词携带完整模式正文的原子或脚本，都受影响。

## 迁移

1. 按某条模式撰写前先调用 `query_writing_patterns`；section 不再携带步骤与规则。
2. 停止从 section 解析 `<writing_skills>`。需要可用 id 时读 `<pattern_index>`，需要完整块时调用 `compileWritingSkills`。
3. 为需要读取模式的阶段声明 `stagePatterns`，列 3 到 5 个存在于已加载语料中的 id。
4. 若用 `patternDir` 替换随包语料，务必让 `stagePatterns` 引用的每个 id 都存在于该目录，否则插件加载失败。
5. 重录固定 `writing-patterns:skills` section 文本的快照，并在提交前复核缩小后的索引。
