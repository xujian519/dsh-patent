# Day 11 — 2026-11-25

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-25）。

## 今日维度与范围

- 维度：A 安全缺陷
- 范围：视频模式：video-mode、video-bundle、ui-video-studio
- 时间盒：90 分钟
- 预期产出：A 维度视频域候选发现；daily/day-11.md

## 检查项

- [x] 检查 ffmpeg filter graph 的参数注入面。
- [x] 检查 provider HTTP 请求的 URL、凭据与响应处理。
- [x] 检查项目 JSON 的路径、文件锁与并发写入。
- [x] 检查 ui-video-studio 的客户端渲染与下载路径。
- [x] 检查成本账本是否可被输入篡改。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 读 EDL schema 与 `buildFfmpegArgs` | 画布、帧率、时长均为区间整数；`color` 受六位十六进制正则约束；字幕与字体分别经两个转义函数 |
| 读路径解析 | `resolveEdlPaths` 把每个输入、字幕与输出都过 `ctx.fs.resolve` + `processPath` 后再交给 ffmpeg |
| 读 provider | `downloadVideo` 限定 `http:`/`https:`，按 `content-length` 与实测字节双重限流；`apiKey` 只出现在 `Authorization` 头 |
| 读账本 | `budget.json` 为工程目录下的明文 JSON，读取时无校验，写入只做进程内去重 |
| 读客户端 | 无 `dangerouslySetInnerHTML` 或 `innerHTML`；读取统一走 `workspaceFiles` Remote |

## 发现

- **F-VID-007**（Medium，A）：成本账本无完整性保护。`budget.json` 与 `project.json` 同在模型可写的工作区，预算判定读回后无签名或校验，模型可以同时调低两侧绕过 `MEDIA_BUDGET_EXCEEDED`。

定向结论中确认已处理、不立发现的项见 [05-findings.md](../05-findings.md) 的「Day 11 定向结论」。

## 假设验证/推翻

- H04：**结论收紧**。提交前预算检查、幂等账本、`max()` 在实现层面是完整的，但账本文件的完整性依赖工作区不可被模型改写，这一前提在带文件工具的会话里不成立。H04 从「正向证据」改为「实现正确、威胁模型不成立」。
- H05：**视频域汇点已处理**。filter graph 的字符串面由正则与两个转义函数覆盖，路径面由 `ctx.fs` 覆盖。
- H10：**维持**。provider 响应只进产物与错误消息，原始响应是否进会话事件仍待 Day 40。

## 未决问题

1. 账本如果要移出工作区，需要先定义"工程 id → 应用数据目录"的映射与跨设备行为；视频工程目前以工作区路径为身份。留到 Day 39。
2. `downloadVideo` 只校验协议不校验主机，恶意或失陷的 provider 可以让宿主访问内网地址；响应被字节上限与类型假定约束，但仍是 SSRF 面。是否要加主机白名单，取决于是否支持自定义 provider 端点。
3. `ui-video-studio` 的下载入口走 `workspaceFiles` Remote，路径由客户端传入；Remote 端的授权边界留到 Day 25 复核。

## 明日第一件事

Day 12：横向复核——在四域扫描可疑密钥与令牌模式（只记文件、行号、类型与「已脱敏」），检查凭据读取与错误报告是否泄露敏感值，检查新增依赖与供应链面，并汇总 A 维度发现与去重结果。
