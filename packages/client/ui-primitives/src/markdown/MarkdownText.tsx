/**
 * Untrusted assistant-Markdown React surface over the `streaming-renderer.ts`
 * pipelines.
 */

import { memo, useEffect, useMemo, useReducer, useRef } from 'react'
import clsx from 'clsx'
import { renderSettled, StreamingRenderer } from './streaming-renderer.ts'
import { StreamFrameGate } from './stream-frame-gate.ts'
import type { MarkdownFileMentions, MarkdownLabels, MarkdownPathImages } from './render.tsx'
import 'katex/dist/katex.min.css'
import css from './MarkdownText.module.css'

export type { MarkdownCodeLabels, MarkdownFileMentions, MarkdownLabels, MarkdownPathImages } from './render.tsx'

/**
 * Render untrusted assistant-authored Markdown as semantic React elements.
 * @param props - Markdown source text preserved by the session projection;
 * `streaming` parses incrementally across chunks and highlights fences as
 * they grow (each fence re-tokenizes only appended text; TeX stays literal
 * until the finalize swap so incomplete formulae never flash errors), and a
 * reply whose open tail block grows past the frame budget shows the previous
 * frame until its cool-down elapses, then catches up through the retry timer
 * below without waiting for another chunk;
 * `labels` forwards localized fence and footnote chrome — pass a
 * reference-stable object (memoized per locale revision), because a new
 * identity discards the streaming render cache mid-message. `fileMentions`
 * links inline-code tokens its resolver recognizes as real files, and
 * `pathImages` rewrites image destinations that are local file paths into
 * displayable URLs its resolver vouches for. Those two vocabularies are the
 * single streaming gate — they apply to settled renders only, because a
 * streaming message's vocabulary is not final and frozen cached elements
 * must not bake in handlers that could go stale. A surrounding
 * `MarkdownDelegateProvider` can delegate ordinary HTTP(S) activation while
 * modified clicks retain native behavior. `variant="compact"` uses secondary
 * text sizing, uniform bold headings, and tight block spacing; the default
 * `body` variant uses the full document typography. `omitHtml` renders raw
 * HTML as nothing instead of literal text, for documents written for HTML
 * renderers, such as package READMEs. `textInteractionSource` marks the
 * existing root as a source for text selection interactions.
 * The provider's `openFile` enables local Markdown links in settled messages,
 * including `#L24` / `#L24-L30` fragments and `:24` / `:24-30` / `:24:5` suffixes
 * (ranges open at their first line, columns are ignored, and invalid locations
 * open only the file; see the README for URL/path classification).
 * @returns A GFM document with TeX math rendered through KaTeX; raw HTML never
 * renders as markup, and unsafe protocols are disabled. Local links without an opener remain text;
 * absolute HTTP(S) images render directly.
 */
export const MarkdownText = memo(function MarkdownText({
  text, streaming = false, labels, fileMentions, pathImages, variant = 'body', omitHtml = false, textInteractionSource = false, frameGate,
}: {
  text: string
  streaming?: boolean
  labels: MarkdownLabels
  fileMentions?: MarkdownFileMentions | undefined
  pathImages?: MarkdownPathImages | undefined
  variant?: 'body' | 'compact'
  omitHtml?: boolean
  textInteractionSource?: boolean
  /**
   * Frame admission for a streaming reply's open tail block. Product renders
   * leave it unset; a caller that passes one owns its clock, which lets a test
   * pin which frame is held back instead of measuring the host's parse cost.
   */
  frameGate?: StreamFrameGate | undefined
}) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const streamLabelsRef = useRef<MarkdownLabels>(labels)
  const streamGateRef = useRef<StreamFrameGate | undefined>(frameGate)
  const streamOmitHtmlRef = useRef(omitHtml)
  const [frameTick, retryFrame] = useReducer((tick: number): number => tick + 1, 0)
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return renderSettled(text, labels, fileMentions, pathImages, omitHtml)
    }
    if (streamRef.current === null || streamLabelsRef.current !== labels
      || streamGateRef.current !== frameGate || streamOmitHtmlRef.current !== omitHtml) {
      streamRef.current = new StreamingRenderer(labels, omitHtml, frameGate)
      streamLabelsRef.current = labels
      streamGateRef.current = frameGate
      streamOmitHtmlRef.current = omitHtml
    }
    return streamRef.current.render(text)
  }, [text, streaming, labels, fileMentions, pathImages, frameGate, omitHtml, frameTick])
  // A frame the streaming renderer held back still has to land when the reply
  // pauses, so its cool-down is awaited here rather than left to the next chunk.
  useEffect(() => {
    const renderer = streamRef.current
    const delay = streaming && renderer !== null ? renderer.delayMs() : null
    if (delay === null) return
    const timer = setTimeout(retryFrame, delay)
    return () => { clearTimeout(timer) }
  })
  return <div className={clsx(css.markdown, variant === 'compact' && css.compact)}
    data-text-interaction-source={textInteractionSource ? '' : undefined}
    data-markdown-variant={variant === 'compact' ? variant : undefined}>{children}</div>
})
