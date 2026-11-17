---
kind: upgrade-guide
description: "视频模式的预算账本移出工程目录，改存到 ledgerDir；readLedger 与 appendLedgerEntry 增加该目录参数。"
---

# 视频预算账本移出工程目录

[English](guide.md) | 中文

## 变更

已结算的人民币费用不再写在项目文档旁的 `budget.json`。`@deepseek-ai/dsh-video-mode` 把它们存到 `ledgerDir`，每个解析后的项目路径对应一个文件。默认目录是 `~/.dsh/video-mode/ledgers`。配置落在会话工作区内会被拒绝。发布使用以 `ledgerDir` 为根的 `workspace-write` 策略，因此只被允许写会话工作区的文件工具改不了账本。

`readLedger` 与 `appendLedgerEntry` 现在接收这个绝对目录。宿主文件不存在时，已有的工程 `budget.json` 会被复制一次。之后再改 `budget.json`，预算门不变。`ui-video-studio` 仍读工程里的文件，显示的金额可能过时。账本写入的版本守卫不变。

## 迁移

1. 两个存储函数补上目录参数：`readLedger(ctx, projectPath, ledgerDir, cwd, signal)` 与 `appendLedgerEntry(ctx, projectPath, entry, ledgerDir, cwd, signal)`。
2. 在 `video-mode` 插件上把 `ledgerDir` 设为会话工作区之外的绝对路径，或不设置，以使用 `~/.dsh/video-mode/ledgers`。
3. 结算一笔人民币费用，把工程 `budget.json` 换成空账本，确认下一次生成仍以 `MEDIA_BUDGET_EXCEEDED` 被拒绝。
