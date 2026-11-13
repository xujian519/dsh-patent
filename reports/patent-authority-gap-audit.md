# 权威缺口审计报告（D1–D5）

核对日期：2026-11-13
基线：`packages/patent/patent-law/assets/authority/authority-baseline.yaml` v1.0
度量：`reports/patent-authority-metrics.json`、`reports/patent-authority-metrics.md`

## 摘要

八件核心法源的 9 个载体已登记 SHA-256，全部与知识库原件一致。随包索引覆盖《专利法》38/82 条（46.3%）、《专利法实施细则》45/149 条（30.2%）、《专利审查指南》85/1096 个编号标题（7.8%，其中 70 条带正文）、司法解释 0/7、部门规章 0/9。

机器扫描到 48 处索引无法判定的引用：4 处条号不在索引内，44 处引用了没有节正文的指南容器路径。另有 38 处 `legalBasis` 不含条号或指南节路径。

本次审计新发现 3 处引用条号错误，均在规则或模板资产中，尚未修复：

| 文件:行 | 现引用 | 现行条号 | 权威原文 |
| --- | --- | --- | --- |
| `packages/bundle/web-app/skills/legal/ip/legal-ip-ip-clause-review/SKILL.md:115` | 专利法第 17 条（发明人署名权） | 第 16 条 | 第十六条 发明人或者设计人有权在专利文件中写明自己是发明人或者设计人。 |
| `packages/patent/patent-tools/src/atoms/legal-gaps.ts:358` | 专利法第 59 条（保护范围与全面覆盖） | 第 64 条 | 第六十四条 发明或者实用新型专利权的保护范围以其权利要求的内容为准，说明书及附图可以用于解释权利要求的内容。 |
| `packages/bundle/web-app/skills/patent/patent-team-composition/SKILL.md:182` | 专利法第五十九条第一款（解释权利要求） | 第六十四条第一款 | 同上。 |

## 版本事实核验

《专利审查指南》现行版本是 **2026 年修订版**。国家知识产权局令第 84 号于 2025 年 11 月 10 日公布、2026 年 1 月 1 日施行（[官方公告](https://www.cnipa.gov.cn/art/2025/11/13/art_526_202559.html)）。知识库存有 2023 版全文与 2025-11-13 的官方修改对照表，没有 2026 年合订全文。

随包索引的 `supersededBy: 2026 年修订版（2026-01-01 施行）`、三节 `versions` 覆盖与 `staleSections` 与官方公告一致。计划原文与 #816 把 2026 版写成“并不存在”，这个判断与官方公告矛盾；真正的问题是索引只转录了 3 节 2026 文本，其余 61 节仍是 2023 文本，路径也未按 2026 版改号。

因此 D17–D18 的目标应改为“以 2023 全文加修改对照表补出 2026 文本”，不能把现有三节覆盖当作缺陷删除。

## 覆盖矩阵

| 文书 | 权威范围 | 索引条目 | 带正文 | 覆盖率 | 口径 |
| --- | --- | --- | --- | --- | --- |
| 专利法 | 82 | 38 | 38 | 46.3% | 索引 `maxArticle` |
| 专利法实施细则 | 149 | 45 | 45 | 30.2% | 索引 `maxArticle` |
| 专利审查指南 | 1096 | 85 | 70 | 7.8% | 官方 PDF 编号标题数（基线登记） |
| 司法解释 | 7 | 0 | 0 | 0.0% | 索引不含该文书种类 |
| 部门规章 | 9 | 0 | 0 | 0.0% | 索引不含该文书种类；第 9 件是地方规章，口径待 P1 核定 |

## 索引无法判定的引用

完整清单见 `reports/patent-authority-metrics.json` 的 `unresolved` 数组，每条带文件、行号、原文与原因。

### 条号不在索引内（4 处）

| 文件:行 | 引用 | 性质 | 权威原文 |
| --- | --- | --- | --- |
| `packages/bundle/web-app/skills/legal/ip/legal-ip-ip-clause-review/SKILL.md:115` | 专利法第 17 条 | 条号错误，应为第 16 条 | 第十六条 发明人或者设计人有权在专利文件中写明自己是发明人或者设计人。 |
| `packages/bundle/web-app/skills/patent/patent-team-composition/SKILL.md:182` | 专利法第五十九条第一款 | 条号错误，应为第六十四条第一款 | 第六十四条 保护范围以权利要求的内容为准。 |
| `packages/patent/patent-tools/src/atoms/legal-gaps.ts:358` | 专利法第 59 条 | 条号错误，应为第 64 条 | 同上。 |
| `packages/patent/patent-document/assets/templates/patent/litigation-pleading/references/citation-log.md:18` | 第六十五条 | 索引缺条 | 第六十五条 未经专利权人许可实施其专利引起纠纷的处理。 |

`packages/patent/patent-deadline/README.md:116` 与 `README.zh.md:118` 的“细则第 82 条”不在扫描范围内（README 不属于随包资产的引用面），但同样是索引缺条：细则索引尚未收录第 82 条。

### 指南容器路径未转录（44 处）

绝大部分是 `专利审查指南第一部分`、`审查指南第二部分第二章3.1` 这类容器或未索引路径，集中在 `patent-tools` 的制图与体例代码、模板资产与技能文档。容器条目本身不带正文，引用它时 `law_verify` 报“条文未转录”，由子节判定。P1 的 D13–D16 补齐节正文后，这些引用才会得到判定。

## 无条号或无法定位的 legalBasis（38 处）

按内容分三类，完整清单见 `reports/patent-authority-metrics.json` 的 `unstructured` 数组：

- **执业规范与内部质量门禁**：如“AI 输出不构成正式法律意见”“回避绝对化断言”。这类依据不是法条，P2 结构化引用时应登记为豁免，不要求条号。
- **判例与司法实践总结**：如“(2025)最高法知行终959号”“无效复审决定585168”。需要单独的判例引用结构，不属于法条索引。
- **只写法名、没有条号**：如“最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（禁止反悔原则）”。P2 必须补到条、款。

## 哈希与复现

9 个载体的 SHA-256 全部与知识库原件一致（`--verify-hashes` 输出 9 个 `match`）。复现命令：

```sh
npx tsx scripts/patent-authority-metrics.ts --verify-hashes
npx tsx scripts/patent-authority-metrics.ts --check
```

`--check` 比较重新生成的两个文件与仓库内的记录；`--verify-hashes` 在知识库不可用时把载体标为 `unavailable`，不会判为通过。

## 口径与限制

- 指南分母 1096 取自计划实测，本次未从 PDF 复算；源 PDF 在知识库外，脚本读取不到时保留登记值并标注。
- 紧凑写法 `A22`、`A22.3` 与“《专利法》82 条”这类数量表述不计入引用缺口；它们与 IPC 分类号、覆盖数字同形。
- 条号错误的三处是人工对照知识库原文得出的，脚本只能发现“索引里没有”，不能判断“引用了错误的条”。
- 规则资产的 `legalBasis` 分类是机械判定，豁免与判例分类需要 P2 人工登记。
