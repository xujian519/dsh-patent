/**
 * 附图渲染复核（纯函数，无 IO）：在**已生成的 SVG 源**上量测图面事实，报告只有
 * 看渲染结果才看得见的问题。
 *
 * 为什么量测矢量源而不是位图：矢量源是渲染的唯一输入，线段位置、线宽与字号都在
 * 其中；位图量测要引入栅格化器（rsvg/ImageMagick），而本包的两条渲染通路都不
 * 依赖它们。凡「画出来是什么样」取决于矢量源的地方，本模块都按同一条遍历量测。
 *
 * 覆盖五类只在渲染结果上显现的缺陷（前四类来自实测案例）：
 * - **文字被线条贯穿**：引线或轮廓线穿过文字占位框，标号或元件名读不出（引线的
 *   终点落在文字上、或标号落在被剖面线的零件内都会触发）。
 * - **文字与图线净距不足**：线条没压进字身、但贴着文字占位框（默认不足
 *   {@link DEFAULT_TEXT_CLEARANCE_MM}），标号与元件名周围没有可读的空白。判据把
 *   占位框外扩净距后再用同一「贯穿」判定；引线（绘图侧标注
 *   {@link ROLE_ATTRIBUTE}）与落在不透明填充内的线段不参与——前者本来就止于文字外框，
 *   后者在图面上不可见。同一语义分组（Graphviz 的 `<g class="node|edge">`）内的
 *   文字与线段也不参与：节点标签本就排在节点框内、边标签本就贴着自己的边，那是排版
 *   而非缺陷；跨组压线仍判。生成工具按图型取 {@link RENDER_CLEARANCE_MM} 的分档值。
 * - **点划线被实线覆盖**：同一行既有「长划+点」的点划段、又有一整段连续实线，
 *   点划线的间隔在图面上不可见（上下半剖的两半公共边正好落在轴线位置时如此）。
 * - **相邻零件剖面线难以区分**：两件轮廓相邻，剖面线的方向差不超过
 *   {@link ADJACENT_ORIENTATION_LIMIT_DEG} **且**间距比不超过
 *   {@link ADJACENT_SPACING_RATIO_LIMIT}，读成一个零件（GB/T 4457.5 要求相邻零件的
 *   剖面线方向相反或间距不等，两项有一项可区分即不报）。类别标识为
 *   `hatch-orientation-collision`，判据含方向与间距两项。
 * - **两个图元叠压**：两个闭合轮廓的包围盒部分相交（相交区两轴都不小于
 *   {@link OVERLAP_MIN_MM}，且任一方的包围盒不整体包含另一方），说明同一块图面被两个
 *   图元占用——或其中一个的位置/尺寸有误，或该处本不该有第二个图元。类别标识为
 *   `element-overlap`。有意嵌套（型腔内画零件、模块内画子模块）不算：那是包含而非部分
 *   相交；同一材料的几段轮廓（{@link HATCH_GROUP_ATTRIBUTE} 同号）也不算；两侧都是纯填充
 *   图元（无 `stroke`，如文字转路径后的字形轮廓）也不算——那不是两条画出来的轮廓线。
 * - **构造层级与权利要求不一致**：出图时声明的图内层级与权利要求写出的归属表述矛盾
 *   （权利要求说「31 的输入端 311」，而声明的层级把 311 挂在 3 之下）。类别标识为
 *   `figure-hierarchy`，判据见 `hierarchy-check.ts`；只在调用方给出声明层级与权利要求
 *   正文时产出，本模块自身不解析权利要求。
 * - **内容越出画布**：线段、轮廓或标号落在根元素声明的画布之外，越界部分不会被
 *   渲染出来（后处理放大字号或落版改写画布时最易发生）。
 * - **字高低于下限**：某处图面文字的字高小于调用方给出的内控下限（`minFontMm` 选项），
 *   缩小到三分之二后读不出。类别标识为 `font-below-minimum`；下限是本部署的内控口径，
 *   法条只要求「缩小到三分之二时仍能清晰地分辨」。同时给出量测值 `minFontMm`。
 *
 * 量测范围：根元素的画布尺寸与 `viewBox`/`preserveAspectRatio`（`svg-viewport` 解析成
 * 用户单位 → 毫米的映射，故 px 级用户单位的导出文件与落版页同一口径）；`line`/`polyline`/
 * `polygon`/`rect`/`circle`/`ellipse`/`path`（M/L/H/V/Z 与 C/S/Q/T/A，含相对形式；
 * 曲线按 0.05 毫米弦高折线化）的几何；`text` 的内容、
 * 字号与 `text-anchor`（含自 `<g>` 继承与行内 `style`；未声明字号按 CSS 初值 16 用户单位）；
 * 线段的取向与线宽；`stroke-dasharray` 只用于点划线判定（按虚线段展开）。元素按嵌套逐层
 * 继承 `transform`（translate/scale/rotate/matrix）与线宽/描边/字号，故落版页与拼版页的
 * 缩放、纵排文字都能换算到根坐标系量测。`defs`/`clipPath`/`marker` 等定义容器的子元素与
 * `display: none` 的子树不在图面上渲染，整段跳过。
 *
 * 不在量测范围内的结构各记一条 `not-measured` 发现（同一原因只记一条）：CSS 类样式
 * （`<style>`，含 `<defs>` 内的样式表）、`<use>`/`<image>` 引用、嵌套 `<svg>` 的内层视口、
 * 端头标记（`marker-*`）、`<tspan>` 的 x/y/dx/dy 偏移、`dominant-baseline`/
 * `alignment-baseline`、相对视口的百分比长度、无法解析的 `transform`/路径 `d`/`viewBox`；
 * 视口两轴缩放不等或 `slice` 裁剪时另记一条近似说明。
 * **报告里没有 `not-measured` 时，「未发现问题」才等于逐类量测过。**
 *
 * 判据与公开入口在 `render-check-findings.ts`；本模块只保留模块文档并再导出该入口。
 * 扫描与输入安全检查分别见 `render-check-scan.ts` 与 `svg-annotate.ts`。
 * @module @deepseek-ai/dsh-patent-tools/figure/render-check
 */

export {
  checkFigureRendering,
  measureInkBounds,
  clearanceMmForFigure,
  blockingFindings,
  RENDER_CLEARANCE_MM,
} from './render-check-findings.ts'
export type {
  InkBounds,
  RenderCheckFinding,
  RenderCheckKind,
  RenderCheckReport,
} from './render-check-findings.ts'
