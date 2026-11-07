---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-patent-model-call-duration

[English](2026-11-07-patent-model-call-duration.md) | 中文

## 概述

为 `patent/model-call` 增加可选的 `durationMs`：模型流从请求到最后一个事件的墙上时钟耗时。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-patent-model-call-duration
baseline: false
changes:
  - root: "event:patent/model-call"
    previous: "2026-09-21-patent-model-call"
    after: "51f9e4dc4f832e4da517baeacb732861e29ccd1a08290c18a449e5dd2a03f9e2"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

字段可选且只做加法。新代码读旧记录时该字段缺席，缺失表示未测量，与测得不足 1 毫秒的 `0` 区分，因此不会有读取方把未测量误当成瞬时完成。旧代码读新记录时多出一个它不认识的 JSON 属性并忽略之；既有字段语义不变，判别式（`llmStreamCall`）不变。回放归一化会删除该字段，因此免密快照无需重录即可比较相等。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/patent/patent-workflow/tests/model-call-log.spec.ts：8 个测试通过，其中用 30 毫秒延迟的端口断言记录值为不小于 20 的整数。pnpm run test:snapshot -t patent：11 个通过且未重录；移除归一化规则后复现 5 个失败，证明正是删除规则让黄金文件保持稳定。

<a id="dev-note"></a>
## 开发备注

无。
