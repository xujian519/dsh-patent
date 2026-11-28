---
kind: upgrade-guide
description: "patent_pdf_download 现在先走 Google Patents，拿不到有效 PDF 的号再由 PatSnap 的 P020 接口兜底；CNIPR 不再参与下载。"
---

# 专利 PDF 下载增加 PatSnap 兜底

[English](guide.md) | 中文

## 变更

`patent_pdf_download` 不再把中国公开(公告)号交给 CNIPR。所有号先走 Google Patents 腿——ego-browser 取回响应体，失败后无浏览器抓取 CDN 链接并用 fetch 下载——只有取回内容不是有效 PDF 的号才交给 PatSnap。

PatSnap 腿是 `@deepseek-ai/dsh-patent-data` 新增的 P020 通道（`createPatsnapChannel()`）。默认关闭，由 `Config.patsnapEnabled` 打开；API Key 从 `Config.patsnapApiKeyEnv` 指定的环境变量读取（默认 `PATSNAP_API_KEY`），不写进 `cordis.yml`。新增 Config 字段：`patsnapEnabled`（`false`）、`patsnapApiKeyEnv`（`PATSNAP_API_KEY`）、`patsnapBaseUrl`（`https://connect.patsnap.com`）、`patsnapTimeoutMs`（`30000`）、`patsnapBatchSize`（`20`，1–50）与 `patsnapReplaceByRelated`（`true`）。

每篇仍带 `channel`，取值现在是 `Google Patents（nuo 引擎）` 或 `PatSnap（智慧芽）`。同族替代时新增 `resolvedNumber`（PDF 上实际印的公开号）。被咨询过但未能服务的通道写进 `warnings`，包括缺少 Key 与积分耗尽。`timeoutMs` 仍是单腿预算：Google 腿与 PatSnap 腿各自按它设期限，完全降级的调用最坏会用到两倍预算。

受影响：为下载打开过 `cniprEnabled` 的部署、读取 `channel` 或下载摘要的调用方，以及固定了 `patent_pdf_download` 输出 schema 的消费者。

## 迁移

1. 创建智慧芽开放平台 Key（`sk-…`）并导出为 `PATSNAP_API_KEY`（或把 `patsnapApiKeyEnv` 指向别的变量）。把 `patsnapEnabled` 留关的部署保持原来的纯 Google 行为。
2. 复制专利预置的部署，在 `@deepseek-ai/dsh-patent-data` 下补 `patsnapEnabled: true` 与 Key 变量名。随仓库发布的专利预置已打开。
3. 下载报告写通道时，兜底篇目应写 `PatSnap（智慧芽）`；同族替代必须把 `resolvedNumber` 写成文件里的号。
4. 无需 Key 刷新录制的工具 schema 期望：`pnpm run test:snapshot:refresh`，再跑 `pnpm run test:snapshot`。工具描述与 `resolvedNumber` 输出字段已变化。
5. CNIPR 继续服务法律状态、关键词检索与中国著录项；`patent_pdf_download` 即使对中国公开(公告)号也不再咨询它。

- 不设 `PATSNAP_API_KEY`，下载一个 Google 服务不了的号，确认该篇保持失败、原失败原因保留，并出现点名缺失 Key 的告警。
- 设置 Key 后重跑，确认该篇成功、`channel` 为 `PatSnap（智慧芽）`；发生同族替代时带 `resolvedNumber`，并出现点名 Google 失败的告警。
- 50 篇批次最多发出三次 P020 请求（`patsnapBatchSize: 20`），只按实际返回的记录计费。
