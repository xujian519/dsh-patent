# 法律模式 preset

[English](legal.md) | 中文

`legal` agent preset 在 DeepSeek Harness 上组合一个面向个人中国法律实务的 Agent。本 bundle 在 `presets/legal.patch.yml` 中声明它，内容随附在 `skills/legal/` 下。

## 挂载内容

除标准工作行（shell、文件、jobs、提醒、skills、goal 命令与工具、计划模式、压缩、委托、web，以及告诉模型今天日期的时钟行）外，本 preset 另挂载两个交付行：`@deepseek-ai/dsh-doc-template` 按受审模板渲染 Markdown/DOCX/PDF，并通过 `templateDirs` 加载当事人诉讼文书模板；`@deepseek-ai/dsh-document-deliver` 登记交付件并运行确定性文档检查。人设补上法律身份、引用纪律与交付门禁。

`tool-web` 配置为 `search: false`、`fetch: true`。宿主机安装了元典官方插件时，检索优先走 `mcp__yuandian__*`；未安装时走 ego lite：模型在 `tool-bash` 中运行 `ego-browser nodejs`，按 `legal-research` 技能操作，因此搜索摘要不能代替已打开的原文。`web_fetch` 只在浏览器不可用时作为公开静态页面的兜底。本预设自身不声明法律 MCP；元典是宿主插件，没有安装它的 profile 仍使用 keyless 浏览器路径。

## 元典 MCP（可选）

把官方 `huayu-yuandian-legal-data` 插件安装到同一 profile，作为部署步骤。它的工具注册为 `mcp__yuandian__*`（0.1.6 提供 48 个：法规、案例、企业与证券合规），四个官方技能也会进入目录。API Key 通过插件设置页或 Harness 凭据库的 `YUANDIAN_API_KEY` 保存；不要写进本 bundle 或 patch 文件。元典结果是发现与交叉核验材料：人设与 `legal-research` 仍要求引用前回到官方原文。

## 状态布局

所有可写路径都在会话工作区内，因此每次写入都落在 `workspace-write` 沙箱允许的范围内：

- `./.legal/company-profile.md` — 个人/执业层面的共享事实。
- `./.legal/practice/<domain>.md` — 十三个领域的实务画像。
- `./.legal/references/` — 共享参考与领域法条基线。
- `./.legal/research/evidence.jsonl` — 检索证据。
- `./matters/<slug>/` — 案件工作区：`matter.md`、`input/`、`work/`、`output/`、`research/`、`audit/matter-log.md`。

请把法律工作根目录（例如 `~/legal-workspace`）作为会话工作区打开。`legal-setup` 只补缺失模板，不覆盖已编辑的画像。

## 技能

十三个导入的领域库（124 个技能）加一个手写在 `skills/legal/handwritten/` 下的当事人诉讼文书技能，共 125 个领域技能；统一命名空间，扁平目录也不会重名：

| 前缀 | 技能数 | 覆盖 |
|------|--------|------|
| `legal-ai-*` | 9 | AI 清单、政策监测、用例分级、AIA 生成、供应商 AI 审查 |
| `legal-commercial-*` | 11 | 保密协议、供应商协议、SaaS/MSA、建设工程审查、续约跟踪、上报路由 |
| `legal-corporate-*` | 13 | 尽调、董事会纪要、书面决议、交割清单、表格化审阅 |
| `legal-criminal-*` | 6 | 案件分析、辩护策略、取保申请、合规不起诉 |
| `legal-employment-*` | 19 | 录用审查、解除审查、用工分类、工时工资、内部调查、休假 |
| `legal-ip-*` | 11 | 检索、FTO、组合管理、OSS 审查、下架、停止侵权函、发明 intake |
| `legal-practice-*` | 4 | 咨询分析、投诉分流、服务方案 |
| `legal-research-*` | 5 | 法源核验、类案比较、争点备忘录、讲座来源包 |
| `legal-litigation-*` | 20 | 接案、时间线、要件表、律师函、证据保全、庭审提纲、最高法当事人文书样式 |
| `legal-privacy-*` | 8 | PIA、DSAR、DPA 审查、政策监测、监管差距分析 |
| `legal-procurement-*` | 5 | 投标审查、质疑投诉、合同履行、制度分流 |
| `legal-product-*` | 6 | 上线审查、宣传合规、功能风险、问题分流 |
| `legal-regulatory-*` | 8 | 动态监测、政策比对、差距提示、意见、重写 |

五个手写模式技能：

- `legal-setup` — 初始化工作区布局。
- `legal-matter` — 新建、列出、切换与关闭案件。
- `legal-research` — ego lite 检索与证据记录。
- `legal-citation-check` — 核验法条、司法解释与案例。
- `legal-quality-gate` — P0/P1 交付门禁与免责声明。

### 当事人诉讼文书样式

`legal-litigation-party-document-templates` 收录最高人民法院官网“当事人参考民事诉讼文书样式”的 32 个末级类目、105 份样式（官网“非诉程序”为分组节点；官网发布 2016-09-28，抓取于 2026-10-26），每份保留官方正文与【说明】。技能按诉讼阶段与主体类型选型，要求保留官方结构，并明确提示：样式中的《民事诉讼法》条号是发布时文本，进入交付件前必须按现行法核验。12 个专用 doc-template 覆盖起诉状、答辩状、上诉状、再审、执行、保全、管辖异议、回避、授权委托书与法定代表人身份证明，另有 1 个通用模板承接其余样式。法院提交文书的正文不附 AI 免责声明；声明、AI 使用说明与待核验事项放在交付摘要或内部复核备忘录。

隐私与产品的参考基线包含美国/欧盟比较法监测，文件顶部以“法域提示”标明。中国法隐私规则见 `pipil-core-provisions.md`，监管动态技能正文使用中国监管机构清单。

## 有意省略

`tool-plugin-market`、`present`、`tool-plugin-manager` 不挂载：这是个人组合，安装或编辑插件通过 `dsh plugin` CLI 完成。源仓库的定时 agent 与 cookbook 本阶段不移植，因为它们依赖 Slack、邮件与商用 MCP。对应的人工技能仍然可用，`tool-schedule` 可以建立提醒；watcher agent 本身没有运行载体。源仓库的 `law-student`、`legal-clinic`、`legal-builder-hub` 三个领域也不导入：它们分别面向法学教育、带美国法域参数的诊所教学管理、插件安装与自更新，不属于个人中国法律实务。

## 交付格式限制

`render_doc_template` 生成干净的 Markdown、DOCX 与 PDF。交付文件传 `output_path`，由工具写盘并回报路径与字节数，不再返回文档正文；`docx` 必须传。DOCX 路径不保留修订痕迹、批注、脚注与文内图片。案件需要这些内容时，交付干净副本，另附一份列明每处修改、批注与引用的复核备忘录；不要把它描述成红线稿。

## 评测状态

当前证据是 keyless 组合测试与预设门禁：它们证明技能和工具如何挂载、人设是否包含引用与门禁规则，不衡量法律输出质量。尚未做真实案例评分。用于实际案件前，至少完整跑三个案件，由第二位律师按 P0/P1 门禁逐项评分，并把评分结果与案件审计日志放在一起。

## 来源与许可证

导入内容来自 [claude-for-legal-ZH](https://github.com/CSlawyer1985/claude-for-legal-ZH) 1.1.0，版权人为陈石律师 / CSlawyer1985，采用 Apache License 2.0。`skills/legal/LICENSE` 与 `skills/legal/NOTICE` 保存许可证与署名，`skills/legal/SOURCES.md` 记录源版本与提交号。修改内容列在 NOTICE 中：技能命名空间、路径与命令重写、产品名归一、单一案件指针、ego lite 检索，以及比较法标注。外围 bundle 仍为 MIT。

`legal-litigation-party-document-templates` 的当事人文书样式转录自最高人民法院官网（2016-09-28 发布，2026-10-26 抓取）。这些是国家机关公文，作为格式参考收录，不属于上述 Apache 许可语料；来源与抓取记录见 `skills/legal/SOURCES.md`。

## Windows

模式技能包含工作区初始化与案件管理的 PowerShell 等价命令；`legal-research` 记录了 Windows 下 `ego-browser` 使用 `%TEMP%` 请求路径的写法。

## 前置条件

- `ego-browser` 在 `PATH` 中；每个安装版本运行一次 `ego-browser skill`。
- 一个由用户掌控的会话工作区；画像仍含 `[PLACEHOLDER]` 时，先跑对应的 `legal-<领域>-cold-start-interview`。
- 模型需要 DeepSeek API key。会话为个人使用，日志上传与遥测按需开启。
- 可选：安装元典官方插件并保存 `YUANDIAN_API_KEY` 凭据以启用 MCP 检索；未安装时仍走 ego lite。
