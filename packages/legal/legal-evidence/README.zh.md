---
description: "DeepSeek Harness 的法律证据三性判定：按《民事诉讼法》第 66 条八类法定证据，对关联性、合法性与真实性做确定性评分，并提供 evaluate_legal_evidence 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-legal-evidence

[English](README.md) | 中文

## 概述

DeepSeek Harness 的法律证据三性判定：按《民事诉讼法》第 66 条八类法定证据，对关联性、合法性与真实性做确定性评分，并提供 evaluate_legal_evidence 工具。

## 目录

- [为什么有这个包](#why-it-exists)
- [证据类型](#evidence-types)
- [评分与规则](#scoring-and-rules)
- [工具](#tool)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## 为什么有这个包

同一份证据输入必须每次都得到同一个结论，并且必须把"记录陈述了什么"与"审查者推断出了什么"分开。本包依据证据记录自身的字段与一份 YAML 规则集，对法律要求的三性——关联性、合法性、真实性——评分，全程不调用模型。库接口与 `evaluate_legal_evidence` 工具共用同一个引擎，因此调用方与模型看到的是同一份判定。

<a id="evidence-types"></a>
## 证据类型

八类法定证据为 `party_statement`、`documentary`、`physical`、`audio_visual`、`electronic`、`witness_testimony`、`expert_opinion` 与 `inspection_record`，由 `LEGAL_EVIDENCE_TYPES` 导出。每类各有判定器：书证核对原件与签章；电子数据核对已记录的哈希、时间戳与存储完整性；证人证言核对利害关系披露与佐证；鉴定意见核对资质、程序与结论明确性；勘验笔录核对见证人与记录完整性。没有专属判定器的证据类型使用通用维度判定。

<a id="scoring-and-rules"></a>
## 评分与规则

`LegalEvidenceEngine` 把三个维度的判定合成加权总分；`DEFAULT_LEGAL_WEIGHTS` 为关联性 `0.35`、合法性 `0.30`、真实性 `0.35`，随包的 `assets/legal-evidence-rules.yaml` 声明相同权重。`parseLegalRuleSet` 读取权重与声明性规则元数据；每条规则声明证据类型、检查项、严重程度、法律依据与所需条件。权重参与评分。两条 `general` 规则（`LEGAL-EVI-GEN-001` 待证事实、`LEGAL-EVI-GEN-002` 收集合法）由引擎对全部证据类型执行，且只在失败时产出发现。其余类型专属检查位于各类型判定器，YAML 记录这些检查项并提供权重；规则表测试锁定 YAML 与发现的对应关系。插件加载时规则文件缺失或无法解析会失败；个别规则条目校验失败只记警告并由插件日志输出。每次判定携带各维度分数与理由，以及判定器与通用规则产生的发现。

<a id="tool"></a>
## 工具

`evaluate_legal_evidence` 接受证据 id、类型、来源、内容、待证事实，以及按类型给出的布尔值与文本（原件、签章、形成时间、哈希及其核验、时间戳、存储完整性、证人利害关系与披露、佐证、鉴定资质与程序、勘验见证人与完整性、收集与形式合法性、举证责任方、证明标准），返回判定与一行摘要。缺少证据 id 的输入会被拒绝；判定本身是确定性的，不发起模型请求。

<a id="model-experience"></a>
## 模型体验

### evaluate_legal_evidence 工具

#### 模型看到什么

注册一个名为 `evaluate_legal_evidence` 的工具，参数为上述证据字段；`evidenceId` 与 `evidenceType` 是标识对，类型专属字段描述记录陈述了什么，而不是审查者得出了什么结论。结果携带判定——证据 id 与类型、四项分数、三个维度各自的等级与理由——以及规则发现与一段短摘要。工具描述写明八类证据、评分为确定性，以及分数低于 `0.5` 时需要补强或另找证明渠道。

#### Token 影响

工具启用期间每次请求都有固定的定义开销；每次结果是一个判定对象加一段短摘要，在压缩之前随会话重发。

#### KV Cache 影响

仅追加；新出现的结论文本位于可复用的请求前缀之后，不会使已有 KV-cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **分数是规则驱动的启发式，不是法律判断。** 它衡量记录是否具备规则要求的字段，不决定可采性、证明力，也不决定证据是否证明了待证事实。字段虚假的记录仍可能得到高分。
- **缺失的回答按保守处理。** 关于原件、签章或核验的布尔值缺失时按未回答处理并拉低维度分数；引擎不会替调用方推断未陈述的事实。
- **权重可由部署调整，规则不能。** `DEFAULT_LEGAL_WEIGHTS` 与随包 YAML 的权重一致，但部署可以只改权重不改规则集；两者分别检查。
- **类型覆盖仅限八类法定证据。** 记录命名其他证据形式时没有专属判定器，按通用维度判定。
- **不调用模型。** 工具从不要求模型打分；需要叙述性解释的调用方必须根据返回的判定自行生成。

### 开发备注

无。
