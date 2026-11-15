# Day 10 — 2026-11-24

> 实际执行：2026-11-15（按计划日序号提前推进；计划日期为 2026-11-24）。

## 今日维度与范围

- 维度：A 安全缺陷
- 范围：法律模式与共享机制：legal-knowledge、legal-law、legal-evidence、law-core、knowledge-core
- 时间盒：90 分钟
- 预期产出：A 维度法律/共享域候选发现；daily/day-10.md

## 检查项

- [x] 检查 FTS 查询是否参数化，安装路径是否受控。
- [x] 检查法条索引加载路径与引用核验边界。
- [x] 检查证据评分的输入边界与规则来源。
- [x] 检查共享层是否放大任一域的风险。
- [x] 检查"未核验"降级是否 fail closed。

## 实际执行

| 动作 | 结果摘要 |
|---|---|
| 扫 SQL 与插值 | `legal-knowledge` 只有一处表名插值，取自包内固定数组；FTS 与 LIKE 全部绑定参数 |
| 查安装入口 | `installLegalKnowledgeDb` 是显式 API/CLI，输入输出路径来自 options，不注册为工具 |
| 读索引加载 | `legalLawBaselineDir` 只接受 `Config.baselineDir`；加载前有 `assertLegalLawIndexReadable` |
| 读引用核验策略 | `legal-law` 的五个 `on*` 策略只由 `Config` 提供；shipped `legal.patch.yml` 把 mismatch/unverified/notIndexed 都设为 `block` |
| 读证据输入 | `evaluate_legal_evidence` 只接受证据属性字段，没有策略或权重入参；规则资产缺失时插件加载失败 |
| 查共享层 | `knowledge-core` 的 FTS/LIKE 转义由两域共用；`law-core` 为纯决策函数 |

## 发现

**无。** 今日范围未发现可执行的安全缺陷。既有的 F-LEG-002（`legal-evidence` 的 YAML 通用规则不参与判定）是正确性问题，已在 Day 5b 记录，本轮不重复计入。

定向结论：

- **SQL 全部参数化**：`MATCH ?` 与 `LIKE ?` 绑定；`likePattern` 转义 `%`、`_`、反斜杠并配合 `ESCAPE '\'`；`DROP TABLE` 的表名取自包内固定数组，不来自输入。
- **安装路径受控**：`installLegalKnowledgeDb` 的源库与输出目录来自 options/CLI，不属于模型可见工具。
- **索引与策略都来自部署**：`baselineDir` 与五个引用策略只由 `Config` 提供；shipped legal preset 把 `mismatch`、`unverified`、`notIndexed` 全部设为 `block`，未核验不会静默通过。
- **证据评分不收回合策略**：工具只收证据属性（是否提供原件、签章是否核验、收集是否合法等），没有策略、权重或"跳过"入参；规则资产缺失时插件在加载期失败。
- **共享层不放大风险**：两域共用同一份转义与阶梯实现，任一侧的回归会同时影响两域，这是共享的收益也是代价；当前实现正确，未发现单域特化分支。

## 假设验证/推翻

- H02：**确认并稳定**。决策层共用 `law-core`，检索层各有一份骨架但共用 `knowledge-core` 的转义与阶梯；Day 10 未发现两域行为分叉带来的安全问题。
- H07：**维持 Day 7 结论**。法律域对未核验 fail closed；专利域的缺口在立案构建路径（F-PAT-017），不在法律域。
- H01：本轮未涉及。

## 未决问题

1. `knowledge-core` 的 `commitTempSibling` 在目标已存在时先 `rmSync` 再 `renameSync`，不是原子替换；它只服务安装 CLI，中断时输出库会缺失而不是半写。是否要改用共享的 `writeFileAtomic` 语义，留到 Day 23 的资源生命周期维度一起看。
2. `legal-knowledge` 的粘性降级（FTS 异常后永久 LIKE）会让检索静默变慢但结果仍正确；是否需要在工具结果里回传降级状态，留到 Day 30 的模型可见性维度。
3. shipped legal preset 的 `block` 策略与 patent preset 的 `warn` + 渲染门禁是两套设计；跨域复用同一段引用文本时行为不同，已在 F-LEG-004 记录。

## 明日第一件事

Day 11：视频模式，检查 ffmpeg filter graph 的参数注入面、provider HTTP 请求的 URL 与凭据、项目 JSON 的路径与并发写入、`ui-video-studio` 的客户端渲染与下载路径，以及成本账本是否可被输入篡改。
