---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-17-patent-model-call-truncated

[English](2026-11-17-patent-model-call-truncated.md) | 中文

## 概述

为 patent/model-call 增加可选的 truncated，标记模型流未正常结束。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-17-patent-model-call-truncated
baseline: false
changes:
  - root: "event:patent/model-call"
    previous: "2026-11-07-patent-model-call-duration"
    after: "c53e3ced83c58e024f03a2d8aeb314be89a5cd76477737ce55d9a3e45eac46ec"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧记录没有 truncated。新读取方把缺失视为调用已完成，与这些记录的写入方式一致。新记录可以带 truncated: true，output 仍是流结束前已经产出的文本。忽略未知属性的旧读取方仍能加载该事件，并可能把这段 output 当成完整回复。当前回放不会这样做：它先交出前缀，再抛错，因此这段前缀不是正常结束。已有字段的类型不变，llmStreamCall 也不变。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/patent/patent-workflow/tests/model-call-log.spec.ts 与 packages/test-support/llm-replay/tests/llm-replay.spec.ts：162 个测试通过。model-call-log.ts 与 llm-replay/src/index.ts 覆盖率为 100%。

<a id="dev-note"></a>
## 开发备注

无。
