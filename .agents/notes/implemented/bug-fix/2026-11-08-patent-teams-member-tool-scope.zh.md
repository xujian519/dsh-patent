# Agent Note: 成员工具允许列表按队长作用域解析

Status: implemented

[English](2026-11-08-patent-teams-member-tool-scope.md) | 中文

## 问题

成员是队长的可续子会话，队长与成员又同属一次预设生成。`memberToolAllowList` 以前用插件的注册上下文构造允许列表，而该上下文的 `restrictableNames()` 不包含预设自身的注册。成员子会话继承的正是这一层，于是 `tools.restrict({ allow })` 把预设注册的工具全部删掉。2026-11-08 的桌面构建之后，成员从 156 个工具掉到七个 `mcp__cnlaw__*` 工具，人设却仍要求它们认领任务，队长只好自己撰写交付件。

## 决定

`memberToolAllowList(captain.ctx, role)` 改用队长的会话上下文解析列表。`spawnMember` 传入 `captain.ctx`；插件上下文继续只负责 `subagents`。

列表由成员基线与队长可限制集合的交集、组合中挂载的 `mcp__cnlaw__*` 名字、角色声明且确实存在的工具，以及四件协作工具（`claim_task`、`update_task`、`send_message`、`status`）组成，再减去 `MEMBER_DENIED_TOOLS`。

成员的祖先链是队长祖先链的子集：`composeFrom` 把子会话接到队长的生成上，不再添加其他父节点。因此队长不可限制的名字对成员同样不存在，`spawnMember` 在启动前把它从拒绝列表里去掉。取不到 tools 服务时保留完整拒绝列表。允许列表里的未知名字仍在 `restrict()` 处失败。

成员人设保留工作规则 1–5 与领域纪律段原文。规则 9 只点名实际授予的校验器；一个校验器都没有时整句省略，未裁剪的成员保留原文。

## 备选方案

**用插件注册上下文构造列表。** 该上下文不含成员继承的预设层，列表因此丢掉全部预设工具。

**用 `tools.definitions(scopeOf(ctx))` 取交集。** 它读的是同一层，但要把 `@deepseek-ai/dsh-scope` 提升为 peer 依赖，并重复 `restrictableNames()` 已经完成的 scope 符号查找。

**从拒绝信息里解析 `unknown global tool` 后重试启动。** `tools.restrict()` 抛的是普通 `Error`，重试只能靠消息文本识别缺失名字。核心包一旦改写诊断措辞，重试会静默失效；测试构造的是同一句文本，发现不了这种漂移。改为预过滤后，重试与消息依赖一起删除。

**保留完整拒绝列表，缺少名字就让成员创建失败。** 没有 `send_message` 的组合会因此无法 `add_member`；预过滤容忍这种缺失，且不会多授予任何工具。

## 后果

预设注册的工具与四件协作工具在裁剪后保留，有角色的成员能读文件、跑 shell、认领任务并汇报。缺少某个拒绝工具不再让 `add_member` 失败，该名字在工具存在的地方仍然生效。允许列表中的未知名字仍在成员创建时直接失败。

改动只涉及 `@deepseek-ai/dsh-patent-teams`。含此修复的桌面构建发布前创建的团队保留现有会话；已归档团队不做迁移。交底撰写流程、对应技能与 `patent_workflow_run` 均未改动。

## 测试

`tests/member-tool-scope.spec.ts` 挂载真实注册表，把队长与成员绑到同一预设层，断言允许列表含 `read`、`bash`、协作工具与已挂载的角色工具。它把列表交给成员的 `restrict()` 并检查 `schemas()`，验证成员未继承的允许名仍会抛错，也验证没有 cnlaw 的组合退回仅拒绝模式。`members.spec.ts` 覆盖拒绝列表预过滤，以及取不到 tools 服务时的完整拒绝列表；`member-tools.spec.ts` 固定列表内容。
