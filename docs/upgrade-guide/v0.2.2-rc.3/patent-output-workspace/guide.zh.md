---
kind: upgrade-guide
description: "未配置的专利笔记、附图与化学输出路径改为相对部署工作区根，不再相对进程目录。"
---

# 专利输出路径改用工作区根

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-patent-tools` 以前在 `noteDir`、`figureIndexFile`、`chemistryIndexFile`、`figureOutputDir` 未配置时写到 `process.cwd()` 下，相对路径也按进程目录解析。这四个路径现在使用 `sandboxPolicy.workspaceRoot`。Config 里的绝对路径不变。路径仍需要根，而该服务缺席、根为空或根不是绝对路径时，插件加载抛出 `setup_required`。已经把 `workspaceRoot` 设成进程目录的 profile 位置不变。

## 迁移

1. 在 `cordis.yml` 里把 `sandbox-policy` 插件的 `workspaceRoot` 设为应存放 `99-知识库`、`.sati/figures-index.json`、`.sati/chemistry-index.json` 与 `patent/figures` 的绝对目录。已经设置该键的 profile 不必新增 patent-tools 配置键。

2. 上述四个键的相对值现在相对于该工作区根。若要保持原先跟随进程目录的位置，改为绝对路径。

3. 用 `pnpm exec vitest run packages/patent/patent-tools/tests/wiring-composition.spec.ts -t '输出路径'` 确认。
