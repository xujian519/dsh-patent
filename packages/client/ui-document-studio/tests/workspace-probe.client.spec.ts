/**
 * Workspace probes: the freshness tokens the stale-verdict marker compares, and
 * the unregistered deliverable files the empty state reports.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDirectoryEntry } from '@deepseek-ai/dsh-api-workspace-files/types'
import {
  createWorkspaceProbe, type WorkspaceProbeRemote,
} from '../src/client/workspace-probe.ts'

type Files = Readonly<Record<string, readonly WorkspaceDirectoryEntry[]>>

const sessionId = 's1' as SessionId

function directory(entries: Files): WorkspaceProbeRemote['list'] {
  return async (_session, path) => {
    const value = entries[path]
    if (value === undefined) {
      throw new RemoteError('workspace-file/not-found', `no entry at "${path}"`, { path })
    }
    return { ok: true, value: { path, entries: value, truncated: false } }
  }
}

function probe(files: Files, resolve: (path: string) => string = path => path) {
  const remote: WorkspaceProbeRemote = {
    stat: async (_session, path) => {
      if (path === 'missing.md') {
        return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
      }
      return { ok: true, value: { absolutePath: `/ws/${path}`, version: `v-${path}` } }
    },
    list: directory(files),
  }
  return { remote, probe: createWorkspaceProbe(remote, sessionId, resolve) }
}

describe('statVersions', () => {
  it('reports the Host version per readable path and omits failures', async () => {
    const { remote, probe: workspace } = probe({})
    const stat = vi.spyOn(remote, 'stat')
    const versions = await workspace.statVersions(['out/report.md', 'missing.md'])
    expect(versions).toEqual({ 'out/report.md': 'v-out/report.md' })
    expect(stat).toHaveBeenCalledTimes(2)
  })

  it('resolves each produced path against the Session workspace', async () => {
    const { remote, probe: workspace } = probe({}, path => `/abs/${path}`)
    const stat = vi.spyOn(remote, 'stat')
    await workspace.statVersions(['out/report.md'])
    expect(stat).toHaveBeenCalledWith(sessionId, '/abs/out/report.md', expect.any(AbortSignal))
  })
})

describe('unregisteredDeliverables', () => {
  const files: Files = {
    '.': [
      { name: 'brief.md', type: 'file' },
      { name: 'notes.txt', type: 'file' },
      { name: 'index.html', type: 'file' },
      { name: 'out', type: 'directory' },
      { name: 'node_modules', type: 'directory' },
      { name: 'spec.pdf', type: 'other' },
    ],
    out: [
      { name: 'report.docx', type: 'file' },
      { name: 'deck.pptx', type: 'file' },
      { name: 'sub', type: 'directory' },
    ],
    'out/sub': [
      { name: 'appendix.pdf', type: 'file' },
      { name: 'deeper', type: 'directory' },
    ],
    'out/sub/deeper': [
      { name: 'deep.md', type: 'file' },
    ],
    node_modules: [
      { name: 'readme.md', type: 'file' },
    ],
  }

  it('reports deliverable files two levels deep and skips other types and skipped directories', async () => {
    const { probe: workspace } = probe(files)
    expect(await workspace.unregisteredDeliverables([])).toEqual([
      'brief.md',
      'index.html',
      'out/report.docx',
      'out/deck.pptx',
      'out/sub/appendix.pdf',
    ])
  })

  it('lists the workspace root as "." because the Host refuses an empty path', async () => {
    const { remote, probe: workspace } = probe(files)
    const list = vi.spyOn(remote, 'list')
    await workspace.unregisteredDeliverables([])
    expect(list).toHaveBeenCalledWith(sessionId, '.', expect.any(AbortSignal))
  })

  it('excludes paths the session already lists, with or without a ./ prefix', async () => {
    const { probe: workspace } = probe(files)
    expect(await workspace.unregisteredDeliverables([{ path: './brief.md' }, { path: 'out/report.docx' }])).toEqual([
      'index.html',
      'out/deck.pptx',
      'out/sub/appendix.pdf',
    ])
  })

  it('excludes a file listed under a different spelling of its canonical identity', async () => {
    // The real wiring resolves relative paths against the Session workspace and
    // passes absolute ones through, exactly like resolveWorkspacePath.
    const { probe: workspace } = probe(files, path => (path.startsWith('/') ? path : `/ws/${path}`))
    // The log declared the relative spelling, but the mutation tool resolved
    // the file to its absolute path: the same file, so not a candidate.
    expect(await workspace.unregisteredDeliverables([
      { path: 'out/report.docx', identity: '/ws/out/report.docx' },
    ])).toEqual([
      'brief.md',
      'index.html',
      'out/deck.pptx',
      'out/sub/appendix.pdf',
    ])
  })

  it('matches on the identity alone when the declared spelling names no listed file', async () => {
    const { probe: workspace } = probe(files, path => (path.startsWith('/') ? path : `/ws/${path}`))
    // The declaration used the other file's spelling, but the identity is the
    // one the mutation resolved: the bytes, not the declaration, decide.
    expect(await workspace.unregisteredDeliverables([
      { path: './elsewhere/report.docx', identity: '/ws/out/report.docx' },
    ])).toEqual([
      'brief.md',
      'index.html',
      'out/deck.pptx',
      'out/sub/appendix.pdf',
    ])
  })

  it('skips hidden directories and stops at the candidate cap', async () => {
    const root: WorkspaceDirectoryEntry[] = [{ name: '.hidden', type: 'directory' }]
    for (let index = 0; index < 45; index += 1) {
      const name = `file-${String(index)}.md`
      root.push({ name, type: 'file' })    }
    const many: Files = { '.': root, '.hidden': [{ name: 'secret.md', type: 'file' }] }
    const { probe: workspace } = probe(many)
    const found = await workspace.unregisteredDeliverables([])
    expect(found).toHaveLength(40)
    expect(found).not.toContain('.hidden/secret.md')
  })

  it('bounds how many directories it lists', async () => {
    const root: WorkspaceDirectoryEntry[] = []
    const entries: Record<string, readonly WorkspaceDirectoryEntry[]> = { '.': root }
    for (let index = 0; index < 30; index += 1) {
      const name = `dir-${String(index)}`
      root.push({ name, type: 'directory' })
      entries[name] = [{ name: 'doc.md', type: 'file' }]
    }
    const many: Files = entries
    const { probe: workspace } = probe(many)
    // The root is always listed first, then MAX_DIRECTORIES-1 children.
    expect(await workspace.unregisteredDeliverables([])).toHaveLength(23)
  })

  it('fails loudly when the workspace root cannot be listed', async () => {
    const remote: WorkspaceProbeRemote = {
      stat: async () => { throw new Error('unused') },
      list: async (_session, path) => ({
        ok: false,
        error: new RemoteError('workspace-file/outside-workspace', `"${path}" is outside`, { path }),
      }),
    }
    const workspace = createWorkspaceProbe(remote, sessionId, path => path)
    await expect(workspace.unregisteredDeliverables([])).rejects.toThrow('is outside')
  })
})
