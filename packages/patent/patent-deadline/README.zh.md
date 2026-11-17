---
description: "函数插件，计算一件中国专利案件的法定与指定期限：专利法实施细则的期限计算与送达规则（期限自发文日起算）、随包分发的国务院节假日安排（用于届满日顺延），以及 patent_deadlines 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-deadline

[English](README.md) | 中文

## 概述

函数插件，计算一件中国专利案件的法定与指定期限：专利法实施细则的期限计算与送达规则（期限自发文日起算）、随包分发的国务院节假日安排（用于届满日顺延），以及 patent_deadlines 工具。

## 目录

- [patent_deadlines 工具](#patent_deadlines-tool)
- [期限与送达计算（库 API）](#period-and-delivery-arithmetic-library-api)
- [工作日历资产](#work-calendar-asset)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="patent_deadlines-tool"></a>
## patent_deadlines 工具

patent_deadlines 依据专利类型、申请日、是否主张优先权、已收到的通知，以及各自起算一段期限的案件日期（授权公告日、新药上市许可日、提出无效宣告请求之日），报告一件案件的期限集合。每一项都带有报告用届满日、期限自身届满日、剩余天数、状态，及其依据的法条。

有两项输入刻意不靠推断。**是否主张优先权**由代理人或处理该案的人显式给出：它决定实审请求期限自优先权日起算（实务所用的起算口径）还是自申请日起算，因此半填的案卷不得让它静默改变——只给优先权日而不声明主张、或声明主张而不给日期，调用一律失败。**顺延口径**在法定口径与不顺延口径之间选择；两种口径下都会同时返回两个日期。

由通知起算的期限——授权通知起算的办理登记手续与分案申请、驳回决定起算的复审请求，以及送达文件起算的审查意见答复、复审通知书答复、无效宣告答复——以「待补」项返回，并点名尚缺的那份通知送达记录。本工具不以申请日起算的固定年数替代这些期限。已记录通知但送达字段不全的（例如电子送达既无发文日也无进入日），同样以点名缺失字段的「待补」项返回，而不是让整次查询失败。年费按授权当年的专利年度编号，故同样等待授权公告日；年费止于专利权期限的最后一年，`paidThroughYear` 可略过已记录缴费的年度。每项年费都带有六个月补缴窗口：窗口自该项报告用（已顺延）届满日起算，六个月后届满，窗口终点按同一口径顺延；终点年份无已载入安排时携带 `calendarCaveat`。

指定期限按程序区分：发明专利实质审查中的第一次审查意见答复默认为4个月，实用新型或外观设计初步审查中为2个月；通知可记录 `stage`（`substantive` 或 `preliminary`）覆盖该默认值——发明专利也可能在进入实质审查前收到初步审查意见，而实质审查阶段只适用于发明专利。复审通知书答复默认1个月。通知可记录 `designatedMonths`，只有审查意见、复审通知书与无效宣告转送文件这几类接受该字段：进入实质审查阶段通知书（3个月）、驳回决定（3个月）与授权通知（2个月）起算的是法定期间，在这几类通知上给出指定期限会让查询失败并点名对应法条。PCT 费用分为两段不同期限：申请费、公布印刷费及必要的附加费属进入手续费用，应在自优先权日起30个月的进入期限内缴纳（缴纳宽限费后可延至32个月）；优先权要求费自记录的进入中国国家阶段之日起2个月，未记录进入日时保持「待补」。期限补偿与新药补偿仅适用于发明专利，优先权恢复与增加/改正仅适用于发明或实用新型，PCT 进入中国国家阶段不适用于外观设计；查询断言相反情形时直接失败，而不是静默丢弃该项。2021-06-01 前申请的外观设计适用修改前专利法第42条的10年期限，该日及以后申请的为15年。

<a id="period-and-delivery-arithmetic-library-api"></a>
## 期限与送达计算（库 API）

包重新导出移植的规则供直接调用方使用：

- `periodEnd(start, period)` —— 专利法实施细则第5条：期限开始的当日不计算在期限内；以年或月计算的，以其最后一月的相应日为届满日；该月无相应日的，以该月最后一日为届满日。`1999-12-31` 加两个月为 `2000-02-29`。
- `resolveDeliveryMode(request)` —— 未指定送达方式时按电子送达处理。
- `resolveDeliveryDate(request)` —— 依 2023 年修订的专利法实施细则第4条与 2023 版专利审查指南：指定期限与部分法定期限自送达日起算；电子送达的送达日为进入当事人认可电子系统之日，无更晚证据时以发文日推定，因之期限自发文日起算且不再加 15 日。邮寄送达以当事人举证的实际收到日为准，否则为自发出之日起满15日；直接送交以交付日为准；公告送达自公告之日起满1个月。
- `WorkCalendar.rollForward(date)` —— 届满日为法定休假日或移用周休息日的，顺延至其后第一个工作日。
- `evaluateDeadlines(query, options)` —— 组装完整期限集合，按所请求的顺延口径计算，并以显式传入的 `today` 计算每一项的期限状态。
- `renderDeadlineReport(report, meta)` —— 工具返回的 Markdown。

除工作日历加载函数外，以上均为无需密钥的纯函数。

<a id="work-calendar-asset"></a>
## 工作日历资产

`assets/work-calendar/cn-holidays.yaml` 抄录国务院的节假日安排，同时记录放假日与调休上班的周休息日，并为每年标注其出处文号。随包文件覆盖 2025 年（国办发明电〔2024〕12号）与 2026 年（国办发明电〔2025〕7号）；新年度的安排公布后再追加。

未载入某年度安排时不得假定该日为工作日：该项保留未顺延的届满日，并携带 `calendarCaveat` 指明未覆盖年份，使报告不会给出一个从未核验过的顺延结果。不顺延口径完全不查询日历。

<a id="configuration"></a>
## 配置

Schemastery 配置，全部字段可选。

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| calendarDir | string | 随包资产 | 存放 `cn-holidays.yaml` 的目录，须镜像随包布局。文件缺失或非法将使插件加载失败。 |
| reminderLeadDays | number | 30 | 非负整数。届满日剩余天数不超过该值时标记为紧急。属事务所策略，非法定期限。 |
| annuityHorizonYears | number | 2 | 自报告日起报告的未来年费年度数。属策略选择，并受专利权期限封顶。 |
| timeZone | string | Asia/Shanghai | 读取“当前日期”所用的 IANA 时区。无效时区使插件加载失败。 |
| provideService | boolean | false | 发布 `patentDeadline` 服务（见下）。默认关，使 agent preset 的挂载保持“只有工具”。 |
| exposeTool | boolean | true | 注册 `patent_deadlines` 工具。根域的“只提供服务”挂载把它设为 false，从而不新增第二个面向模型的工具。 |

两种挂载角色至少要启用一种：`provideService` 与 `exposeTool` 同时为 false 时插件加载失败。“只提供服务”的挂载不要求 tools 服务。

<a id="patentdeadline-service"></a>
## `patentDeadline` 服务（根域挂载）

挂在 agent preset 里的插件只能写入该 preset 隔离域的工具注册表，因此 profile 根域的同级插件——例如专利工作台的期限看板——无法经工具注册表拿到求值器。需要该访问的部署把本包**在 profile 根域再注册一次**，配置 `provideService: true` 与 `exposeTool: false`：

```yaml
- id: patent-deadline-service
  name: '@deepseek-ai/dsh-patent-deadline'
  config: { provideService: true, exposeTool: false }
```

这一行把求值器发布为根域的 `patentDeadline` 服务，且不新增第二个面向模型的工具；预设那一行保持默认的 `exposeTool: true` 供 agent 使用。同一个包注册两行是安全的——只有重复的 loader entry **id** 才是致命错误，而两行持不同 id。

该服务是对纯函数的直通，因此期间、送达或顺延规则都不复述：

- `evaluate(query, options?)` —— 与 `evaluateDeadlines` 相同的 `DeadlineQuery`/`DeadlineReport`，`query.today` 由调用方给定以保证报告可复现；`options.reminderLeadDays` 为本次调用覆盖内置阈值。
- `periodEnd(start, period)`、`resolveDeliveryDate(request)`、`describePatentKind(kind)` —— 即上文的库函数。
- `calendarCoverage()` —— `{ years }`，即所载安排覆盖的年份。消费者据此说明某个届满日的年份未经核实，而不是显示一个从未核验过的顺延。

日期以 `{ year, month, day }` 对象跨边界，消费者因此不必再解析一次日历。消费者**软探测**该服务（`ctx.get('patentDeadline')`）而不注入它，因此部署未接线时它照常加载。

<a id="model-experience"></a>
## 模型体验

### patent_deadlines 工具

#### 模型所见

一个名为 `patent_deadlines` 的已注册工具，必填 `patentType` 枚举（`invention`、`utility-model`、`design`）、`filingDate` 与 `claimsPriority`，可选 `priorityDate`、`isPctNationalPhase`、`nationalPhaseEntryDate`、`authorizationPublicationDate`、`marketingApprovalDate`、`termCompensationYears`、`invalidationRequestDate`、`paidThroughYear`、`restDayRule` 与 `notices`（每项含文件种类、送达方式（默认电子送达）、对应的送达日期、可选的指定期限月数，第一次审查意见通知书还可选 `stage`）。一个案子里可能收到多份的通知种类（`office-action-subsequent`、`reexamination-notice`）可重复传入，每份各产一行——第一份用原 id，其后为 `<id>-2`、`<id>-3`；其余种类一个案子只有一份，重复传入按工具错误返回，不再静默覆盖。无效程序增加理由或补充证据的期限（细则第71条）自 `invalidationRequestDate` 起算，案卷未记录该日期时以点名该输入的待补项返回。结果渲染为 Markdown 表格，列出可计算期限的报告用届满日与期限自身届满日、剩余天数、状态与法律依据，其后依次为各项通知期限的起算依据、点名缺失通知送达记录的待补项、未覆盖年份的日历警告，以及逾期后适用的恢复与延长规则。`claimsPriority` 与 `priorityDate` 相互矛盾时，以点名两个字段的工具错误返回。

#### Token 影响

工具启用期间每次请求承担固定定义成本；每次结果为一张短表加一份待补清单，仅在压缩前重复占用上下文。

#### KV Cache 影响

仅追加；新可见的结果文本位于可复用的请求前缀之后，不使既有 KV 缓存条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **节假日日历仅覆盖 2025—2026 年** —— 超出该范围的届满日以未顺延形式返回并带 `calendarCaveat`。在依赖远期届满日之前，请扩充随包资产或将 `calendarDir` 指向自备日历。不顺延口径（`restDayRule: 'omit'`）不受影响。
- **不顺延口径用于记录期限，不用于行动** —— 它只报期限自身届满日，适用于以期限本身为对象的记录；答复、缴费、递交类期限仍用法定顺延口径。
- **授权当年年费年度由授权公告日推导** —— 各项年费假定「授权公告日所在的专利年度即为授权当年」这一通常情形；在首个年费年度之前授权的案件未建模。
- **已缴年费需用 `paidThroughYear` 排除** —— 未提供该输入时，报告范围内的全部年费都会列出，包括案卷可能已记录缴费的历史年度；该输入略过截至所给年度（含该年）的全部年费。
- **恢复与延长为提示而非期限行** —— 专利法实施细则第6条的恢复期限与审查指南的两个月延长，在存在可恢复的逾期项时写入报告文字，但不作为独立期限行计算，因其起算自本工具未纳入的权利丧失通知。报告同时写明专利权期限与优先权期限不适用恢复（细则第6条第5款）。延长文字点名例外：无效宣告请求审查程序中指定的期限不得延长（细则第75条）。
- **当前日期不是工具入参** —— 它按 `timeZone`（默认 Asia/Shanghai）读取宿主时钟，基准日因此遵循专利局的日历；模型无法以虚构的日期出具报告。
- **不计算期限补偿长度** —— 报告专利法第42条第2款、第3款请求期限；已获准的补偿年数通过 `termCompensationYears` 传入，实施细则第78条、第82条的计算不在范围内。
- **优先权是声明而非推导** —— 工具写明其采用的起算日，但不判断优先权主张本身是否有效、是否在期限内；那是案卷的问题。
- **不与案件档案集成** —— 通知逐次传入；本包不读写任何案件文件。

### 开发备注

无。

本包不发布 invariant 伴生组件：本包不持有持久状态与事件，每个导出都是针对显式查询的纯函数，唯一读取的资产在插件加载时 fail-loud 校验。
