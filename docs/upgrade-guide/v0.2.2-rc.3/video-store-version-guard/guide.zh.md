---
kind: upgrade-guide
description: "视频模式的 journal、账本与项目写入改为按读取到的文件版本守卫；竞争失败的一方重试并合并，持续失败报 MEDIA_STORE_CONFLICT。"
---

# 视频模式持久写入改为版本守卫

[English](guide.md) | 中文

## 变更

任务日志（`tasks.json`）、预算账本（`budget.json`）与项目文档（`project.json`）现在带着写入方读取到的版本令牌发布。并发写入会让守卫写入失败，而不是覆盖较新的文件：修改方重新读取、合并本次改动并最多重试三次。持续失败的写入以新增的 `MEDIA_STORE_CONFLICT` 报告；项目文档仍报 `MEDIA_PROJECT_CONFLICT`。

项目初始化改为守卫创建（`createIfAbsent`）：对已存在文档的 id 再初始化现在以 `FS_NOT_OBSERVED` 失败，而不是覆盖原文档。

`@deepseek-ai/dsh-video-mode` 导出的 `ProjectFileIo` 形状改变：`read()` 返回 `{ text, version }`，`write(text, version)` 接收用于守卫的版本。

## 迁移

1. 仓库外实现的 `ProjectFileIo` 必须先取版本再读文本（`ctx.fs.stat(target)` 后 `ctx.fs.readText`），并把版本传给 `ctx.fs.writeText(target, text, { kind: 'replaceIfVersion', version })`。读取顺序有意义：先读文本后取版本会授权覆盖两次操作之间发生的改动。
2. 对同一 id 重复初始化项目的调用方现在会收到 `FS_NOT_OBSERVED`。改用 `mutateProjectFile` 读取并修改已有文档。
3. 在处理 `MEDIA_STORE_INVALID` 的地方一并处理 `MEDIA_STORE_CONFLICT`：日志或账本在该写入方操作期间持续变化，应重试调用，而不是当作数据损坏。
4. 进程内锁保持不变，仍是优化：它串行化同一进程内的写入者，真正发现另一个进程的是版本守卫。
