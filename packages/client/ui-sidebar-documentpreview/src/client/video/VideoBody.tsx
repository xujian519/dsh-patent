/**
 * Video body: the file streams from the authenticated `api/file` route, so a
 * browser seeks with Range requests instead of buffering the complete file in
 * memory. The resource metadata supplies the immutable version the URL names;
 * the file's own bytes never pass through this component.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { fileMediaUrl, pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { DocumentPreviewProps } from '../contract/document.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import css from './VideoBody.module.css'

/** Video body props: the standard document share plus its dictionary. */
export type VideoBodyProps = DocumentPreviewProps & PropsLocale<'sidebarVideo'>

/**
 * Append the observed file version so the video element requests the same
 * immutable URL the host caches; a reload after a rewrite names the new one.
 * @param base - application base URL, including any deployment prefix.
 * @param path - absolute host path of the video file.
 * @param version - the resource's current version token.
 * @returns the displayable URL, or undefined when the transport cannot serve files.
 */
export function videoSourceUrl(base: string, path: string, version: string): string | undefined {
  const url = fileMediaUrl(base, path)
  if (url === undefined) return undefined
  // The file route always carries `?path=`, so the version joins that query.
  return `${url}&v=${encodeURIComponent(version)}`
}

/**
 * Render one workspace video with native controls.
 * @param props - file resource address, renderer revision callbacks, and locale.
 * @returns the video surface, a load failure, or an unsupported-transport line.
 */
export function VideoBody(props: VideoBodyProps): ReactNode {
  const { resourceAddress, t } = props
  const meta = props.useResource<'file'>(resourceAddress)
  const request = props.content.kind === 'renderer' ? props.content : undefined
  const version = meta.value?.version
  const absolutePath = meta.value?.absolutePath
  const reported = useRef<string>()
  const [failed, setFailed] = useState(false)
  const url = useMemo(() => absolutePath === undefined || version === undefined
    ? undefined
    : videoSourceUrl(document.baseURI, absolutePath, version), [absolutePath, version])

  // One report per rendered revision. A failed stat and a successful one can
  // alternate without a file rewrite, so the report key carries both.
  useEffect(() => {
    if (request === undefined || version === undefined) return
    const key = `${request.revision}:${version}`
    if (reported.current === key) return
    reported.current = key
    request.loaded(version)
  }, [request, version])
  useEffect(() => {
    if (request !== undefined && meta.failure !== undefined) request.failed()
  }, [request, meta.failure])
  useEffect(() => { setFailed(false) }, [url])

  if (absolutePath === undefined || version === undefined) {
    return meta.failure === undefined
      ? <LoadingIndicator label={t('loading')} />
      : <p className={css.status} role="alert">{t('failed')}</p>
  }
  if (url === undefined) return <p className={css.status} role="alert">{t('unsupported')}</p>
  const { name } = pathPartsOf(absolutePath)
  return <div className={css.frame} data-video-preview>
    <video
      className={css.video}
      src={url}
      controls
      playsInline
      preload="metadata"
      aria-label={t('preview', { name })}
      onError={() => { setFailed(true) }}
    />
    {failed && <p className={css.status} role="alert">{t('failed')}</p>}
  </div>
}
