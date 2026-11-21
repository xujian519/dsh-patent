---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-20-patent-workflow-recovery

[English](2026-11-20-patent-workflow-recovery.md) | 中文

## 概述

为中断的专利工作流运行事件增加可选恢复点。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-patent-workflow-recovery
baseline: false
changes:
  - root: "event:patent/workflow-run"
    previous: "2026-10-24-adversary-review-input-scope"
    after: "7167c69150588529dd8be7754bd3066d77bf7331a2c8756e7b8e4d687ce67f02"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

不含 recovery 的已有记录仍然有效。已完成运行不写该字段，不执行续跑的读取方可以忽略它。续跑仅在 manifest、案件类型、已完成阶段前缀和中断阶段均校验相符后使用该字段。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/patent/patent-workflow/tests/workflow-recovery.spec.ts packages/patent/patent-workflow/tests/workflow-store.spec.ts packages/patent/patent-tools/tests/patent-workflow-run.spec.ts：3 个文件、102 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
