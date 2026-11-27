---
description: "DSH Patent 的品牌占位实现：侧栏标志与产品名、空白会话 hero，无条件注册，使 fork 构建显示自有标志而非官方鲸鱼；供选择或替换品牌呈现的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-patent

[English](README.md) | 中文

## 概述

本包为 fork 构建提供自己的标志与产品名（侧栏），以及空白会话 hero 的标志。`BRAND_GUIDELINES.md` 允许项目以 `DSH` 缩写命名，但要求项目不要把官方素材呈现成似乎得到 DeepSeek 背书；一个自称 `DSH Patent` 却随附鲸鱼标志的 fork 正是这种情况。为拥有自身身份的部署选择本包。与 `dsh-client-ui-brand-official` 不同，本包在每一个构建 profile 上都注册，因为 fork 的 profile 从不是 `official`，而 profile 门禁会让官方 fallback 留在原位。它没有运行时状态，也不影响模型请求。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把本插件挂到拥有自身身份的部署的浏览器插件清单中。它占用 `sidebar.brand.mark`、`sidebar.brand.name` 与 `conversation.hero.brand.mark`，替换这三个插槽原本渲染的三个 fallback：侧栏的共享 `FishLogo`、本地构建产品名与 hero 的动画 `HeroFish`。

### 为什么不带 profile 门禁

`dsh-client-ui-brand-official` 在 `DSH_CLIENT_BUILD_PROFILE !== 'official'` 时直接返回。fork 以 `local` 构建，因此那个包不贡献任何内容，外壳回落到鲸鱼——这正是 `BRAND_GUIDELINES.md` 要求项目避免的安排。本包因此无条件注册。想要官方标志的构建改为装配官方包并排除本包；单占位插槽取装配实际加载的那一个。

### 标志

一对互锁的钩子：`harness` 的本义就是扣具。左半表达交付执行，右半表达验收归还，对应本产品的规则——智能体不能关闭任务，只有用户的验收才能。两条钩尖越过画布中线，两半因此读作一件东西的两部分，而不是两个括号。

`brand/assets/` 存放已安装图标的 SVG 源；本包为界面内表面绘制同一几何，因此两者必须一起改动。`scripts/verify-brand-assets.ts` 固化了该几何，若改动未同步固化片段即失败。

### 尺寸与描边

`strokeForSize()` 在 32px 以下返回 8、以上返回 6，对应图标生成器已依赖的 `mark.svg` / `mark-small.svg` 之分：16px 下标准描边会细到交叉的钩尖消失，标志塌成一个小菱形。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

浏览器半边是 [`src/client/index.ts`](src/client/index.ts)，它声明 `inject = ['slots']`——缺少该声明时运行时会拒绝激活该条目，整个 web 启动失败，所以它是承重的而非文档。每个占位实现都通过 `ctx.slots.inject()` 注册，因此它会等待声明方，并在该声明塌陷时一并撤销，HMR 期间不会留下半个品牌。组件在 [`src/client/occupants.tsx`](src/client/occupants.tsx)，几何在 [`src/client/Mark.tsx`](src/client/Mark.tsx)；node 半边是一个空的 Loader 座位。

右钩通过 `var(--dsw-alias-state-business-primary)` 上色而不是字面量，因此它跟随当前调色板（浅色 DeepSeek 500、深色 400），而不是钉死某一主题的值。

hero 占位实现有意不做动画。官方 hero 鱼在悬停时形变其轮廓；两个钩子没有等效形变能在 34px 下保住咬合语义，加动效会拿标志的含义去换运动。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌表面不够用时读这些页面。它们从本包占用的插槽走向渲染它们的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md) —— 声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并渲染其 fallback。
- [ui-conversation](../ui-conversation/README.zh.md) —— 在 hero 中声明 `conversation.hero.brand.mark`。
- [ui-brand-official](../ui-brand-official/README.zh.md) —— 本包所替换的、带 profile 门禁的官方占位实现。
- [Web 客户端架构](../../../docs/subsystems/web-client.zh.md) —— 浏览器插件行如何加载并注册插槽。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延后事项

<a id="known-limitations-and-deferred-work"></a>


这些限制界定本 fork 的品牌呈现如何提供。它们是当前的包约束，不是品牌设计比较，也不是任务清单。

- **只有一组占位实现** —— 替代呈现应属于另一个占用相同插槽的 Cordis 包。
- **hero 占位实现是静态的** —— 官方鱼所做的悬停形变未被复现，因为钩子的任何形变都无法在 34px 下保住咬合语义。
- **标志在两处维护** —— `brand/assets/` 下的 SVG 源与 `src/client/Mark.tsx` 中的路径常量描述同一几何，必须一起改动；资产门禁只固化 SVG 一侧。
- **品牌区不显示构建版本** —— 本占位实现与外壳 fallback 均不再渲染产品名旁的版本徽章；构建标识保留在打包元数据与诊断信息中。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

无。

</details>
