// @vitest-environment jsdom
/**
 * PreviewPane behavior: the file resource's version drives reloads, automatic
 * refresh can pause, the manual reload still reads, a deleted file keeps its
 * last content, and the inline HTML cap avoids building a frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ResourceSnapshot, UseResource } from '@deepseek-ai/dsh-client-resources/client'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { CompleteReadText, ReadFileText } from '../src/client/file-reads.ts'
import { WorkspaceReadError } from '../src/client/file-reads.ts'
import { PreviewPane, type PreviewPaneProps } from '../src/client/PreviewPane.tsx'
import { en, zh } from '../src/client/locales.ts'
// Type-only: pulls the LocaleNamespaceMap augmentation into this program.
import type {} from '../src/client/index.ts'

const t: PreviewPaneProps['t'] = makeTranslate(zh, en)

/** The failure frame a resource reports. */
type ResourceFailure = NonNullable<ResourceSnapshot<WorkspaceFileStat>['failure']>

/** A live file stat at one version. */
function live(version: string, bytes?: number): ResourceSnapshot<WorkspaceFileStat> {
  return {
    status: 'live',
    value: { absolutePath: '/w/out/a.md', version, ...bytes === undefined ? {} : { bytes } },
    failure: undefined,
  }
}

/** A resource whose provider never resolved an address. */
const NONE: ResourceSnapshot<WorkspaceFileStat> = { status: 'none', value: undefined, failure: undefined }

/** A failed stat for a file that is gone. */
const GONE: ResourceSnapshot<WorkspaceFileStat> = {
  status: 'failed',
  value: undefined,
  failure: new RemoteError('workspace-file/not-found', 'no entry', { path: 'out/a.md' }),
}

interface HarnessProps extends Omit<PreviewPaneProps, 'useResource'> {
  readonly resource: ResourceSnapshot<WorkspaceFileStat>
}

/**
 * Render the pane with one resource snapshot; a rerender supplies the next.
 * @param props - pane props plus the snapshot this render reads.
 * @returns the rendered pane.
 */
function Harness({ resource, ...props }: HarnessProps): ReactNode {
  const useResource = (() => resource) as UseResource
  return <PreviewPane {...props} useResource={useResource} />
}

/** The pane's stable props for one markdown file. */
function props(overrides: Partial<PreviewPaneProps> = {}): Omit<PreviewPaneProps, 'useResource'> {
  return {
    path: 'out/a.md',
    address: 'dsh-resource://file/session/s1/out/a.md',
    autoRefresh: true,
    reloadToken: 0,
    readFileText: vi.fn((_path: string): Promise<ReadFileText> =>
      Promise.resolve({ content: '# A', truncated: false })),
    readFileTextComplete: vi.fn((_path: string): Promise<CompleteReadText> =>
      Promise.resolve({ truncated: false, content: '<h1>A</h1>' })),
    htmlPreviewMaxBytes: 1024,
    canOpenInSidebar: true,
    openInSidebar: vi.fn(() => true),
    insertDraft: vi.fn(() => true),
    t,
    ...overrides,
  }
}

afterEach(cleanup)

describe('PreviewPane', () => {
  it('reads on mount and again when the file version moves', async () => {
    const readFileText = vi.fn((_path: string): Promise<ReadFileText> =>
      Promise.resolve({ content: '# v1', truncated: false }))
    const base = props({ readFileText })
    const { rerender } = render(<Harness {...base} resource={live('v1')} />)
    expect(await screen.findByRole('heading', { name: 'v1' })).toBeTruthy()
    readFileText.mockResolvedValue({ content: '# v2', truncated: false })
    rerender(<Harness {...base} resource={live('v2')} />)
    expect(await screen.findByRole('heading', { name: 'v2' })).toBeTruthy()
    expect(readFileText).toHaveBeenCalledTimes(2)
  })

  it('does not re-read a version it already holds', async () => {
    const readFileText = vi.fn((_path: string): Promise<ReadFileText> =>
      Promise.resolve({ content: '# A', truncated: false }))
    const base = props({ readFileText })
    const { rerender } = render(<Harness {...base} resource={live('v1')} />)
    await screen.findByRole('heading', { name: 'A' })
    rerender(<Harness {...base} resource={live('v1')} />)
    await waitFor(() => { expect(readFileText).toHaveBeenCalledTimes(1) })
  })

  it('holds the last content while automatic refresh is paused and reloads on demand', async () => {
    const readFileText = vi.fn((_path: string): Promise<ReadFileText> =>
      Promise.resolve({ content: '# first', truncated: false }))
    const base = props({ readFileText, autoRefresh: false })
    const { rerender } = render(<Harness {...base} resource={live('v1')} />)
    await screen.findByRole('heading', { name: 'first' })
    readFileText.mockResolvedValue({ content: '# second', truncated: false })
    rerender(<Harness {...base} resource={live('v2')} />)
    expect(await screen.findByText(t('studio.preview.changed'))).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'first' })).toBeTruthy()
    expect(readFileText).toHaveBeenCalledTimes(1)
    rerender(<Harness {...base} reloadToken={1} resource={live('v2')} />)
    expect(await screen.findByRole('heading', { name: 'second' })).toBeTruthy()
    expect(readFileText).toHaveBeenCalledTimes(2)
  })

  it('keeps the last content and says the file is gone', async () => {
    const base = props()
    const { rerender } = render(<Harness {...base} resource={live('v1')} />)
    await screen.findByRole('heading', { name: 'A' })
    rerender(<Harness {...base} resource={GONE} />)
    expect(await screen.findByText(t('studio.preview.deleted'))).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'A' })).toBeTruthy()
  })

  it('renders a file it could not stat instead of leaving the pane loading', async () => {
    const failure: ResourceFailure = new RemoteError('workspace-file/outside-workspace', 'outside', { path: 'out/a.md' })
    render(<Harness {...props()} resource={{ status: 'failed', value: undefined, failure }} />)
    expect(await screen.findByText(t('studio.error.denied'))).toBeTruthy()
  })

  it('refuses an HTML file above the configured cap without reading it', async () => {
    const readFileTextComplete = vi.fn((_path: string): Promise<CompleteReadText> =>
      Promise.resolve({ truncated: false, content: '<h1>A</h1>' }))
    render(
      <Harness
        {...props({ path: 'out/a.html', readFileTextComplete })}
        resource={live('v1', 2048)}
      />,
    )
    expect(await screen.findByText(t('studio.preview.tooLarge', { limit: '1.0KB' }))).toBeTruthy()
    expect(readFileTextComplete).not.toHaveBeenCalled()
  })

  it('waits for the stat before reading an HTML file', async () => {
    const readFileTextComplete = vi.fn(() => Promise.resolve({ truncated: false as const, content: '<h1>A</h1>' }))
    const base = props({ path: 'out/a.html', readFileTextComplete })
    const { rerender } = render(<Harness {...base} resource={{ status: 'loading', value: undefined, failure: undefined }} />)
    expect(screen.queryByTitle('a.html')).toBeNull()
    rerender(<Harness {...base} resource={live('v1', 20)} />)
    expect(await screen.findByTitle('a.html')).toBeTruthy()
    expect(readFileTextComplete).toHaveBeenCalledTimes(1)
  })

  it('localizes a read failure and offers the sidebar handoff for a binary file', async () => {
    const readFileText = vi.fn(() => Promise.reject(
      new WorkspaceReadError('gone', 'workspace-file/not-found'),
    ))
    const { rerender } = render(<Harness {...props({ readFileText })} resource={live('v1')} />)
    expect(await screen.findByText(t('studio.error.notFound'))).toBeTruthy()
    rerender(<Harness {...props({ path: 'out/a.docx' })} resource={NONE} />)
    expect(await screen.findByText(t('studio.preview.sidebarOnly'))).toBeTruthy()
    expect(screen.queryByText(t('studio.action.previewSidebar'))).toBeTruthy()
  })
})
