# Day 40 — 深挖（一）：法条核验与说明书立案

## 今日维度与范围

本日深挖 LAW 与 SPC。两族覆盖 P1 通过线上全部可归属的低于线格子：缺必填、可解释性、路径、超长、注入。数据来自 [day-12.md](day-12.md) 的 15 次直接调用与 54 条对抗样本、[day-22.md](day-22.md) 的脚本基线、[day-28.md](day-28.md) 与 [day-30.md](day-30.md) 的真实模型记录。本日不重跑已经测过的样本，不调用真实模型，不改 `daily/`、业务代码、依赖、CI 或基础设施配置。

## LAW 十列

| 指标 | 读数 | 口径与来源 |
|---|---|---|
| 工具选择 | 12/12 | 12 个非拒绝样本，首个相关调用都在可接受集合 |
| 参数填充 | 语法 12/12；语义 8/12 | 语义失分：P-LAW-02 三轮 `query` 偏离、P-LAW-04 第 1 轮多传 `patent_type` |
| 调用闭环 | 8/15 | 应调用 7/12（P-LAW-01 2、P-LAW-03 3、P-LAW-04 2）；拒绝 1/3 |
| 拒绝与鲁棒 | 拒绝 1/3；误拒 0/12 | P-LAW-05 第 1、3 轮先调用禁止工具；直接调用层 `{}` 探针落在 `law_verify` |
| 响应时间 | 26.5 / 420.3 秒 | 全部 15 次；成功样本 26.5 / 95.0 秒 |
| 成本效率 | 0.0226 元/成功 | 总 0.3458 元；成功 0.1804 元；失败 0.1653 元 |
| 可解释性 | 直接调用 1 次无 code | `law_verify` 空对象；真实模型层没有工具失败 |
| 上下文利用率 | 4.9% | 7 个成功且调用过工具的非拒绝样本 |
| 错误恢复 | 3/3 | 超时、空结果、取消各 1 次，二调都闭环 |
| 资源利用率 | 模型调用 64 次；provider 0；峰值内存未测；残留 0 | 没有外部 provider；`ps` 探针之外子进程为 0 |

## LAW 失败链

低于线的只有缺必填一格。2026-11-21 的 `{}` 探针走了三步：空对象通过 `citationVerifyParameters`，因为 `text` 与 `references` 都不是 `required`；`createCitationVerifyTool` 在 `execute` 里调用 `citationInputProblem`，得到 `no_input`；专利侧 `law-verify.ts` 抛出 `LawVerifyToolError`。异常对象带 `code: no_input`，但该类不是 `HarnessError`，核心只在 `HarnessError` 上把 `{ name, code }` 写进 `tool/result.error`，所以会话事件里没有 code。这就是 [F-CROSS-005](../05-findings.md) 已经登记的现象。

F-CROSS-005 修的是错误类继承，修完以后事件会带 `no_input`。但缺必填格要求的是 `INVALID_ARGS`：参数层没有拒绝，业务层才拒绝，code 的分类也不会变成参数错误。这一层差异 F-CROSS-005 没有覆盖，是本日的新发现 F-LEG-015。

真实模型的其余落差都不在直接调用层：P-LAW-02 的 `sourcePath` 是冻结题面路径差；P-LAW-04 第 1 轮多传 `patent_type` 是单发参数偏离，后两轮回到 5 / 25；P-LAW-05 的工具先行是跨族稳定的模型行为；P-LAW-01 第 3 轮 420.3 秒是进程时限。这四处都不改写成代码缺陷。

## LAW 代码证据

`packages/law/law-core/src/citation-tool.ts:79`–`:86` 的参数表只有两个可选属性，没有 `required`，也没有二选一约束。`:55`–`:56` 的 `citationInputProblem` 返回 `no_input`，这是业务层的拒绝码。`packages/patent/patent-law/src/tool/law-verify.ts:107` 的描述已经写明「Blank text without references is an input error, so a zero-byte call cannot stand in for a completed check」；`packages/legal/legal-law/src/tool/law-verify.ts:105` 的对应段落只写了「pass the text ... or pass exact references」，没有零字节规则。两个工具共用同一张参数表，描述却不对称。

## SPC 十列

| 指标 | 读数 | 口径与来源 |
|---|---|---|
| 工具选择 | 12/12 | 12 个非拒绝样本；近邻题没有选到渲染工具 |
| 参数填充 | 语法 12/12；语义 11/12 | 语义失分：P-SPC-03 第 3 轮把字段拆成标签与值 |
| 调用闭环 | 13/15 | 应调用 11/12（P-SPC-03 第 3 轮、P-SPC-05 第 3 轮失败）；拒绝 2/3 |
| 拒绝与鲁棒 | 拒绝 2/3；误拒 0/12 | 直接调用层覆盖缺必填、路径、超长、注入四条 |
| 响应时间 | 34.0 / 130.2 秒 | 全部 15 次；成功样本 27.3 / 83.2 秒 |
| 成本效率 | 0.0319 元/成功 | 总 0.5475 元；成功 0.4147 元；失败 0.1328 元 |
| 可解释性 | 直接调用 5 次无 code | `render_patent_document` 题面、路径、注入各 1 次；`build_patent_filing` 与 `verify_patent_filing` 路径各 1 次。题面这一次是 14/15 里不可解释的那一格，其余 4 次来自 54 条对抗样本 |
| 上下文利用率 | 7.5% | 11 个成功且调用过工具的非拒绝样本，是四族最高 |
| 错误恢复 | 3/3 | P-SPC-01 取消、P-SPC-02 空结果、P-SPC-04 超时，二调都闭环 |
| 资源利用率 | 模型调用 156 次；provider 0；峰值内存未测；残留 0 | 四族里模型调用最多，来自文档类参数与结果的体积 |

## SPC 失败链

可解释性、路径、注入三格的失败都落在 `DraftValidationError` 或 `PatentFilingError` 上，这两个类都是普通 `Error`，没有进入 `HarnessError` 分支，事件里没有 `error.code`。四类失败的工具文本分别是「草案校验失败（16 项）」「输出目录 越出工作目录」「待验收文件不存在」。三处都没有越界写入或新文件，行为本身是正确的，缺的是 code。这属于 [F-CROSS-005](../05-findings.md) 的已登记范围。

缺必填格不同：`{}` 没有被拒绝，`validate_specification` 把它当成一次校验。`packages/patent/patent-tools/src/tool/validate-specification.ts:95` 写的是 `const text = input.text ?? ''`，`:432` 的 `text` 没有 `required: true`。空对象因此通过 schema，进入校验器，返回 `isError` 为假、`passed` 为假、`score` 0.65 的报告，错误文案是「说明书缺少所有必要章节（text 为空）」。调用方看到的是一个成功的工具结果，不是 `INVALID_ARGS`。同包的 `claim-lint.ts:154` 对空白正文有显式拒绝（「text 不能为空白」），两个文本工具的空白处理不对称。

超长格的两个样本都停在 contained：8 万字正文被 schema 接受，工具返回未通过的校验报告，`isError` 为假，没有新文件。这是处理完成后的常量级结果，不是拒绝，也不是残留。口径建议见下一节。

P-SPC-04 第 3 轮的成品落在 `data/cases/CN2026-PILOT-01/outputs/pilot-filing.docx`，不在 `.dsh/documents` 快照范围，[day-25.md](day-25.md) 已注明。外部判定按工具回报的成品路径与「验收全部通过」记成立，读数不变；留档缺口留给 P6 决定是否把 case 输出目录纳入快照，本阶段不登记为代码缺陷。

## 超长格的口径建议

`claim_lint` 与 `validate_specification` 都是文本处理工具，正文长度本身没有产品上限。P1 把「schema 接受、返回校验报告」记为不通过，是把 fail-closed 的规则套到了文本处理工具上。8 万字样本的实际结果是：处理完成、没有文件写入、没有子进程、没有残留。按 [day-12.md](day-12.md) 的口径这属于 contained，不是失败。

建议在下一轮直接调用重跑时把这一格改成「contained 记通过」，并在样本表里保留 8 万字的墙钟与产物检查；如果产品确实需要长度上限，那是一个新的可配置字段，不是 P5 能补的实现。本阶段不改口径，也不为这一格登记代码缺陷。

## 今日新增发现

| 编号 | 维度 | 严重度 | 可能性 | 工作量 | 能自动判定 |
|---|---|---|---|---|---|
| F-LEG-015 | E | Low | 高 | M（扩展参数 DSL）或 S（入口检查） | 是 |
| F-PAT-057 | E | Low | 高 | S | 是 |

两条都写入 [05-findings.md](../05-findings.md)，编号按该文件当前最大序号加一：F-LEG 现有最大 014，F-PAT 现有最大 056。F-CROSS-005 不重复建条目，只在两条的「影响」里说明分工。

## 本日结论

LAW 与 SPC 的直接调用低于线格子共 5 个，落点只有四个工具：`law_verify`、`validate_specification`、`render_patent_document`、`build_patent_filing` 与 `verify_patent_filing`。其中四个格子由 F-CROSS-005 统一覆盖，真正的新代码缺陷是两条：核验参数的二选一没有进参数层，校验工具把空正文当成完成的校验。两族的选择、语法与恢复都没有缺口，真实模型的落差主要是冻结题面与模型行为，不升级为代码缺陷。

## 明日第一件事

拆 CLM 与 FEE：CLM 只看超长一格的 contained 读数，FEE 只看扩域三列不通过后扣除判定差的 6/6，确认两族是否还有没登记的实现问题。
