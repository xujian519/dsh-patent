---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-drop-sidechat-source

[English](2026-11-07-drop-sidechat-source.md) | 中文

## 概述

better-sidebar 包删除（PR #677）时移除 `sidechat` message-source 变体，`agent/inbox/spliced` 的对应载荷变体一并移除。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-drop-sidechat-source
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "7dcd8a0682388dd373f72f13dd3ebc31fcf9da171a7b9a82dda9f99002fa7872"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "766b4cd2d47296bfacf02e98bc81521d655231e9bd6ffb489a87cc6fc753d784"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "9c339be75bfb0f2c173d8236c80dbcbe0e6742f975050942b48616017c116d42"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-28-v022-alpha2-sync"
    after: "8079fc9efc7399d170858c37bd0b50fa4f3b305bae63adfcf622496e29578eba"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

新读取器读旧记录：已持久化的会话仍可能含 `source.kind: "sidechat"` 与该变体的 `agent/inbox/spliced` 载荷。`MessageSource` 是合并可扩展联合，消费方按等值比较 `kind` 而非穷举 switch——`auto-review` 的来源判定与 `action-cards` 投影都会落空放过，消息内容、顺序与其余归因仍可读，只是这类消息不再带专属归因。旧读取器读新记录：本次只有移除，所有保留变体逐字节不变，旧读取器看到的仍是它已理解集合的子集。判别式未变，且没有任何写入方产出该变体。

<a id="verification"></a>
## 验证

pnpm --silent run persistence-review --before <在 2026-10-28-v022-alpha2-sync 记录处生成的索引> --after docs/persistence-schema.json --json：四个根有变化，每一处都可归因到被移除的变体。pnpm exec vitest run packages/core/session packages/llm/llm：通过。

<a id="dev-note"></a>
## 开发备注

无。
