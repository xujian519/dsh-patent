# Agent Note：Google Patents 交不出 PDF 时回退 PatSnap

状态：已实施

[English](2026-11-28-patent-pdf-patsnap-fallback.md) | 中文

## 问题

`patent_pdf_download` 原先让中国公开(公告)号先走 CNIPR，其余号走 Google Patents。两条腿都有部署吸收不了的失败：Google 经本地代理会进入分钟级 HTTP 503 窗口（2026-10-03 的审计里 106 次失败有 89 次是 503）；CNIPR 的下载腿依赖 ego lite 登录态、一次只取一个号，且站点明确声明不支持爬取，是实践中最常被限制的通道。覆盖范围也按法域和文献类型分裂：Google Patents 缺大量中国实用新型与外观设计，CNIPR 只覆盖中国。

付费替代一直存在：PatSnap 开放平台的 P020 接口按公开号返回专利 PDF 地址，体验额度 10,000 积分。改动前它只能经 MCP 服务或临时脚本访问，工具没有确定、可计费的兜底，报告也无法点名产出原文的通道。

## 决策

`patent_pdf_download` 先走 Google Patents，只把「取回内容不是有效 PDF」的篇目交给 PatSnap。顺序属于工具，不属于浏览器 runner：真正决定失败的是下载尝试之后的状态码、Content-Type 与 PDF 魔数，因此 runner 只返回 Google 的候选地址，由工具发起第二次尝试。

PatSnap 腿是 `@deepseek-ai/dsh-patent-data` 的新通道（`createPatsnapChannel()`），基于 P020，Bearer Key 从 `Config.patsnapApiKeyEnv` 指定的环境变量读取。默认关闭（`Config.patsnapEnabled`），按 `Config.patsnapBatchSize` 分批发送公开号，返回逐号结果与网关的 `x-openapi-amount` 合计。缺 Key 时抛错，而不是返回一个只会失败的对象；工具把通道级失败收进 `warnings`，保留每篇的原失败原因。

CNIPR 退出下载路径。通道继续服务法律状态、关键词检索与中国著录项——这些场景里它发布的字段与登录态仍然有用。

P020 的实测行为决定了通道的边界：成功返回一条记录消耗一个 amount 单位，五条就是五；服务不了的号被静默省略且不计费；整批都没有 PDF 时返回 `68300008`，通道把它映射成逐号 `not_found`，不判成通道故障。业务失败也走 HTTP 200，因此通道解析 `status`/`error_code`，`6720000x` 才是通道级分类。`replace_by_related` 会返回 `pn_related`，作为 `resolvedNumber` 暴露，报告不会把同族成员当成请求的原文。

## 考虑过的替代方案

**保留中国号先走 CNIPR，再在其后加 PatSnap。** 否决：部署要求 Google 优先；CNIPR 的登录态、反爬限制与逐号页面交互使它最不适合批量下载。它的长处是法律状态与中国检索，不是 PDF 数量。

**用 PatSnap 的 MCP 服务驱动下载。** 工具路径否决：模型参与调用既不确定，又在积分之外消耗 token，也无法进入工具的逐篇预算与 MANIFEST 续传。MCP 仍是交互式 Agent 用法的正确入口。

**把 PatSnap 腿放进 `createDownloadChannelRunner`。** 否决：该 runner 只产出候选地址，而 Google CDN 的 403/超时是 runner 返回之后由工具 fetch 兜底才发现的；放在那里会漏掉最常见的失败。runner 保持只负责 Google，工具负责第二次尝试。

**让 PatSnap 做主通道。** 否决：Google 免费且覆盖广；体验额度的 90 天窗口与每分钟 10 次请求的限制使它不适合做默认。兜底才是与实测行为匹配的角色。

## 后果

每篇仍然只点名一个通道。兜底成功标 PatSnap，并把 Google 的失败写进 `warnings`；同族替代补 `resolvedNumber`。缺 Key 或积分耗尽是可见的 `warnings`，不会静默丢掉兜底，该篇保留原失败。

`timeoutMs` 仍是单腿预算：Google 腿与 PatSnap 腿各自拿到它，完全降级的调用最坏用到两倍预算。这与既有契约一致，也让 CNIPR 时代的测试期望继续成立。

兜底只为 PatSnap 实际返回的记录花积分。非法号不离开进程；被省略的号不计费；重复号在请求前就去重。默认批量下，50 篇批次最多发出三次 P020 请求，足以落在体验套餐每分钟 10 次的限制内。

通道的 HTTP 契约是 PatSnap 的：P020 路径、`status`/`error_code` 信封与 `x-openapi-amount` 头。协议变化会以 `invalid_response` 或空结果暴露，不会静默漏号。实测样本里的试用 PDF 是官方版式、没有可见水印；再分发仍遵循平台条款。

工具描述、输出 schema（`resolvedNumber`）与专利预置都变了，因此工具目录、包 README、升级指南与录制的工具 schema 期望随本次改动一起更新。
