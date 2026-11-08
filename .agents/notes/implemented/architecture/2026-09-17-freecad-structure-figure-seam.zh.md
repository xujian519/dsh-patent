# Agent Note: FreeCAD 结构线稿接缝与 TechDraw 投影决策

Status: implemented

[English](2026-09-17-freecad-structure-figure-seam.md) | 中文

## Problem

`generate_patent_figure` 画的是 Graphviz 图：流程图、框图、部件层级图。它画不出几何已经以 CAD 模型（STEP/IGES/BREP）存在的机械结构。把这种附图伪装成框图会丢掉《专利审查指南》第一部分第一章 4.3 下结构线稿的意义，而手工重画模型已经携带的几何则复制了真相。宿主可能装有 FreeCAD；harness 在其缺失时绝不能静默降级，且重量级 CAD 依赖绝不能渗进默认工具面。

## Decision

在 `@deepseek-ai/dsh-patent-tools` 内交付独立工具 `generate_structure_figure`，与 `generate_patent_figure` 平行，经宿主 `freecadcmd`（FreeCAD 1.1，TechDraw）把 CAD 模型投影为黑白多视图 SVG。下面每条决策都先在 macOS 上对 FreeCAD 1.1.3 做过实机验证再落笔。

**能力接缝。**服务定义是渲染结果契约 `StructureRenderOutcome`（`{ ok: true, manifestPath }` 或 `{ ok: false, code: 'not_installed' | 'render_failed' | 'aborted', error }`），刻意与 `GraphvizRenderOutcome` 同形，让工具层用同一套结果映射代码处理两个渲染器。Provider 是 `src/figure/freecad-renderer.ts`（路径发现、probe、子进程 spawn）；Consumer 是 `src/tool/generate-structure-figure.ts`，只依赖注入的 `render` 函数，自身绝不触碰 `ctx.subprocess`。Python 脚本是纯函数（`src/figure/freecad-structure-script.ts` 的 `buildStructureScript`），脚本构建可在无 FreeCAD 环境下单测；渲染器把脚本写入输出目录后 spawn `freecadcmd <script.py>`。脚本以内嵌源码而非随包 asset 交付，因为包的 `files` 只 ship `lib/index.js` 加类型声明。

**CAD 隔离、默认关闭、fail-loud。**工具由 `Config.structureFigureEnabled` 门禁（默认 `false`）。门禁未开启、`subprocess` 服务缺失或 `freecadcmd` 缺失都在执行期以 `setup_required` 加安装引导报错——绝不回退成示意图。子进程的 HOME/XDG/临时目录重定向到输出目录内的 `.freecad-home` 子目录以圈住副作用。

**Page + 最小模板，每视图一个 `DrawViewPart`。**TechDraw 只投影归属于带模板 `DrawPage` 的视图，故脚本自带一个最小空白 SVG 模板（一个不可见页面矩形）并把 `doc.TransientDir` 锚定到输出目录下的子目录——TechDraw 以该属性为基准拷贝模板，而 FreeCAD 在自身缓存目录不可写时（任何拒绝写 `~/Library/Caches/FreeCAD` 的沙箱）不派生它，该拷贝随之解析到 `/` 而失败；`doc.FileName` 不参与该拷贝。每个请求视图是单个带显式 `Direction`/`XDirection` 的 `TechDraw::DrawViewPart`；`DrawProjGroup.addProjection(str)` 在 1.1.3 抛 `TypeError: wrong type`，弃用。旧 `Drawing` 工作台在 FreeCAD 1.1 已移除，不用。

**输出取 `viewPartAsSvg` 原始片段，而非渲染整页。**`TechDraw.viewPartAsSvg(view)` 返回纯 `<g fill="none" stroke="#000000">` 几何片段，不含模板边框、标题栏或图号——正是 4.3 的要求——故脚本把片段包成独立 `<svg viewBox=…>` 而不导出页面。片段本身已是 y 向下的画布帧（实测：它按投影紧致几何居中，y 向下），故原样进画布、不做翻转；按「片段 y 向上」的假设套 `<g transform="scale(1,-1)">` 会把图上下镜像。

**件号在 Python 侧经 `projectPoint` 锚定。**`DrawViewPart.projectPoint(App.Vector)` 与片段共享同一坐标帧（实测：两者都产出形如 `M -10 2.5` 的坐标），故脚本把每个件号的 3D 点投影、减去帧中心、翻转 y，在那里画引线与数字。在 Python 侧锚定让件号落在真实投影顶点上；在 TypeScript 侧做则要在外部重新推导 TechDraw 的投影。帧中心 C 是**紧致投影几何包围盒**的中心，经离散化每条边（`discretize(Number=32)`）逐点投影取样求得：TechDraw 按投影后的几何居中片段，旋转视图（iso）下 C *不是*模型 AABB 中心的投影——用 AABB 投影会可见地放错件号。

**件号的 `point3d` 可省略，省略时由脚本选顶点。**只给 `{numeral, model}` 时，脚本取该零件**自身投影轮廓中心最远**的那个真实顶点。最远顶点必在轮廓外缘，引线因此从实体向外延伸而不会落进图面内部——这正是模型手填坐标最常犯的错，因为模型看不见 STEP 内部。同一零件上有多个自动件号时按该排名轮转，不会全部叠在同一个顶点。选点只跑一次、且在首个视图上；其余视图投影同一个 3D 点，故一个件号在整套图里指向同一物理位置。手填的 `point3d` 仍在任何投影之前过 0.5 毫米的 `distToShape` 归属核验；自动锚点不需要这一步，因为它本就取自该零件自己的顶点。

**`exploded` 切成逐件消隐并沿装配轴排布。**每个零件一个 `DrawViewPart`、`Source` 只挂它自己，故消隐逐件进行、零件之间不再互相遮挡——这与总装路径（全部零件共用一个 `Source`、一次消隐）正好相反。轴取各零件 `BoundBox.Center` 点云的第一主成分（幂迭代）；`Part.Shape` 没有 `CenterOfMass`（实测 `AttributeError`），而包围盒中心在沿轴排序上等效。目标位置按各零件自身沿轴尺寸加「1.2 × 中位尺寸」的间隙逐段累加，整串再移回原点居中——只用 `rank × gap` 会假设没有零件比间隙还宽，大件仍会互相压叠。视线与轴的投影长度不足 0.2 毫米时渲染当场失败，而不是把所有零件叠在一个点上。

**版面利用率按图自身画布计算，且只作提示。**渲染复核用内容包围盒面积比该图自己的画布面积，`Config.figureMinSheetFillRatio` 给出下限时低于它报 `sheet-underfill`。该发现带 `advisory: true`，`blockingFindings` 会把它滤掉：图稀疏不等于画错，`figureFailOnRenderFindings` 不能把一个软比例变成渲染失败。分母永远是这张图自己的画布——落版好的 A4 页与从授权 PDF 裁出的附图页画布不同，跨两者比这个比值对哪边都不说明问题，所以它从不与参考图对比。下限默认关闭：紧致片段的画布本就贴着内容（比值接近 1，没有信号量）；把图落版到 A4 的部署可以打开它，先看分布再决定是否信任。

**逐零件投影占位与视图包围盒在同一次取样里量出。**`projected_bounds` 每条边只离散化一次，同时累积紧致视图包围盒与逐零件包围盒；`part_metadata` 把每零件的 3D 包围盒、体积与该视图下的投影占位写进 manifest，工具再以 `assembly` 摘要给出同一份事实。两者都是画布帧坐标、与件号锚点同帧，该朝向看不见的零件记 `null`。合并后的单一视图框回答不了引线布局的问题——标号或引线会不会落到**别的零件**上——故逐零件占位在投影过程里量出，而不是事后从 SVG 反推：TechDraw 把所有零件画进同一个 `<g>`，事后无法恢复零件归属。

**成功判定只看退出码加 manifest 存在。**`freecadcmd` 对 `~/Library/Preferences/FreeCAD` 与缓存写失败仅告警、非致命（STEP 载入/投影/导出均成功），且 macOS 下这些路径不随重定向的 HOME 迁移——其无害仅因为脚本把 `TransientDir` 自身锚定进输出目录，`TransientDir` 为空对模板拷贝是致命的。反过来，`freecadcmd` 吞掉未捕获的 Python 异常并以退出码 0 结束，故脚本包裹 `main()`，失败时 `traceback.print_exc()` + `sys.exit(1)`；没有这层包裹，失败的投影会看起来像成功。因此 stderr 文本绝不作为失败依据，只摘引进错误消息。

**工具层复用附图不变量。**输出 SVG 经与 Graphviz 路径同一的 `assertSafeSvg` 门禁，件号名称/标号经 `figureWordingWarnings`，每张图以 `analysis.figureType='structure'`、`modelUsed='freecad-structure'` 持久化进 `figureIndexStore`。`model_path` 为目录时按排序渲染每个受支持模型、图号递增，各自渲染进独立的 `fig{N}/` 子目录，批内 manifest/脚本/模板/home 文件互不冲突；目录形式与 `callouts` 同用会被 `invalid_tool_input` 拒绝——件号 `point3d` 是单个模型的坐标，把同一 3D 锚点投影到其余模型会落到几何之外。组件列表只从 `callouts` 派生一次（不跨图累加），故每个逐图索引条目携带相同的件号组件而不重复。

## Alternatives considered

- **给 `generate_patent_figure` 扩一个 `structure` 附图类型。**拒绝：两边输入 schema 几乎无交集（面向 DOT 的 steps/nodes vs 模型路径/视图/件号），门禁不同（CAD 默认关闭 vs 恒开），一个工具带两个不相交模式会拖累双方描述。两个工具让各自 schema 诚实。
- **用 `DrawProjGroup.addProjection`** 生成标准视图组。拒绝：在 FreeCAD 1.1.3 抛 `TypeError: wrong type`（实机验证）；带显式朝向的单个 `DrawViewPart` 稳定。
- **把渲染后的 `DrawPage` 导出为 SVG**（会带上模板）。拒绝：整页导出携带模板几何与页面装饰；专利附图像素内既不能有边框也不能有图号。
- **把 Python 脚本作为包 asset 交付。**拒绝：`files` 只 ship `lib/index.js` 加类型；asset 需要打包与运行期路径解析。返回源码文本的纯构建函数无 FreeCAD 也可测，且不动打包。
- **以 stderr 干净与否判定成功。**拒绝：FreeCAD 在健康运行里也会输出 `system.cfg`/transcoder 告警；把它们当致命会让某些宿主上每次渲染都失败。
- **用独立的分析工具产出锚点。**拒绝：一次 FreeCAD 渲染的缺省超时是 120 秒、冷启动比 `dot` 慢，为一个模型图纯粹再起一次 `freecadcmd` 读几何会让成本大致翻倍；而这些事实在已经逐边离散化的投影过程里是免费得到的。
- **把自动锚点放在零件 3D 包围盒的角点。**拒绝：角点未必落在实体上，锚点要么被归属核验拒绝，要么让引线指向空白；真实顶点按定义就在几何上。
- **用总装图那一次全局消隐画出分解图，事后把零件平移开。**拒绝：那次消隐已经处理了零件**之间**的遮挡，被邻居挡住的轮廓在片段里本就不存在，平移不可能把它们找回来。分解图需要的是从一开始就没有邻居参与消隐的轮廓。
- **把整体包围盒的最长边当作装配轴。**拒绝：那是箱体自身的方向，不是零件的分布方向；一块宽而薄的支架沿厚度叠零件时会被沿错误的轴分解。
- **把版面利用率与参考图或金样对比。**拒绝：两边的画布来自不同的裁剪——生成图落在纸面上，参考图从授权附图页裁出来——同一个比值在两侧含义不同。本仓早前的一次跨图比对得出过「生成图只用了 57% 幅面」的结论，那正是分母不同造成的假象。
- **引线几何（与 `src/figure/leader-line.ts` 同批交付）：以节点 bbox 中位尺寸推导图面 scale。**实现期拒绝，改为以各节点组**实读 `font-size`** 的中位数相对基线 10 推导：几何常量（间隙、边距、文本行高）本就是按字号调校的，统一字宽模型已逐组实读 font-size，而 bbox 中位数会把标签长度混进图面 scale。

## Consequences

- 新增 Config 面：`freecadExecutable`、`structureFigureEnabled`、`structureFigureScale`、`structureFigureViews`；发现顺序与 Graphviz 同构（覆盖值 → `DSH_FREECAD_CMD` → 平台候选路径 → `PATH`）。`structureFigureViews` 为受支持视图名的 `z.union`，未知配置值在配置加载时即被拒绝，而不会在之后表现为误导性的 `invalid_tool_input`。
- 模型传入的 `scale`（有限且 > 0）与 `figure_number`（正整数）在工具层于渲染前校验：工具输入 schema 只约束其类型，未校验的值会让 FreeCAD 产出退化的 `width="0mm"` SVG 或不透明的投影失败。
- `index.ts` 带一处 TypeScript 解析器缺陷的绕行：返回对象字面量的 `async` 箭头直接作三元分支、且整条赋值给以索引访问类型（`GenerateStructureFigureDeps['render']`）标注的 const 时会误解析（TS1359）；该分支被提升为具名常量 `structureNoSubprocess`。
- 工具数断言（`registration.spec.ts`、双语 README）从 27 → 28。
- `RenderCheckFinding` 增加 `advisory` 标记。除 `not-measured` 与提示级发现外，其余在 `figureFailOnRenderFindings` 下阻断交付；这个标记的用途是让软指标进入警告、却永不导致渲染失败。
- 件号放置跑在 Python 脚本里，按候选网格展开：绕首选外向方向每 30° 共十二个方向，乘三档距离，取第一个「标号框既不压别的零件投影占位、也不压已放标号」的候选。首选方向取自**所属零件**的投影中心而非画布中心——零件位于图面中央时，画布中心方向是任意的，会把标号丢进图形内部。候选全部耗尽时退回首选方向的最近档，并在该视图的 manifest 记录一条警告，标号不会被静默丢弃。判定只看零件占位与已放标号，不检查图线本身的穿越与引线交叉；放置数学也没有与 `leader-line.ts` 的 TypeScript 原语共享。

## Testing

- `tests/figure-freecad-structure-script.spec.ts` —— 对构建出的脚本做纯函数断言（API 使用、视图表、`TransientDir` 锚定、payload 往返），无需 FreeCAD。
- `tests/figure-freecad-renderer.spec.ts` —— mock `SubprocessRuntime`：发现顺序、probe、退出码分类、env 隔离、超时、取消。
- `tests/structure-figure-tool.spec.ts` —— mock render：门禁、单模型/批量、图面用语告警、safe-SVG 门禁、索引持久化及其降级路径。
- `tests/figure-render-check.spec.ts` 与 `tests/render-check-gate.spec.ts` —— 版面利用率下限在低于阈值时报、达标或不设时不报，且被 `blockingFindings` 滤掉，故 strict 门禁仍放行一张稀疏但干净的图。
- `tests/figure-freecad-real-render.spec.ts` —— `describe.skipIf(!hasFreeCad)` 真实端到端，跑签入的 `tests/fixtures/structure-bracket.step`（由签入的 `generate-structure-fixture.py` 生成；一条恒开测试断言 fixture 的 ISO-10303-21 头部签名与该生成器一致）：iso+front 投影含 `<path>`、仅黑描边、无边框/图号，且两个件号锚点都落在各自视图 bbox 内；在拒绝写 FreeCAD 缓存目录的沙箱下，这条成功断言本身就是 `TransientDir` 的回归保护——否则该拷贝会解析到 `/`。同文件另有四条覆盖逐零件几何与放置：一条断言每零件的 manifest 占位都落在视图框内、且两个零件不会塌成同一个占位；一条在完全不给 `point3d` 的装配体上断言每个自动锚点落在其声明零件的 3D 包围盒内、且在各视图间逐值相同；一条断言装配体的两个标号在警告为空的前提下完成放置，并与图线保持可读净距；一条渲染分解图，断言两个零件的占位互不重叠、且每个锚点落在自己零件的占位内。

## Related

- [Capability seams](2026-06-13-capability-seams.zh.md) —— 本 note 沿用的接缝词汇（service definition / provider / consumer）。
- `src/figure/graphviz-renderer.ts` —— `freecad-renderer.ts` 镜像的契约（发现、probe、结果形状、SIGTERM→SIGKILL 宽限）。
