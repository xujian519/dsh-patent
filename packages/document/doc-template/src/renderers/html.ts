/**
 * The HTML renderer, rewritten from `renderer_html.go` of the Go project Mady.
 * The upstream renderer converted Markdown with goldmark (CommonMark + GFM, hard
 * wraps, raw HTML passed through); this rewrite uses `marked` with the same
 * options. Heading anchor ids are not generated, because `marked` dropped them.
 *
 * Raw HTML in a template body passes through, as it did upstream. That is why a
 * variable substituted into HTML output is escaped first: the value comes from
 * the model, and the template's own markup must survive while an injected
 * element must not. A Markdown link or image is still an element, so its URL
 * is kept only for http, https, mailto, or a relative reference.
 * @module @deepseek-ai/dsh-doc-template/renderers/html
 */

import { Marked } from 'marked'
import type { Tokens } from 'marked'
import type { Renderer, RenderMeta, RenderStyle } from '../types.ts'
import { applyDisclaimer } from './markdown.ts'

/** Schemes a rendered link or image may use. A relative URL has no scheme. */
const DELIVERABLE_SCHEME = /^(?:https?|mailto):/iu

/**
 * Whether a Markdown link or image URL may be written into the HTML document.
 * `javascript:`, `data:`, `vbscript:`, and protocol-relative URLs are refused.
 * Whitespace and C0 controls are removed before the scheme is read, so a break
 * inside `javascript` does not hide the scheme.
 * @param href - the URL the Markdown parser produced.
 * @returns true for http, https, mailto, and a relative URL.
 */
function isDeliverableUrl(href: string): boolean {
  const compact = href.trim().replace(/[\u0000-\u0020]+/gu, '')
  if (compact.startsWith('//')) return false
  const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(compact)
  return scheme === null || DELIVERABLE_SCHEME.test(compact)
}

/** Markdown converter of this renderer: GFM with hard line breaks, as upstream. */
const HTML_CONVERTER = new Marked({ gfm: true, breaks: true })
HTML_CONVERTER.use({
  renderer: {
    link(this: { parser: { parseInline(tokens: Tokens.Link['tokens']): string } }, token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens)
      if (!isDeliverableUrl(token.href)) return text
      const title = token.title === null || token.title === undefined || token.title === ''
        ? ''
        : ` title="${escapeHtmlText(token.title)}"`
      return `<a href="${escapeHtmlText(token.href)}"${title}>${text}</a>`
    },
    image(token: Tokens.Image): string {
      const alt = escapeHtmlText(token.text)
      if (!isDeliverableUrl(token.href)) return alt
      return `<img src="${escapeHtmlText(token.href)}" alt="${alt}">`
    },
  },
})

/** Default stylesheet of a rendered document. */
const DEFAULT_HTML_STYLE_BLOCK = `<style>
:root { --fg:#222; --bg:#fff; --muted:#666; --border:#ddd; --code-bg:#f5f5f5; }
* { box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",
  "PingFang SC","Microsoft YaHei",sans-serif; color:var(--fg); background:var(--bg);
  max-width:820px; margin:2rem auto; padding:0 1.5rem; line-height:1.7; }
h1,h2,h3,h4,h5,h6 { font-weight:600; line-height:1.3; margin:1.6em 0 .6em; }
h1 { font-size:1.8rem; border-bottom:2px solid var(--border); padding-bottom:.3rem; }
h2 { font-size:1.5rem; border-bottom:1px solid var(--border); padding-bottom:.2rem; }
h3 { font-size:1.25rem; }
table { border-collapse:collapse; width:100%; margin:1em 0; }
th,td { border:1px solid var(--border); padding:.5em .75em; text-align:left; }
th { background:#f8f8f8; font-weight:600; }
tr:nth-child(even) { background:#fafafa; }
code { font-family:"SF Mono","Fira Code","JetBrains Mono",Consolas,monospace;
  background:var(--code-bg); padding:.15em .35em; border-radius:3px; font-size:.9em; }
pre { background:var(--code-bg); padding:1em; border-radius:6px; overflow-x:auto; }
pre code { background:none; padding:0; }
blockquote { margin:1em 0; padding:.5em 1em; border-left:4px solid var(--border);
  color:var(--muted); }
img { max-width:100%; }
a { color:#2563eb; }
hr { border:none; border-top:1px solid var(--border); margin:2em 0; }
@media print { body { max-width:none; margin:0; padding:1cm; } }
</style>`

/** A4 print-ready stylesheet of the patent deliverable templates. */
const PATENT_HTML_STYLE_BLOCK = `<style>
@page { size: A4; margin: 20mm 25mm; }
:root { --patent-navy:#1f3a5f; --patent-danger:#b42318; --patent-warning:#b54708;
  --patent-success:#067647; --patent-muted:#666; --patent-border:#d7d7d7; }
* { box-sizing:border-box; }
body { font-family:"FangSong","仿宋","FangSong_GB2312",serif; font-size:12pt;
  line-height:1.5; color:#222; background:#fff; max-width:160mm; margin:0 auto;
  padding:0; }
h1,h2,h3,h4,h5,h6 { font-family:"SimHei","黑体",sans-serif; color:var(--patent-navy);
  font-weight:700; line-height:1.3; margin:1.4em 0 .6em; }
h1 { font-size:18pt; border-bottom:2px solid var(--patent-navy);
  padding-bottom:.3rem; }
h2 { font-size:15pt; border-bottom:1px solid var(--patent-navy);
  padding-bottom:.2rem; }
h3 { font-size:13pt; }
table { border-collapse:collapse; width:100%; margin:1em 0; font-size:11pt; }
th,td { border:1px solid var(--patent-border); padding:.45em .6em;
  text-align:left; vertical-align:top; }
th { background:#f0f3f7; font-weight:600; }
.verdict-table { margin:1.2em 0; }
.verdict-table .verdict-danger { color:var(--patent-danger); font-weight:700; }
.verdict-table .verdict-warning { color:var(--patent-warning); font-weight:700; }
.verdict-table .verdict-success { color:var(--patent-success); font-weight:700; }
.doc-meta { margin:1em 0; padding:.8em 1em; background:#f7f9fc;
  border:1px solid var(--patent-border); border-radius:4px; font-size:10.5pt; }
.doc-meta dl { display:flex; flex-wrap:wrap; gap:.4rem 2rem; margin:0; }
.doc-meta dt { font-weight:600; color:var(--patent-navy); }
.doc-meta dd { margin:0; }
.callout { margin:1em 0; padding:.7em 1em; border-left:4px solid
  var(--patent-navy); background:#f7f9fc; }
.callout.warning { border-left-color:var(--patent-warning); }
.callout.danger { border-left-color:var(--patent-danger); }
blockquote { margin:1em 0; padding:.4em 1em; border-left:4px solid
  var(--patent-border); color:#444; }
code { font-family:"SF Mono",Consolas,monospace; background:#f5f5f5;
  padding:.12em .3em; border-radius:3px; font-size:.9em; }
pre { background:#f5f5f5; padding:.8em; border-radius:4px; overflow-x:auto; }
pre code { background:none; padding:0; }
img { max-width:100%; }
a { color:#2563eb; }
hr { border:none; border-top:1px solid var(--patent-border); margin:1.5em 0; }
@media print { body { max-width:none; margin:0; } }
</style>`

/**
 * Escape the five characters HTML treats specially. Applied to variable values
 * before substitution, and to the metadata this renderer writes into the head.
 * @param text - the text to escape.
 * @returns the text with `&`, `<`, `>`, `"`, and `'` replaced by entities.
 */
export function escapeHtmlText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Whether a render style selects the patent deliverable stylesheet.
 * @param style - the render style, absent when the template declares none.
 * @returns true for a patent style or the `sati` style name.
 */
export function isPatentStyle(style: RenderStyle | undefined): boolean {
  if (style === undefined) return false
  const name = style.name.toLowerCase()
  return name.includes('patent') || name === 'sati'
}

/**
 * The stylesheet of one rendered document.
 * @param style - the render style, absent when the template declares none.
 * @returns the patent stylesheet for a patent style, the default one otherwise.
 */
function selectStyleBlock(style: RenderStyle | undefined): string {
  return isPatentStyle(style) ? PATENT_HTML_STYLE_BLOCK : DEFAULT_HTML_STYLE_BLOCK
}

/**
 * Render a resolved body as a standalone HTML5 document.
 * @param markdown - the resolved body.
 * @param meta - rendering metadata; the language becomes the `lang` attribute.
 * @returns the HTML document, newline-terminated.
 */
function renderHtml(markdown: string, meta: RenderMeta): string {
  const body = HTML_CONVERTER.parse(applyDisclaimer(meta.style, markdown), { async: false })
  const title = meta.title ?? ''
  const author = meta.author ?? ''
  const head: string[] = [
    '<!DOCTYPE html>',
    `<html lang="${escapeHtmlText(meta.language)}">`,
    '<head>',
    '<meta charset="UTF-8">',
  ]
  if (title !== '') head.push(`<title>${escapeHtmlText(title)}</title>`)
  if (author !== '') head.push(`<meta name="author" content="${escapeHtmlText(author)}">`)
  head.push(selectStyleBlock(meta.style), '</head>', '<body>')
  if (title !== '') head.push(`<h1>${escapeHtmlText(title)}</h1>`)
  head.push(body, '</body>', '</html>')
  return `${head.join('\n')}\n`
}

/** The HTML renderer. */
export const htmlRenderer: Renderer = { format: 'html', render: renderHtml }
