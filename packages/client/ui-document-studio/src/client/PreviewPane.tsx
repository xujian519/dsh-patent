/**
 * The studio's preview body: one produced file read from disk, kept fresh by
 * the `file` resource's version.
 *
 * The pane subscribes to the file's metadata and re-reads when the version
 * moves, so a rewrite reaches the user without reselecting the file. Automatic
 * refresh can be paused; the manual reload still reads the current bytes. A
 * file that disappears keeps its last read on screen with a deletion note,
 * because the copy on disk is what the log stopped tracking, not what the user
 * was reading.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  MarkdownText, fileSizeText, pathBasename, type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the `file` protocol into ResourceProtocolMap.
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type { CompleteReadText, ReadFileText } from './file-reads.ts'
import { WorkspaceReadError } from './file-reads.ts'
import type { DocumentStudioKey } from './locales.ts'
import { isHtmlPath, isMarkdownPath, isTextPreviewable } from './preview-kinds.ts'
import { readFailureText, type ReadFailure } from './read-failure.ts'
import css from './StudioView.module.css'

/** The studio preview pane's props: the selected file, its live address, and the read face. */
export interface PreviewPaneProps {
  /** The selected produced path, as the deliverables reported it. */
  readonly path: string
  /** The `file` resource address the pane subscribes to. */
  readonly address: string
  /** Whether a version change reloads the pane automatically. */
  readonly autoRefresh: boolean
  /** Bumped by the manual reload action; any change forces one read. */
  readonly reloadToken: number
  /** Read one produced file's bounded text head through the host's window cap. */
  readonly readFileText: (path: string) => Promise<ReadFileText>
  /** Read one produced file completely, or the host cap that refused it. */
  readonly readFileTextComplete: (path: string) => Promise<CompleteReadText>
  /** Deployment cap on an inline HTML document, in bytes. */
  readonly htmlPreviewMaxBytes: number
  /** Whether the sidebar preview surface is mounted. */
  readonly canOpenInSidebar: boolean
  /** Hand one produced file to the sidebar preview. */
  readonly openInSidebar: (path: string) => boolean
  /** Append text to the session's composer draft without sending it. */
  readonly insertDraft: (text: string) => boolean
  /** The file's live metadata and resource subscription. */
  readonly useResource: UseResource
  /** Studio dictionaries. */
  readonly t: Translate<DocumentStudioKey>
}

/** One file's read result, tagged with the version it describes. */
interface LoadedDocument {
  readonly path: string
  /** The metadata version read, when the resource reported one. */
  readonly version: string | undefined
  readonly text: string
  /** Whether the read stopped short of the file's end. */
  readonly truncated: boolean
}

/** One section a delivered HTML file declares, for the reference draft. */
interface DocumentSection {
  readonly id: string
  readonly heading: string
}

/** The read state one selected file drives. */
interface PreviewDocument {
  /** The bytes on screen, for the currently selected path. */
  readonly current: LoadedDocument | null
  /** A read failure, reported in place of the body. */
  readonly error: ReadFailure | null
  /** The cap that kept an HTML file out of the frame, in bytes. */
  readonly tooLarge: number | null
  /** The stat reported the file gone; the last content stays on screen. */
  readonly deleted: boolean
  /** A stat failure that is not a deletion. */
  readonly statError: ReadFailure | null
  /** The file moved on disk while automatic refresh was paused. */
  readonly changed: boolean
}

/** The one section picker's id, so its label can be associated with it. */
const SECTION_SELECT_ID = 'document-studio-section'

/** Debounce window for a version change, so one save does not read twice. */
const RELOAD_DEBOUNCE_MS = 100

/** Strip tags and decode the few entities a heading realistically carries. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Read the `data-doc-id` sections a delivered HTML file declares.
 *
 * The preview frame is sandboxed without script or same-origin access, so the
 * parent cannot read a text selection inside it; the section ids come from the
 * source text the preview already holds. A heading is the first `<h1>`–`<h3>`
 * up to the next section.
 * @param html - the delivered HTML source.
 * @returns declared sections in document order, ids trimmed and de-duplicated.
 */
export function parseDocumentSections(html: string): readonly DocumentSection[] {
  const starts = [...html.matchAll(/<section\b[^>]*?data-doc-id\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi)]
  const sections: DocumentSection[] = []
  const seen = new Set<string>()
  starts.forEach((start, index) => {
    const captured = start[1] ?? start[2]
    /* v8 ignore next -- the alternation captures exactly one quote style, so the empty fallback only narrows the array access */
    const id = (captured ?? '').trim()
    if (id === '' || seen.has(id)) return
    seen.add(id)
    const body = html.slice(start.index, starts[index + 1]?.index ?? html.length)
    const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(body)
    if (heading === null) {
      sections.push({ id, heading: '' })
      return
    }
    /* v8 ignore next -- a matched heading always captures its inner HTML; the fallback only narrows the array access */
    sections.push({ id, heading: plainText(heading[1] ?? '') })
  })
  return sections
}

/** Turn one read rejection into the failure shape the pane localizes. */
function readFailure(reason: unknown): ReadFailure {
  return reason instanceof WorkspaceReadError
    ? { code: reason.code, message: reason.message }
    : { code: undefined, message: reason instanceof Error ? reason.message : String(reason) }
}

/**
 * Read the selected file and keep it in step with its metadata version.
 * @param props - the path, its address, the refresh controls, and the read face.
 * @returns the read state the pane renders.
 */
function usePreviewDocument({
  path, address, autoRefresh, reloadToken, htmlPreviewMaxBytes, readFileText, readFileTextComplete, useResource,
}: Pick<
  PreviewPaneProps,
  'path' | 'address' | 'autoRefresh' | 'reloadToken' | 'htmlPreviewMaxBytes'
  | 'readFileText' | 'readFileTextComplete' | 'useResource'
>): PreviewDocument {
  const meta = useResource<'file'>(address)
  const version = meta.status === 'live' ? meta.value?.version : undefined
  const bytes = meta.value?.bytes
  const html = isHtmlPath(path)
  const text = isTextPreviewable(path)
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null)
  const [error, setError] = useState<ReadFailure | null>(null)
  const [tooLarge, setTooLarge] = useState<number | null>(null)
  // The reload token this pane last acted on; a newer token forces one read.
  const appliedReload = useRef(reloadToken)

  const current = loaded !== null && loaded.path === path ? loaded : null
  const statFailure = meta.status === 'failed' && meta.failure !== undefined
    ? { code: meta.failure.code, message: meta.failure.message }
    : null
  const deleted = statFailure?.code === 'workspace-file/not-found'
  const statError = statFailure !== null && !deleted ? statFailure : null
  // A newer version with automatic refresh paused: the bytes on screen are
  // stale, and the manual reload action is the way to catch up.
  const changed = current?.version !== undefined && version !== undefined && current.version !== version

  useEffect(() => {
    if (!text) {
      setLoaded(null)
      setError(null)
      setTooLarge(null)
      return
    }
    // An HTML read is unbounded, so wait for the stat that reports its size
    // instead of loading a file the cap would reject anyway.
    if (html && meta.status === 'loading') return
    // A failed stat means the file is gone or unreadable; a read would fail the
    // same way, and the last content stays on screen with the failure note.
    if (meta.status === 'failed') return
    if (html && bytes !== undefined && bytes > htmlPreviewMaxBytes) {
      // The cap, not the file's own size, is the policy the user can change.
      setTooLarge(htmlPreviewMaxBytes)
      setLoaded(null)
      setError(null)
      return
    }
    const force = reloadToken !== appliedReload.current
    if (!force && version !== undefined && current?.version === version) return
    if (!force && version !== undefined && current?.version !== undefined && !autoRefresh) return
    let cancelled = false
    const timer = setTimeout(() => {
      appliedReload.current = reloadToken
      const fail = (reason: unknown): void => {
        if (cancelled) return
        setError(readFailure(reason))
        setLoaded(null)
        setTooLarge(null)
      }
      if (html) {
        readFileTextComplete(path).then((full) => {
          if (cancelled) return
          if (full.truncated) {
            setTooLarge(full.limitBytes)
            setLoaded(null)
            return
          }
          setLoaded({ path, version, text: full.content, truncated: false })
          setError(null)
          setTooLarge(null)
        }, fail)
        return
      }
      readFileText(path).then((result) => {
        if (cancelled) return
        setLoaded({ path, version, text: result.content, truncated: result.truncated })
        setError(null)
        setTooLarge(null)
      }, fail)
    }, RELOAD_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    path, version, autoRefresh, reloadToken, htmlPreviewMaxBytes, bytes, meta.status,
    text, html, current, readFileText, readFileTextComplete,
  ])

  return { current, error, tooLarge, deleted, statError, changed }
}

/** The sidebar handoff, or nothing when that surface is not composed. */
function Handoff({ path, canOpenInSidebar, openInSidebar, t }: {
  path: string
  canOpenInSidebar: boolean
  openInSidebar: (path: string) => boolean
  t: Translate<DocumentStudioKey>
}): ReactNode {
  if (!canOpenInSidebar) return null
  return (
    <button type="button" className={css.action} onClick={() => { openInSidebar(path) }}>
      {t('studio.action.previewSidebar')}
    </button>
  )
}

/** The rendered body for one read state. */
function PreviewBody({ path, state, labels, canOpenInSidebar, openInSidebar, t }: {
  path: string
  state: PreviewDocument
  labels: MarkdownLabels
  canOpenInSidebar: boolean
  openInSidebar: (path: string) => boolean
  t: Translate<DocumentStudioKey>
}): ReactNode {
  const handoff = (
    <Handoff path={path} canOpenInSidebar={canOpenInSidebar} openInSidebar={openInSidebar} t={t} />
  )
  const { current, error, tooLarge, deleted, statError } = state
  if (error !== null) return <div className={css.error}>{readFailureText(error, t)}</div>
  if (statError !== null && current === null) {
    return <div className={css.error}>{readFailureText(statError, t)}</div>
  }
  if (!isTextPreviewable(path)) {
    return (
      <div className={css.sidebarOnly}>
        <p className={css.note}>{t('studio.preview.sidebarOnly')}</p>
        {handoff}
      </div>
    )
  }
  if (tooLarge !== null) {
    return (
      <div className={css.sidebarOnly}>
        <p className={css.note}>{t('studio.preview.tooLarge', { limit: fileSizeText(tooLarge) })}</p>
        {handoff}
      </div>
    )
  }
  if (current === null) {
    return (
      <div className={css.note}>
        {deleted ? t('studio.preview.deleted') : t('studio.preview.loading')}
      </div>
    )
  }
  if (isHtmlPath(path)) {
    return <iframe className={css.frame} title={pathBasename(path)} sandbox="" srcDoc={current.text} />
  }
  if (isMarkdownPath(path)) {
    return (
      <div className={css.markdownPreview}>
        <MarkdownText text={current.text} labels={labels} />
        {current.truncated && <p className={css.note}>{t('studio.preview.truncated')}</p>}
      </div>
    )
  }
  return (
    <div className={css.textPreview}>
      {current.text}
      {current.truncated && <p className={css.note}>{t('studio.preview.truncated')}</p>}
    </div>
  )
}

/** The declared-section picker for a delivered HTML file. */
function SectionPicker({ path, sections, insertDraft, t }: {
  path: string
  sections: readonly DocumentSection[]
  insertDraft: (text: string) => boolean
  t: Translate<DocumentStudioKey>
}): ReactNode {
  const [sectionId, setSectionId] = useState('')
  const [inserted, setInserted] = useState(false)

  // A new file starts its picker empty; a reload of the same file keeps the
  // selection, because the rendered sections are the same document.
  useEffect(() => {
    setSectionId('')
    setInserted(false)
  }, [path])

  return (
    <div className={css.sections}>
      <label className={css.note} htmlFor={SECTION_SELECT_ID}>{t('studio.section.pick')}</label>
      <select
        id={SECTION_SELECT_ID}
        className={css.select}
        value={sectionId}
        onChange={(event) => { setSectionId(event.currentTarget.value) }}
      >
        <option value="">{t('studio.section.pick')}</option>
        {sections.map(section => (
          <option key={section.id} value={section.id}>
            {section.heading === '' ? section.id : `${section.id} · ${section.heading}`}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={css.action}
        disabled={sectionId === ''}
        onClick={() => {
          const section = sections.find(entry => entry.id === sectionId)
          if (section === undefined) return
          const reference = t('studio.section.reference', { path, id: section.id })
          const heading = section.heading === '' ? '' : `（${section.heading}）`
          setInserted(insertDraft(`${reference}${heading}\n\n${t('studio.section.instruction')}`))
        }}
      >
        {t('studio.section.insert')}
      </button>
      {inserted && <span className={css.note}>{t('studio.section.inserted')}</span>}
    </div>
  )
}

/**
 * Render the selected file: HTML in a sandboxed frame, Markdown as typeset
 * text, other text formats preformatted, and binary formats handed to the
 * sidebar.
 * @param props - selected path, live address, read face, and dictionary seat.
 * @returns the preview body.
 */
export function PreviewPane(props: PreviewPaneProps): ReactNode {
  const { path, autoRefresh, canOpenInSidebar, openInSidebar, insertDraft, t } = props
  const state = usePreviewDocument(props)
  const labels = useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel: t('studio.code.copy'),
      copiedLabel: t('studio.code.copied'),
      toolbarLabels: {
        codeLabel: t('studio.codeBlock.title'),
        wrapLabel: t('studio.codeBlock.wrap'),
        unwrapLabel: t('studio.codeBlock.unwrap'),
      },
    },
    footnotes: t('studio.footnotes'),
  }), [t])
  const sections = useMemo(
    () => isHtmlPath(path) && state.current !== null ? parseDocumentSections(state.current.text) : [],
    [path, state.current],
  )

  return (
    <>
      {state.deleted && state.current !== null && <p className={css.note}>{t('studio.preview.deleted')}</p>}
      {state.statError !== null && state.current !== null && (
        <p className={css.error}>{readFailureText(state.statError, t)}</p>
      )}
      {state.changed && !autoRefresh && <p className={css.note}>{t('studio.preview.changed')}</p>}
      <PreviewBody
        path={path}
        state={state}
        labels={labels}
        canOpenInSidebar={canOpenInSidebar}
        openInSidebar={openInSidebar}
        t={t}
      />
      {sections.length > 0 && state.current !== null && (
        <SectionPicker path={path} sections={sections} insertDraft={insertDraft} t={t} />
      )}
    </>
  )
}
