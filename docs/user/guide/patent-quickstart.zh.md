# 专利快速开始

[English](patent-quickstart.md) | 中文

本指南从一份源码检出开始，到完成第一条专利任务为止，其中包含启动 [Web UI](../../../README.zh.md#run)。

## 开始之前

- 从源码构建需要 Node.js >= 24.9 与 pnpm 11.28.5。
- 一个 DeepSeek API key。
- 可配置工作根目录（work root）下的案卷文件夹，包含交底书与参考资料。该根目录的典型值是 `/Users/xujian/工作`。

## 启动 Web UI

在仓库根目录运行：

```sh
pnpm install
pnpm run build
pnpm dsh web
```

本分支的能力不包含在上游发行包中，因此必须使用这次源码构建。

## 配置模型与工作区

1. 打开**设置 → 模型**，填入 DeepSeek API key 并保存。
2. 所有案卷都使用本仓库作为工作区。

## 打开新建案卷

一个仓库承载多个案卷。不要为每个案卷另开一个 Cursor 或 git 项目。决定见 [ADR-001](../../adr/ADR-001-matter-folder-index.zh.md)。

1. 在工作根目录下建立案卷文件夹，例如 `/Users/xujian/工作/<案号>/`，并在其中放入 `_matter-log.md`。工作根目录可配置。不要另建一棵忽略该根目录的 `patent-workspace/<案号>` 树。
2. 把该文件夹扫描进工作台账本，即 `~/.dsh/workbench` 下的 SQLite。账本行只保存元数据与 `workspace_path`。案卷文件正文留在该文件夹，不进云端，也不进 `knowledge.db`。
3. 打开同一仓库并选中该案卷。工作台条目指向该案卷文件夹。
4. 在该文件夹中书写。案卷目录与 `_matter-log.md` 是真源。桥接可以读取投影。把内容写回案卷文件夹不是账本。

## 选择专利预设

新建任务并打开 Agent 预设选择器，选择名为**专利模式**的预设。任务开始后预设即固定，因此在发送第一条消息前完成选择。

## 运行第一条任务

发送一个范围明确的需求：

> 读取本工作区的交底书，列出技术问题、发明构思、关键技术特征与技术效果。

Agent 在动手前会复述任务范围与每个关键取舍并等待确认；引用法条前会先核验。

## 预期行为

- 输出为起草辅助，不构成正式法律意见。
- 检索报告写明数据来源、检索式、检索日期与覆盖范围。
- 每条事实性断言都带来源；拿不出来源的断言会被撤回。


## 审批门（会话内卡片，无独立路由）

专利工作流跑到 `approval-gate` 阶段时，**不会**打开单独的「审批」页面或侧栏路由。

在默认前台配置（专利预设对 `@deepseek-ai/dsh-patent-tools` 开启 `approveStageGates: true`，且部署挂载了 `approval` / `@deepseek-ai/dsh-user-approval`）下：

1. 同一会话里会出现**审批卡片**（一次性决策），摘要来自该审批门 `review_keys` 所列产出。
2. 放行后工作流继续；拒绝 / 取消 / 服务不可用 / `never` 策略会带结果名暂停，结果写在工具返回值里。
3. 后台运行（`run_in_background: true`）或关闭该开关的部署，仍可能走「暂停后用 `approveStageIds` 续跑」的旧契约——见升级指南，不要在前台开关打开时自行传 `approveStageIds`。

核对步骤：用短 manifest（例如 `patent_workflow_run` 传 `manifestId: patent_novelty_v1`）跑到审批门，确认卡片可见且放行后整链完成。

详细迁移说明：[`../../upgrade-guide/v0.2.2-alpha.3/patent-stage-gate-live-approval/guide.zh.md`](../../upgrade-guide/v0.2.2-alpha.3/patent-stage-gate-live-approval/guide.zh.md)（正文保持在 `alpha.3`；`v0.2.2-rc.1` 下仅有指针，见 `docs/upgrade-guide/PATH-ALIGNMENT-NOTE.md`）。

## 继续阅读

- [使用 Web UI](index.zh.md)
- [配置模型](providers.zh.md)
- [架构概览](../../architecture.zh.md)
- [案卷文件夹索引（ADR-001）](../../adr/ADR-001-matter-folder-index.zh.md)
