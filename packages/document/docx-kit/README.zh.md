---
description: "仅用 Node 标准库完成 Markdown 转 DOCX 与 DOCX 转纯文本：六级标题、段落、无序列表、表格，以及行内加粗与等宽；可恢复的解析失败以结构化问题返回。"
kind: "package-reference"
---

# @deepseek-ai/dsh-docx-kit

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-docx-kit` 把 Markdown 渲染为 DOCX 包，也把 DOCX 包投影回纯文本。`renderDocx(markdown, options)` 接受六级标题、普通段落、`- ` 与 `* ` 列表项、管道表格，以及行内加粗与等宽；`extractDocxText(bytes, limits)` 返回正文、页眉与页脚文本并保留标题层级，读取受调用方给出的条目数与解压字节预算约束。两个方向都只用本包在 `node:zlib` 之上实现的 ZIP 与 XML 读写，畸形的归档以 `problems` 返回而不抛异常。本包不向 Cordis 组合注册任何东西。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时使用

[`@deepseek-ai/dsh-doc-template`](../doc-template/README.zh.md) 消费本包以渲染 DOCX，[`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.zh.md) 消费本包以提取 DOCX 文本。它是作者 Go 项目 DOCX 渲染器与读取器的 TypeScript 重写；当某个消费方必须在不依赖 Office 库、也不起外部进程的前提下产出 DOCX 字节或读取 DOCX 文本时，就用它。

### 入口

```ts
import { extractDocxText, renderDocx } from '@deepseek-ai/dsh-docx-kit'

const bytes = renderDocx('# 标题\n\n正文**加粗**', { title: '交付件' })
const { text, problems } = extractDocxText(bytes, { maxArchiveEntries: 10_000, maxUncompressedBytes: 64 * 1024 * 1024 })
```

`renderDocx` 返回包字节，仅当部件名无法写入时才抛。`extractDocxText` 总会返回：`text` 为全部投影行以空行相连，`sections` 逐行给出同一批行及其标题层级，`problems` 逐项点名归档或部件的失败，从 `not-a-zip` 到 `too-large`、`malformed-xml`、`no-text`。

读取预算为必填参数而非缺省值：一条 deflate 流能把小文件膨胀上千倍，不设界的读取器会把有界的输入变成任意大小的分配。超出任一预算的归档以 `too-large` 报出并整条剔除，绝不截断。

`renderDocx` 会丢掉 XML 1.0 禁止的字符——除制表符、换行与回车以外的 C0 控制符，以及 U+FFFE 与 U+FFFF——并转义五个预定义实体。含汉字、假名或谚文的 run 把 `Noto Sans CJK SC` 标为 `w:eastAsia`。部件名不是恰好 `word/document.xml` 的，不算正文。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部细节 —— 点击展开</summary>

两个方向共用 ZIP 容器与 XML 扫描器，因此下表每一行都可从任一个入口到达。

| 模块 | 职责 |
| --- | --- |
| `src/types.ts` | 共享词汇：块模型、文本投影、问题码与部件名。 |
| `src/xml.ts` | XML 扫描器、元素树，以及实体转义与解码。 |
| `src/zip.ts` | 建立在 `node:zlib` 之上的 ZIP 读写，含 CRC-32 校验、逐条目问题与调用方给出的读取预算。 |
| `src/markdown.ts` | `parseMarkdown` 与 `parseInline`：源行转块模型。 |
| `src/ooxml.ts` | `word/document.xml` 片段与另外两个包部件。 |
| `src/docx-write.ts` | `renderDocx`：块模型转片段再转完整包。 |
| `src/docx-read.ts` | `extractDocxText`：包转行、区块与问题。 |

读取方向的投影规则完整写在 `src/docx-read.ts` 的模块 JSDoc 上：一个段落投影为一行，文本取自其 `w:t`；标题行按层级带 `#` 前缀；表格一行投影为其单元格以 ` | ` 相连；页眉与页脚部件按其标记行、按归档顺序投影。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [document 分组](../README.zh.md) —— 本分组的兄弟包。
- [Office 转换](../../../docs/subsystems/office-kit.zh.md) —— Office 文件的 Host 侧转换路径。
- [包分组](../../README.zh.md) —— 各分组的职责。

-----

<a id="model-experience"></a>
## 模型体验

### 由消费方渲染的文档文本

#### 模型所见

本包不注册提示词段落、工具 schema 或会话事件。向模型暴露任一方向的消费方拥有模型可见文本，无论那是渲染出的 `.docx` 路径还是 `extractDocxText` 的投影；本包提供这些文本，以及消费方可转述的 `problems`。

#### Token 影响

本包本身为零：库不向请求加入任何定义、提示词段落或结果文本。只有消费方工具自己的 schema 与结果才占用 token。

#### KV Cache 影响

无：本包不向 provider 发送任何内容，也不改动任何请求前缀。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **Markdown 子集即上游子集** —— 有序列表、引用块、分隔线、链接、图片与围栏代码块都不被识别：这些行会作为普通段落文本，因此使用它们的文档会缺少那些结构而非报错。
- **文本投影不是 Markdown 往返** —— 加粗与等宽是 run 属性而非文本，其标记不会被还原；列表项投影为它自身的项目符号字符，表格行投影为以空行相隔的多行，再渲染时会被读成多个单行表格。
- **标题层级来自两个属性** —— `w:pStyle` 名为 `HeadingN` 或本地化的数字形式，否则取行内的 `w:outlineLvl`（自 0 起算）；两者皆无的段落即正文段落，且命名了层级的样式优先于大纲级别。
- **部件按 UTF-8 解码** —— 不查看 ZIP 的名称标志，因而遗留 CP437 条目名会被有损解码，UTF-16 的 document 部件会报 `malformed-xml`。
- **ZIP64 归档报 `unsupported-archive`** —— 超出 32 位长度与偏移字段的条目数据与归档不在范围内。
- **读取预算约束的是内存而非工作量** —— 在预算内的归档仍同步解压，调用方的进程会在整个解压期间阻塞，取消信号到不了这里。
- **单元格内嵌套的表格只贡献文本** —— 其段落并入单元格文本，行与单元格分隔符不投影。
- **页眉页脚按名称前缀选取** —— 任何 `word/header*.xml` 或 `word/footer*.xml` 部件都按归档顺序投影，包括 `word/headerStyles.xml` 这样的部件。
- **只读取文本与标题层级** —— 样式、编号、脚注、批注、图片与删除文本（`w:delText`）都不投影。
- **消费方插件负责文件路径与授权** —— [`@deepseek-ai/dsh-doc-template`](../doc-template/README.zh.md) 传入字节上限并拥有输出路径；[`@deepseek-ai/dsh-document-deliver`](../document-deliver/README.zh.md) 传入读取预算并拥有提取的文本。

<a id="dev-note"></a>
### 开发备注

本包是 MIT 许可的 Go 项目 Mady 两个文件的重写：写方向来自 `domains/doctmpl/renderer_docx.go`，读方向来自 `knowledge/fileindex/reader_docx.go`。有意差异记录在触及这些行为的模块 JSDoc 上：写入端把长度写进本地文件头而不写数据描述符，并使用固定的 DOS 时间戳，使相同输入字节产生相同输出；读取端返回结构化问题，而上游 Go 读取器返回空文本与 `Confidence` 字段。

本包不发布 invariant 伴生组件：本包不持有持久状态与事件，每个导出都是针对调用方自有字节的纯函数。
