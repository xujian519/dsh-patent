import { useEffect, useState, type ReactNode } from 'react'
import {
  IconSearchOutlineRegular,
  LoadFailure,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  CatalogItem,
  CatalogPage,
  CatalogQuery,
  InstallPreview,
  PluginMarketSource,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PluginCatalogTab.module.css'

/** Registration-side Remote face used by the section. */
export interface PluginCatalogTabInjected {
  /** List the catalog sources the Host has registered. */
  listSources: () => Promise<readonly PluginMarketSource[]>
  /** Query one source's catalog. */
  search: (sourceId: string, query: CatalogQuery | undefined) => Promise<CatalogPage>
  /** Preview an `name@version` reference against the registry without installing. */
  preview: (ref: string) => Promise<InstallPreview>
}

/** Full component props assembled by the Settings slot renderer. */
export type PluginCatalogTabProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginCatalog'>
  & InjectFace<PluginCatalogTabInjected>

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly sources: readonly PluginMarketSource[] }

type PreviewState =
  | { readonly status: 'idle' }
  | { readonly status: 'pending' }
  | { readonly status: 'rejected' }
  | { readonly status: 'ready'; readonly preview: InstallPreview }

/** Whether a catalog card matches the local free-text query. */
function matches(item: CatalogItem, normalized: string): boolean {
  if (normalized.length === 0) return true
  return [item.name, item.description ?? '', item.package, item.category ?? '', ...(item.capability ?? [])]
    .some(value => value.toLocaleLowerCase().includes(normalized))
}

/** Build the catalog query from the search inputs, omitting empty filters. */
function queryFrom(q: string, category: string, capability: string): CatalogQuery {
  const normalized: CatalogQuery = {}
  if (q.trim().length > 0) normalized.q = q.trim()
  if (category.trim().length > 0) normalized.category = category.trim()
  if (capability.trim().length > 0) normalized.capability = capability.trim()
  return normalized
}

/** Render the read-only plugin-market discovery section. */
export function PluginCatalogTab({ t, listSources, search, preview }: PluginCatalogTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const [activeSourceId, setActiveSourceId] = useState<string | undefined>(undefined)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [capability, setCapability] = useState('')
  const [page, setPage] = useState<CatalogPage | undefined>(undefined)
  const [searchError, setSearchError] = useState<string | undefined>(undefined)
  const [ref, setRef] = useState('')
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'idle' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => listSources()).then(
      (sources) => { if (current) setState({ status: 'ready', sources }) },
      () => { if (current) setState({ status: 'error' }) },
    )
    return () => { current = false }
  }, [listSources, request])

  const retry = (): void => {
    setState({ status: 'loading' })
    setPage(undefined)
    setRequest(value => value + 1)
  }

  const source = state.status === 'ready'
    ? state.sources.find(candidate => candidate.id === activeSourceId)
    : undefined

  const runSearch = async (sourceId: string): Promise<void> => {
    /* v8 ignore next -- guarded callers: the search button is disabled when no source is selected. */
    if (sourceId.length === 0) return
    try {
      setSearchError(undefined)
      setPage(await search(sourceId, queryFrom(query, category, capability)))
    } catch {
      setPage(undefined)
      setSearchError(t('searchError'))
    }
  }

  const runPreview = async (reference: string): Promise<void> => {
    /* v8 ignore next -- guarded callers: the preview button is disabled for an empty reference. */
    if (reference.length === 0) return
    setPreviewState({ status: 'pending' })
    try {
      setPreviewState({ status: 'ready', preview: await preview(reference) })
    } catch {
      setPreviewState({ status: 'rejected' })
    }
  }

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleItems = (page?.items ?? []).filter(item => matches(item, normalizedQuery))

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {state.status === 'loading' ? (
        <div className={css.phase} role="status">{t('loading')}</div>
      ) : null}

      {state.status === 'error' ? (
        <LoadFailure message={t('error')} retryLabel={t('retry')} onRetry={retry} />
      ) : null}

      {state.status === 'ready' ? (
        <div className={css.body}>
          <section className={css.block}>
            <h3 className={css.blockTitle}>{t('sources')}</h3>
            <label className={css.field}>
              <span className={css.visuallyHidden}>{t('source')}</span>
              <select
                value={activeSourceId ?? ''}
                data-source-count={state.sources.length}
                onChange={(event) => {
                  const next = event.currentTarget.value
                  setActiveSourceId(next === '' ? undefined : next)
                  setPage(undefined)
                }}
              >
                <option value="">{t('source')}</option>
                {state.sources.map(item => (
                  <option key={item.id} value={item.id}>{item.name}{item.builtin ? ` · ${t('builtin')}` : ''}</option>
                ))}
              </select>
            </label>
            {state.sources.length === 0 ? <p className={css.status}>{t('noSources')}</p> : null}
          </section>

          <section className={css.block}>
            <h3 className={css.blockTitle}>{t('search')}</h3>
            <div className={css.searchRow}>
              <label className={css.field}>
                <IconSearchOutlineRegular aria-hidden="true" />
                <span className={css.visuallyHidden}>{t('search')}</span>
                <input
                  type="search"
                  value={query}
                  placeholder={t('searchPlaceholder')}
                  aria-label={t('search')}
                  onChange={(event) => { setQuery(event.currentTarget.value) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.visuallyHidden}>{t('category')}</span>
                <input
                  type="text"
                  value={category}
                  placeholder={t('category')}
                  aria-label={t('category')}
                  onChange={(event) => { setCategory(event.currentTarget.value) }}
                />
              </label>
              <label className={css.field}>
                <span className={css.visuallyHidden}>{t('capability')}</span>
                <input
                  type="text"
                  value={capability}
                  placeholder={t('capability')}
                  aria-label={t('capability')}
                  onChange={(event) => { setCapability(event.currentTarget.value) }}
                />
              </label>
              <button
                type="button"
                className={css.button}
                disabled={source === undefined}
                onClick={() => {
                  /* v8 ignore next -- disabled arm: the button is disabled when source is undefined. */
                  if (source !== undefined) void runSearch(String(source.id))
                }}
              >
                {t('searchButton')}
              </button>
            </div>

            {searchError !== undefined ? (
              <p className={`${css.status} ${css.failureText}`} role="alert">{searchError}</p>
            ) : null}

            <div className={css.catalog}>
              {page === undefined ? null : page.items.length === 0 ? (
                <p className={css.status}>{t('empty')}</p>
              ) : visibleItems.length === 0 ? (
                <p className={css.status}>{t('emptySearch')}</p>
              ) : (
                <ul className={css.cards} data-result-count={visibleItems.length}>
                  {visibleItems.map(item => (
                    <li className={css.card} key={item.id} data-package={item.package}>
                      <strong className={css.cardTitle} title={item.package}>{item.name}</strong>
                      <span className={css.cardVersion}>{item.package}@{item.version}</span>
                      <span className={css.cardDescription}>{item.description}</span>
                      <span className={css.cardMeta}>
                        <span className={css.configTag} data-source>{item.source}</span>
                        {item.category ? <span className={css.configTag}>{item.category}</span> : null}
                        {(item.capability ?? []).map(cap => (
                          <span className={css.configTag} key={cap}>{cap}</span>
                        ))}
                      </span>
                      <button
                        type="button"
                        className={css.button}
                        data-preview-ref={`${item.package}@${item.version}`}
                        onClick={() => { void runPreview(`${item.package}@${item.version}`) }}
                      >
                        {t('preview')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className={css.block}>
            <h3 className={css.blockTitle}>{t('preview')}</h3>
            <div className={css.searchRow}>
              <label className={css.field}>
                <span className={css.visuallyHidden}>{t('preview')}</span>
                <input
                  type="text"
                  value={ref}
                  placeholder={t('previewPlaceholder')}
                  aria-label={t('preview')}
                  onChange={(event) => { setRef(event.currentTarget.value) }}
                />
              </label>
              <button
                type="button"
                className={css.button}
                disabled={ref.trim().length === 0 || previewState.status === 'pending'}
                onClick={() => { void runPreview(ref.trim()) }}
              >
                {previewState.status === 'pending' ? t('previewing') : t('preview')}
              </button>
            </div>
            {previewState.status === 'ready' ? (
              <div className={css.preview} data-preview-verified={previewState.preview.verified ? 'true' : 'false'}>
                <p className={css.status}>
                  {previewState.preview.verified ? t('verified') : t('previewRejected')}
                  {previewState.preview.compatible ? ` · ${t('version')} ${previewState.preview.version}` : ''}
                </p>
                {previewState.preview.reasons.length > 0 ? (
                  <ul className={css.reasons}>
                    {previewState.preview.reasons.map(reason => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : previewState.status === 'rejected' ? (
              <p className={`${css.status} ${css.failureText}`} role="alert">{t('previewRejected')}</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  )
}
