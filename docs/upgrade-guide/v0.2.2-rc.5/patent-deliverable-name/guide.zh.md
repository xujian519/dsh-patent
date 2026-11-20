---
kind: upgrade-guide
description: "专利提交与文档工具改用同一套交付名字符白名单；@deepseek-ai/dsh-patent-core 以 assertPathSegment 与 assertDeliverableName 取代 assertSafePathSegment。"
---

# 专利工具统一到一套交付名字符白名单

[English](guide.md) | 中文

## 变更

`build_patent_filing` 与 `render_patent_document` 现在用同一套白名单校验案卷号与输出文件名主干：ASCII 字母数字、`.`、`_`、`-`、`()`、中文汉字、圈码 ①–⑳，以及 `、。《》「」【】（），：；！？·——…“”‘’`。名字长度 1–120，不得含空格、路径分隔符、NUL 或 `..`，也不以点结尾。

对 `build_patent_filing` 的 `caseId` 是放宽：此前失败的中文案卷名现在解析到 `data/cases/<caseId>/`。

对 `build_patent_filing` 的输出文件名是收窄：白名单之外的字符（含内部空格）现在被拒。

两个工具现在都拒绝 `.` 与以点结尾的名字，`render_patent_document` 此前接受。

`@deepseek-ai/dsh-patent-core` 不再导出 `assertSafePathSegment`，改为导出 `assertPathSegment` 与 `assertDeliverableName`（各接收待校验值、对象名与 `createError` 工厂）、`resolvePatentOutputDir`、`startSpawnDeadline` 及 `SpawnDeadline` 类型。

失败文案变更。被拒名字报为 `<对象名> "<值>" 不可用：…`。提交构建的 Python 脚本未输出 JSON 时，先报 `超时` 或 `被调用方取消`，再回落到退出信号或退出码。`render_patent_document` 对已取消的调用不再启动 Chrome，返回 `已取消：未启动 Chrome`。

## 迁移

1. 改名落在白名单之外的案卷号与输出名：把空格换成 `_`，去掉或转写 `#`、`*`、`|`、`<`、`>`、`:`、`?` 等字符。
2. 去掉输出名末尾的点或单独的 `.`；以点结尾现在报错。
3. 把 `assertSafePathSegment(value, what)` 换成文件主干的 `assertDeliverableName(value, what, createError)` 或目录段的 `assertPathSegment(value, what, createError)`。每次调用自带错误构造器，抛出的类型仍属调用方。
4. 本地输出目录解析换成 `resolvePatentOutputDir(input, cwd, defaultOutputDir, createError)`，本地超时控制器换成 `startSpawnDeadline(timeoutMs, callerSignal)`，结束时调用 `dispose()`。
5. 断言了失败文案的调用方按新文案调整，然后运行 `pnpm run typecheck`。
