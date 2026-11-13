# 专利法源覆盖与缺口度量

基线版本：1.0，核对于 2026-11-13；登记 8 件核心法源。

知识库源：`宝宸知识库_Raw`；哈希校验由 `--verify-hashes` 另行报告。

## 覆盖矩阵

| 文书 | 权威范围 | 索引条目 | 带正文 | 覆盖率 | 口径 |
| --- | --- | --- | --- | --- | --- |
| 专利法 | 82 | 82 | 82 | 100.0% | 随包索引 maxArticle |
| 专利法实施细则 | 149 | 149 | 149 | 100.0% | 随包索引 maxArticle |
| 专利审查指南 | 1335 | 1335 | 1145 | 100.0% | 官方 PDF 编号标题数（guideline-extent.yaml：1145 节带正文） |
| 司法解释 | 7 | 0 | 0 | 0.0% | 索引不含该文书种类 |
| 部门规章 | 9 | 0 | 0 | 0.0% | 索引不含该文书种类 |

## 无法判定的引用

共 0 处；紧凑写法 A22 / A22.3 未计入（IPC 分类号与模板占位符同形）。

## 无条号或无节路径的 legalBasis

共 38 处。

| 文件:行 | 记录的依据 |
| --- | --- |
| `packages/patent/patent-rule/assets/rules/base/citation.yaml:19` | 引用核验 R1：条号不得超出《专利法》（2020 修正，共 82 条） |
| `packages/patent/patent-rule/assets/rules/base/compliance.yaml:19` | 执业规范：AI 输出不构成正式法律意见，应由专利代理人/律师确认 |
| `packages/patent/patent-rule/assets/rules/base/compliance.yaml:54` | 质量门禁：结论性/侵权性/有效性判断需人工确认 |
| `packages/patent/patent-rule/assets/rules/base/compliance.yaml:77` | 审查规范：回避绝对化断言（绝对可以/一定能够/必然导致等），改用限定性表述 |
| `packages/patent/patent-rule/assets/rules/base/inventiveness.yaml:66` | (2025)最高法知行终959号：无公知常识性证据支持认定"容易想到""易于获得"，实难令人信服 |
| `packages/patent/patent-rule/assets/rules/domains/legal/compliance.yaml:19` | 执业规范：AI 辅助法律分析不构成正式法律意见，应附免责声明 |
| `packages/patent/patent-rule/assets/rules/domains/legal/compliance.yaml:68` | 《民事诉讼法》关于管辖的规定：被告住所地、合同履行地、侵权行为地等 |
| `packages/patent/patent-rule/assets/rules/domains/legal/compliance.yaml:91` | 法律分析不得给出确定性结果承诺，应使用限定性表述 |
| `packages/patent/patent-rule/assets/rules/domains/legal/compliance.yaml:121` | 引用规范：法条引用应注明法律名称、条号及款项 |
| `packages/patent/patent-rule/assets/rules/domains/mechanical/inventiveness.yaml:25` | 无效复审决定585168：名称不同不等于技术实质不同，结构功能等效性须实质分析 |
| `packages/patent/patent-rule/assets/rules/domains/medical/inventiveness.yaml:23` | 最高法院判例要旨：区别特征仅在于治疗用途且对产品本身没有影响的，不能因用途区别认定产品权利要求具备创造性 |
| `packages/patent/patent-rule/assets/rules/patent/compliance.yaml:18` | 执业规范：AI 输出不构成正式法律意见，应由专利代理人/律师确认 |
| `packages/patent/patent-rule/assets/rules/patent/compliance.yaml:55` | 质量门禁：结论性/侵权性/有效性判断需人工确认 |
| `packages/patent/patent-rule/assets/rules/patent/compliance.yaml:78` | 审查规范：回避绝对化断言（绝对可以/一定能够/必然导致等），改用限定性表述 |
| `packages/patent/patent-rule/assets/rules/patent/compliance.yaml:118` | 引用核验 R1：条号不得超出《专利法》（2020 修正，共 82 条） |
| `packages/patent/patent-rule/assets/rules/patent/evidence-rules.yaml:109` | 最高人民法院关于互联网法院审理案件若干问题的规定 |
| `packages/patent/patent-rule/assets/rules/patent/evidence-rules.yaml:400` | 最高人民法院关于民事诉讼证据的若干规定 |
| `packages/patent/patent-rule/assets/rules/patent/evidence-rules.yaml:435` | 电子签名法、最高人民法院关于电子数据证据的规定 |
| `packages/patent/patent-rule/assets/rules/patent/mady-gap-rules.yaml:31` | 撰写规范：法条引用应精确到条、款 |
| `packages/patent/patent-rule/assets/rules/patent/mady-gap-rules.yaml:49` | 撰写规范：分析结论应同时给出结论陈述与法律/事实依据 |
| `packages/patent/patent-rule/assets/rules/patent/mady-gap-rules.yaml:414` | 最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（禁止反悔原则） |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-core-rules.yaml:104` | 最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:13` | 司法实践总结（2023）最高法知民终844号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:30` | 司法实践总结（2023）最高法知民终405号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:46` | 司法实践总结（2024）最高法知民终370号、（2022）最高法知民终2302号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:63` | 司法实践总结（2023）最高法知民终2520号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:85` | 司法实践总结（2019）最高法知民终87号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:118` | 司法实践总结（2022）最高法知民终2920号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:134` | 司法实践总结（2019）沪民终136号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:168` | 司法实践总结（2019）最高法知民终831号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:185` | 司法实践总结（2022）最高法知民终2100号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-judgment-rules.yaml:212` | 司法实践总结（2020）最高法知民终248号 |
| `packages/patent/patent-rule/assets/rules/patent/nuo-patent-practice-rules.yaml:131` | 专利代理实务 |
| `packages/patent/patent-rule/assets/rules/patent/oa-response-form.yaml:54` | 答复撰写规范：同一引文以一处完整引用为限，其后以引文位置指代（"见前述引文"），不复述原文 |
| `packages/patent/patent-rule/assets/rules/patent/oa-response-form.yaml:126` | 答复撰写规范：答复须逐条回应通知书指出的驳回理由 |
| `packages/patent/patent-rule/assets/rules/patent/oa-response-form.yaml:138` | 答复撰写规范：引用通知书未提出的驳回条款须说明来源，避免自造理由 |
| `packages/patent/patent-rule/assets/rules/patent/oa-response-form.yaml:156` | 答复撰写规范：无内容的小节整节删除，成品不保留空标题 |
| `packages/patent/patent-rule/assets/rules/patent/oa-response-form.yaml:179` | 答复撰写规范：一个结论只写一处，其余以引述位置指代 |
