---
description: "专利数据接缝（`ctx.patentData`）的 Service Definition：基于 vendored [`@deepseek-ai/nuo-patent`](../../../vendor/nuo-patent/README.md) 引擎的 LRU 缓存检索 provider 工厂、结构化元数据映射、专利结果缓存、基于注入 subprocess 服务的 ego-browser 反爬会话 runner、经该会话取中国专利全文、法律状态与关键词检索的 CNIPR（search.cnipr.com）通道，以及为下载兜底解析专利 PDF 直链的 PatSnap（Open Platform P020）通道，外加从 Sati 移植的持久化与案例路径助手。模型可见面全部由消费方负责；本包只解析并提供专利数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-data

[English](README.md) | 中文

## 概述

专利数据接缝（`ctx.patentData`）的 Service Definition：基于 vendored [`@deepseek-ai/nuo-patent`](../../../vendor/nuo-patent/README.md) 引擎的 LRU 缓存检索 provider 工厂、结构化元数据映射、专利结果缓存、基于注入 subprocess 服务的 ego-browser 反爬会话 runner、经该会话取中国专利全文、法律状态与关键词检索的 CNIPR（search.cnipr.com）通道，以及为下载兜底解析专利 PDF 直链的 PatSnap（Open Platform P020）通道，外加从 Sati 移植的持久化与案例路径助手。模型可见面全部由消费方负责；本包只解析并提供专利数据。

## 目录

- [服务](#service)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知局限与延期工作](#known-limitations-and-deferred-work)

<a id="service"></a>
## 服务

`PatentData` 服务注入 `subprocess` 并暴露四个能力方法。

### createSearchProvider(options?)

构造基于 nuo 的 `StageProvider`，其 `search(query, { maxResults })` 将源命中映射为 `{ title, snippet, url }` 阶段词汇。未传 `options.search` 时，它把 nuo 的 `searchPatents` 套上 LRU 缓存，因此 TTL 内重复的检索式直接命中缓存，而不会重复触发网络路径；只有非空成功结果会入缓存，解析降级导致的零命中不会把一次瞬时失败固定整个 TTL。缓存包装返回 `CachedLookup<T>`——值加上 `cached` 与 `retrievedAt`（原始取数时间，命中缓存时保持不变），消费方据此写明事实是何时取得的，而不是何时被读取的。

### createEgoSession(options?)

基于注入的 `ctx.subprocess` 构造 `EgoBrowserSession`。该 runner 检查 ego-browser 可用性、探测连接、命名会话级 task space，并通过 stdin 原样执行脚本（subprocess 接缝的批量 stdin 取代了单引号 heredoc，因此脚本内容不会被 shell 展开）。`options.runner` 可覆盖默认的 subprocess 后端；命令名、探测与运行超时、输出上限由部署的 `Config` 给出，逐调用选项可逐项覆盖。

### createCniprChannel(options?)

基于一个 ego-browser 会话构造 CNIPR 通道；部署将 `Config.cniprEnabled` 保持关闭时返回空——消费方于是自己对每个号使用原有通道，而不是拿一个只会失败的对象。通道自己判号码形态（`classifyCniprNumber`）：公开(公告)号（`CN122072823A`）取全文 PDF 直链，申请号（`202311356097.5` / `2023113560975`，校验位前补小数点）取法律状态记录，关键词查询取结果页的记录行，其余形态按条目报「本通道不处理」。三种能力都经注入的会话执行一个生成的脚本（`cnipr-script.ts`）、在本包内解析收据（`cnipr-receipt.ts`），并按名复用同一个任务空间，使 ego lite 的登录态与标签页跨调用延续。号码级失败（查不到该号、解析不出申请号）是条目结果；通道级失败（无 ego-browser 或启动失败、超期限、无收据、登录态失效、关键词结果页的行结构变化）抛带分类码的 `CniprChannelError`，由调用方按码路由；调用方取消不属于通道失败，按 `AbortError` 传播。

### createPatsnapChannel(options?)

基于 `Config.patsnapApiKeyEnv` 指定的 API Key 构造 PatSnap 通道；部署将 `Config.patsnapEnabled` 保持关闭时返回空。Key 按调用读取，部署轮换 Key 不必重启服务；缺少 Key 时抛 `PatsnapChannelError('missing_key')`，而不是返回一个只会失败的对象。`pdfLinks(numbers, { timeoutMs, signal })` 按 `Config.patsnapBatchSize` 分批把公开号发给 Open Platform 的 P020 接口，把响应按请求顺序对齐，返回每个号的 PDF 地址与网关的 `x-openapi-amount` 合计。服务没有返回的号记 `not_found`（不计费）；记录存在但没有 PDF 的号记 `no_pdf`；形态不合法的号记 `invalid_number`，不会离开本进程。通道级失败（鉴权、权限、余额、限流、超时、协议变化）抛带分类码的 `PatsnapChannelError`，由调用方按码路由；调用方取消按 `AbortError` 传播。

<a id="configuration"></a>
## 配置

cordis.yml 的 `Config` 声明随部署变化的 ego-browser 取值、CNIPR 页面等待与 PatSnap 网关/批量取值；逐调用选项覆盖同名字段。

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `commandName` | `ego-browser` | CLI 命令名。 |
| `probeTimeoutMs` | `8000` | 连接探测超时（毫秒）。 |
| `defaultTimeoutMs` | `90000` | 默认运行超时（毫秒）。 |
| `maxTimeoutMs` | `300000` | 单次运行超时硬上限。 |
| `maxOutputBytes` | `500000` | 合并输出的软上限（字节）；截断保留完整的 UTF-8 字符。 |
| `nuoRequestChannel` | `auto` | nuo 请求走的通道：`auto` 用 nuo 自己的可用性探测且不改环境，`native` 强制原生 fetch，`browser` 强制 ego 浏览器，`fallback` 先用原生 fetch、连接失败时经浏览器重试。取任一显式值都会写入进程级 `NUO_PATENT_EGO_BROWSER`——该环境变量是 nuo 唯一的开关；服务销毁时恢复它替换掉的原值。该变量是进程级的，因此多个挂载的显式选择按最后写入者生效。 |
| `cniprEnabled` | `false` | 本部署是否经 CNIPR 取中国专利全文、法律状态与关键词检索。该通道复用 ego lite 在 `search.cnipr.com` 的登录态，没有该登录态的部署打开它得不到东西；此时 `createCniprChannel()` 返回空，消费方继续走 nuo 引擎并点名自己用的通道。 |
| `cniprLoginPollMs` | `1000` | 登录态轮询间隔（毫秒）。 |
| `cniprLoginAttempts` | `10` | 每轮登录态轮询次数。 |
| `cniprLoginRounds` | `2` | 登录态轮询轮数；除最后一轮外，每轮结束 reload 首页。 |
| `cniprNavigationTimeoutMs` | `45000` | 页面导航期限（毫秒）：首页 `goto`/reload 与检索结果页 URL。 |
| `cniprActionTimeoutMs` | `15000` | 点击与表单提交期限（毫秒）。 |
| `cniprResultTimeoutMs` | `30000` | 结果页结构出现期限（毫秒）：详情检索表单、法律状态表单与结果 URL、翻页标记。 |
| `cniprRenderTimeoutMs` | `20000` | 结果内容渲染期限（毫秒）：结果行、申请号、法律状态结果标题。 |
| `cniprDetailTimeoutMs` | `20000` | 详情检索接口的响应期限（毫秒），该接口返回内嵌全文直链的 HTML。 |
| `patsnapEnabled` | `false` | 本部署是否可用 PatSnap 作为专利 PDF 的兜底。Key 从环境变量读取；关闭时 `createPatsnapChannel()` 返回空，下载工具保留 Google 的结果。 |
| `patsnapApiKeyEnv` | `PATSNAP_API_KEY` | 保存 Open Platform Key（`sk-…`）的环境变量名。Key 不是配置字段，不会进入 `cordis.yml` 或日志。 |
| `patsnapBaseUrl` | `https://connect.patsnap.com` | API 网关。 |
| `patsnapTimeoutMs` | `30000` | 单次 P020 请求的期限（毫秒）。 |
| `patsnapBatchSize` | `20` | 每次 P020 请求携带的号码数（1–50）。按成功返回的记录计费，批量大小换的是往返次数，不是积分。 |
| `patsnapReplaceByRelated` | `true` | 请求号没有 PDF 时用同族替代；响应里的 `pn_related` 作为 `resolvedNumber` 返回。 |

其余选项只走逐调用：它们是测试接缝，或本服务无从知晓的取值。

| 方法 | 键 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `createSearchProvider` | `search` | LRU 缓存的 nuo `searchPatents` | 底层检索函数注入。 |
| `createEgoSession` | `homeDir` | `os.homedir()` | 定位 `~/.local/bin` 的主目录。 |
| `createEgoSession` | `pathEntries` | `[<home>/.local/bin]` | 注入 spawn 环境的额外 PATH 目录，可用性检查同样使用。 |
| `createEgoSession` | `platform` | `process.platform` | 平台覆盖。 |
| `createEgoSession` | `env` | `process.env` | 子进程环境白名单的来源：`PATH`（另含 `pathEntries`）、`HOME`、`LANG`、`LANGUAGE`、`LC_*`、`DISPLAY`、`WAYLAND_DISPLAY`、`XAUTHORITY`、`XDG_RUNTIME_DIR`、`DBUS_SESSION_BUS_ADDRESS`。其余名称不传入。 |
| `createEgoSession` | `runner` | subprocess 后端 runner | 测试用 spawn runner 注入。 |
| `createCniprChannel` | `timeoutMs` | 会话 `defaultTimeoutMs` | 单次 CNIPR 脚本运行的期限。 |
| `createPatsnapChannel` | `timeoutMs` | `Config.patsnapTimeoutMs` | 单次 P020 请求的期限。 |
| `createPatsnapChannel` | `batchSize` | `Config.patsnapBatchSize` | 每次 P020 请求携带的号码数。 |
| `createCniprChannel` | `pageBudgets` | `Config` 解析出的取值 | 单个通道的逐项等待覆盖；给出一个字段只换那一项。 |
| `createCniprChannel` | `cwd` | `process.cwd()` | 脚本子进程的工作目录；脚本不落盘。 |

<a id="model-experience"></a>
## Model Experience

None, as the data seam resolves and serves patent data to the tool layer; dsh-patent-tools owns every model-facing schema and result.

#### KV Cache effect

Independent; the data seam registers no prompt, tool schema, or result of its own.

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与延期工作

- **外部 `ego-browser` CLI 依赖** — 反爬抓取路径需要外部 `ego-browser`（ego-lite）CLI 已安装且在 PATH 上（仅 macOS）；本包不随附任何 ego-browser 脚本资产（Sati 的 `skills/ego-browser/` 仅含 learnings），因此站点反爬升级在本包之外维护。
- **PatSnap 真机探测** — `tests/patsnap-live.e2e.ts` 调真实 P020 网关，每条返回记录消耗一个积分；未设置 `DSH_PATSNAP_LIVE=1` 与 `PATSNAP_API_KEY` 时跳过。
- **PatSnap 通道范围与计费** — 通道用 `Config.patsnapApiKeyEnv` 的 Key 经 HTTP 调 Open Platform 的 P020；需要能访问网关，且 Key 具备 P020 权限。成功返回一条记录消耗一个 `x-openapi-amount` 单位，服务省略的号与没有 PDF 的号不计费，混合批次只返回它能服务的号。网关对业务失败也回 HTTP 200，因此通道解析 `status`/`error_code`：`68300008` 表示整批没有 PDF，按逐号 `not_found` 处理；`6720000x` 才是通道级失败。体验套餐限 10 请求/分钟，批量大小足以让 50 篇的调用落在限制内。
- **nuo 的浏览器路径会自行启动 `ego-browser` 进程** — nuo 2.3.2 在页面内用 `fetch` 读取原始响应体，JSON 查看器扩展不再把搜索 XHR 渲染成 HTML；`fallback` 先用原生 fetch，连接失败时才经浏览器重试。该路径仍在 harness `ctx.subprocess` 接缝之外启动 `ego-browser nodejs`（128 MB 输出上限、取消时不杀进程树），因此要求所有子进程都受接缝治理的部署应设 `nuoRequestChannel: native`。dsh 侧的 ego 会话仍只经接缝覆盖 pdf-download 路径。
- **CNIPR 通道的范围与维护** — 该通道经 ego lite 操作 `search.cnipr.com`，因此需要那份登录态，也继承平台限制：站点声明不支持爬取，故通道按普通页面交互逐号取，从不批量、不并发。同一个 `PatentData` 服务创建的通道共用一个串行队列，因为每个脚本复用同一个命名任务空间与标签页；该服务内的并行工具调用会排队等待，而不是同时驱动同一页面。队列以服务为界：不同 dsh 进程、以及同一 ego lite profile 上挂载的多个服务仍可能互相干扰，因此一个 ego profile 应只运行一个启用 CNIPR 的 patent-data 挂载。它的页面契约（搜索框、详情检索 POST、法律状态表单、结果行字段、`pic.cnipr.com/pdfcn/...` 直链模式）属于站点：站点一变，第一次调用就以 `page_state` 暴露，而不是静默返回空答案——收据要么解析得出，要么解析不出；关键词结果行丢失公开(公告)号时同样以 `page_state` 失败，而不是静默缩短命中列表。法律状态记录来自结果页文本；页面上没有记录时计数为 null，不编造 0。检索直接读结果行（行上已带标题、申请人、公开日与摘要，因此不必逐条取详情页）；页面每页十条，其 20/30 条选项对本部署账号等级会被拒，故更大的 `limit` 靠翻站点自身的分页来取，单次上限三页。这两个上限是站点/账号协议值，固定不变；其余页面等待都是 `Config` 字段，慢主机、登录态刷新或站点改版都不必重新发布。
- **CNIPR 真机探测** — `tests/cnipr-live.e2e.ts` 端到端驱动真实站点，需以 `DSH_CNIPR_LIVE=1` 显式开启；未设置或没有 `ego-browser` 时跳过，并会占用部署的 CNIPR 登录态。
- **消费方接线** — 检索 provider 工厂与 ego-session runner 由 `dsh-patent-tools` 消费（patent_search/metadata/legal_status 与 patent_pdf_download 的 Google 腿）；CNIPR 通道由 `patent_legal_status`（中国法律状态记录）、`patent_search`（引擎失败或零命中时的中国关键词检索）与 `patent_metadata`（引擎失败、抛错或查不到的中国公开(公告)号）消费；PatSnap 通道由 `patent_pdf_download` 在 Google 腿拿不到有效 PDF 时作为兜底消费。缓存、映射、持久化与路径模块保持库导出供这些消费方使用。

### 开发备注

无。

本包不发布 invariant 伴生组件：数据缝按需服务调用方，不持有包属持久事件流；检索与 ego-browser 运行由工具层消费，模型可见与会话日志关系归工具层所有。
