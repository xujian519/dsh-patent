---
kind: upgrade-guide
description: "随包 patent 预置拒绝前置检查读的是另一版草案的成文与 claims-spec 渲染。"
---

# 专利交付门禁改为按草案摘要拒绝

[English](guide.md) | 中文

## 变更

随包 `patent` 预置此前以 `shadow` 运行交付 digest 核对：`build_patent_filing` 或 `claims-spec` 渲染的 `rule_check` / `validate_specification` 证据来自另一版草案时，交付照常完成，只记一条日志。现在改为 `enforce`，这类调用会被拒绝。拒绝理由点名不符的投影（`text`、`claims` 或 `abstract`）与应重跑的前置工具。

运行检查后修改草案、未重跑检查就交付的会话，从此被拒绝。证据已经覆盖本次交付草案的调用不受影响。

## 迁移

1. 在专利会话里，改动权利要求、说明书或摘要后，对本次草案的说明书投影重跑 `rule_check`，并用同一份 `text`、`claims`、`abstract` 投影重跑 `validate_specification`，再调用 `build_patent_filing` 或 `claims-spec` 渲染。
2. 确认门禁：改动一个权利要求字符，不重跑检查直接调用 `build_patent_filing`，应被拒绝且理由点名 `claims`；重跑检查后应交付成功。
3. 只想观测不拒绝时，在 profile patch 里给 `@deepseek-ai/dsh-patent-rule` 设 `deliveryGateDigestMode: shadow`。该模式把不符写进 logger 警告，输出只出现在导出 logger 的组合里。
