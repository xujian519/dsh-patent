/**
 * Dependency-free XML/Atom extraction helpers, ported from the Sati literature layer.
 *
 * Covers the routine XML needs of academic APIs (Atom entry extraction for arXiv,
 * PubMed EFetch) without a full XML parser. All defensive: malformed input returns
 * `undefined` / empty arrays rather than throwing. Known boundary (fragile by design):
 * no CDATA or deep namespace handling; behavior is locked by the fixture tests.
 * @module @deepseek-ai/dsh-tool-literature/runtime/shared/xml
 */
import { decodeEntities } from './text.ts'

/**
 * Inner text of the first `<tag>…</tag>`, entity-decoded.
 * @param xml - the XML text.
 * @param tag - the tag name.
 * @returns the inner text, or undefined when absent.
 */
export function xmlText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  if (!m) return undefined
  const text = decodeEntities(m[1]).replace(/\s+/g, ' ').trim()
  return text.length ? text : undefined
}

/**
 * Inner text of every `<tag>…</tag>` block.
 * @param xml - the XML text.
 * @param tag - the tag name.
 * @returns the inner text of every matching block.
 */
export function xmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  const out: string[] = []
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push(m[1])
  return out
}

/**
 * Value of `attr` on the first `<tag …>`.
 * @param xml - the XML text.
 * @param tag - the tag name.
 * @param attr - the attribute name.
 * @returns the attribute value, or undefined when absent.
 */
export function xmlAttr(xml: string, tag: string, attr: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*?\\b${attr}="([^"]*)"`).exec(xml)
  return m ? decodeEntities(m[1]) : undefined
}

/** One self-closing element: attribute map + raw text. */
interface SelfClosing {
  attrs: Record<string, string>
  raw: string
}

/**
 * Every self-closing `<tag … />` element with its attributes. `xmlBlocks` only matches
 * paired `<tag>…</tag>`, so self-closing tags (Atom `<link …/>`, `<category …/>`) are
 * invisible to it while `xmlAttr` matches the opening — a trap. This helper returns each
 * occurrence's attribute map, callable by any attribute (e.g. arXiv's `title="pdf"` links),
 * independent of attribute order.
 * @param xml - the XML text.
 * @param tag - the tag name.
 * @returns the self-closing elements (attribute map + raw text).
 */
export function xmlSelfClosing(xml: string, tag: string): SelfClosing[] {
  const re = new RegExp(`<${tag}\\b([^>]*?)/\\s*>`, 'g')
  const out: SelfClosing[] = []
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) {
    out.push({ attrs: parseAttrs(m[1]), raw: m[0] })
  }
  return out
}

/** Parse a run of `key="value"` attribute pairs into an entity-decoded map. */
function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    attrs[m[1]] = decodeEntities(m[2])
  }
  return attrs
}
