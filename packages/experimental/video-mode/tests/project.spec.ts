/**
 * Project document behavior: id derivation for ASCII and non-ASCII titles,
 * schema failures, filesystem round-trips, shot mutations, renders, and cost
 * aggregation.
 */

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { FsError, FsVersion } from '@deepseek-ai/dsh-fs'
import {
  missingShotClips,
  mutateProjectFile,
  newProject,
  parseProject,
  projectCost,
  projectPathFor,
  readProject,
  readProjectText,
  recordRender,
  removeShot,
  serializeProject,
  slugify,
  upsertShot,
  validateProject,
  withProjectLock,
  writeProject,
} from '../src/index.ts'

let root: string
let ctx: Context

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-project-')))
  ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: root }).await()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('project ids', () => {
  it('derives readable ids from ASCII and accented titles', () => {
    expect(slugify('One Shot')).toBe('one-shot')
    expect(slugify('  Café  Noir  ')).toBe('cafe-noir')
    expect(slugify('***')).toMatch(/^video-[0-9a-f]{8}$/)
  })

  it('derives a stable hash id for a Chinese title', () => {
    const first = slugify('春日短片')
    expect(first).toBe(slugify('春日短片'))
    expect(first).toMatch(/^video-[0-9a-f]{8}$/)
    expect(slugify('夏日短片')).not.toBe(first)
    expect(newProject({ title: '春日短片' }).id).toBe(first)
  })

  it('rejects an explicit id that the document schema cannot store', () => {
    expect(() => newProject({ title: 'x', id: 'Not A Slug' })).toThrow(/invalid video project/)
    expect(() => newProject({ title: '   ' })).toThrow(/invalid video project: title/)
  })
})

describe('project store', () => {
  it('writes and reads a project through the Session filesystem', async () => {
    const project = newProject({ title: 'Round Trip', aspect: '16:9', targetSeconds: 30, budgetCny: 12 })
    const path = projectPathFor(root, project.id)
    await writeProject(ctx, path, project, root)
    const read = await readProject(ctx, path, root)
    expect(read).toEqual(project)
  })

  it('refuses to initialize over an existing project document', async () => {
    const project = newProject({ title: 'Once' })
    const path = projectPathFor(root, project.id)
    await writeProject(ctx, path, project, root)
    await expect(writeProject(ctx, path, project, root)).rejects.toMatchObject({ code: 'FS_NOT_OBSERVED' })
  })

  it('reports a missing project with the init remedy', async () => {
    await expect(readProject(ctx, 'video/missing/project.json', root)).rejects.toThrow(/run video_project init first/)
  })

  it('propagates a read failure that is not a missing file', async () => {
    await writeFile(join(root, 'project.json'), serializeProject(newProject({ title: 'Read failure' })))
    const original = ctx.fs.readText.bind(ctx.fs)
    ctx.fs.readText = async () => { throw new FsError('permission denied', 'FS_IO_ERROR') }
    await expect(readProject(ctx, 'project.json', root)).rejects.toThrow(/permission denied/)
    ctx.fs.readText = async () => { throw new Error('transport down') }
    await expect(readProject(ctx, 'project.json', root)).rejects.toThrow(/transport down/)
    ctx.fs.readText = original
  })

  it('reports a project deleted between the stat and the read', async () => {
    await writeFile(join(root, 'project.json'), serializeProject(newProject({ title: 'Gone' })))
    const original = ctx.fs.readText.bind(ctx.fs)
    ctx.fs.readText = async () => { throw new FsError('gone', 'FS_NOT_FOUND') }
    try {
      await expect(readProject(ctx, 'project.json', root)).rejects.toThrow(/run video_project init first/)
    } finally {
      ctx.fs.readText = original
    }
  })

  it('propagates a write failure that is not a version conflict', async () => {
    const io = {
      path: 'project.json',
      read: async () => ({ text: serializeProject(newProject({ title: 'Disk' })), version: FsVersion('v1') }),
      write: async () => { throw new Error('disk full') },
    }
    await expect(mutateProjectFile(io, project => project)).rejects.toThrow('disk full')
  })

  it('reports malformed JSON and a document that fails schema validation', async () => {
    await writeFile(join(root, 'broken.json'), '{')
    await expect(readProject(ctx, 'broken.json', root)).rejects.toMatchObject({ code: 'MEDIA_PROJECT_INVALID' })
    await writeFile(join(root, 'wrong.json'), JSON.stringify({ schemaVersion: 1 }))
    await expect(readProject(ctx, 'wrong.json', root)).rejects.toThrow(/invalid video project/)
    expect(() => validateProject({ nope: true })).toThrow(/invalid video project/)
  })

  it('upserts by id, sorts by index, removes shots, and records renders', () => {
    const base = newProject({ title: 'Edit' })
    const second = upsertShot(base, { id: 's02', index: 2, prompt: 'two', durationSec: 1, status: 'draft' })
    const first = upsertShot(second, { id: 's01', index: 1, prompt: 'one', durationSec: 1, status: 'ready', clipPath: 'a.mp4', costCny: 2 })
    expect(first.shots.map(shot => shot.id)).toEqual(['s01', 's02'])
    const tied = upsertShot(
      upsertShot(first, { id: 'b', index: 3, prompt: 'b', durationSec: 1, status: 'draft' }),
      { id: 'a', index: 3, prompt: 'a', durationSec: 1, status: 'draft' },
    )
    expect(tied.shots.slice(-2).map(shot => shot.id)).toEqual(['a', 'b'])
    const replaced = upsertShot(first, { id: 's02', index: 2, prompt: 'two revised', durationSec: 2, status: 'ready', costCny: 3 })
    expect(replaced.shots).toHaveLength(2)
    expect(replaced.shots[1]?.prompt).toBe('two revised')
    expect(missingShotClips(replaced)).toEqual(['s02'])
    expect(projectCost(replaced)).toBe(5)

    const removed = removeShot(replaced, 's02')
    expect(removed.shots.map(shot => shot.id)).toEqual(['s01'])
    expect(() => removeShot(removed, 's02')).toThrow(/does not exist/)

    const rendered = recordRender(removed, { id: 'r1', path: 'out/final.mp4', createdAt: '2026-01-01T00:00:00.000Z', costCny: 1 })
    expect(rendered.renders).toHaveLength(1)
    const rerendered = recordRender(rendered, { id: 'r1', path: 'out/final-v2.mp4', createdAt: '2026-01-02T00:00:00.000Z' })
    expect(rerendered.renders).toHaveLength(1)
    expect(rerendered.renders[0]?.path).toBe('out/final-v2.mp4')
  })
})

describe('project concurrency', () => {
  it('reads and serializes documents with the shared helpers', async () => {
    const project = newProject({ title: 'Round Trip' })
    const text = serializeProject(project)
    expect(parseProject(text, 'project.json')).toEqual(project)
    await writeFile(join(root, 'round.json'), text)
    expect(await readProjectText(ctx, 'round.json', root)).toBe(text)
    await expect(readProjectText(ctx, 'absent.json', root)).rejects.toMatchObject({ code: 'MEDIA_PROJECT_INVALID' })
    expect(() => parseProject('{', 'broken.json')).toThrow(/not valid JSON/)
  })

  it('republishes against the newer document when the guarded write loses the race', async () => {
    const base = newProject({ title: 'Retry' })
    const concurrent = serializeProject(recordRender(base, {
      id: 'r1', path: 'out/other.mp4', createdAt: '2026-01-01T00:00:00.000Z',
    }))
    let reads = 0
    let written = ''
    const result = await mutateProjectFile({
      path: 'project.json',
      read: async () => {
        reads += 1
        return reads === 1
          ? { text: serializeProject(base), version: FsVersion('v1') }
          : { text: concurrent, version: FsVersion('v2') }
      },
      write: async (text, version) => {
        if (version === FsVersion('v1')) throw new FsError('stale', 'FS_STALE_VERSION')
        written = text
      },
    }, project => upsertShot(project, { id: 's01', index: 1, prompt: 'one', durationSec: 1, status: 'draft' }))

    expect(reads).toBe(2)
    expect(result.shots).toHaveLength(1)
    expect(result.renders).toHaveLength(1)
    const saved = parseProject(written, 'project.json')
    expect(saved.shots.map(shot => shot.id)).toEqual(['s01'])
    expect(saved.renders.map(render => render.id)).toEqual(['r1'])
  })

  it('fails loud after the attempt budget when the document keeps moving', async () => {
    let reads = 0
    const io = {
      path: 'project.json',
      read: async () => {
        reads += 1
        return {
          text: serializeProject(recordRender(newProject({ title: 'Moving' }), {
            id: `r${reads}`, path: `out/${reads}.mp4`, createdAt: '2026-01-01T00:00:00.000Z',
          })),
          version: FsVersion(`v${reads}`),
        }
      },
      write: async () => { throw new FsError('stale', 'FS_STALE_VERSION') },
    }
    await expect(mutateProjectFile(io, project => project, 3)).rejects.toMatchObject({ code: 'MEDIA_PROJECT_CONFLICT' })
    expect(reads).toBe(3)
  })

  it('serializes writers per project and releases the lock after a failure', async () => {
    const order: string[] = []
    const first = withProjectLock('lock-a', async () => {
      order.push('first-start')
      await delay(5)
      order.push('first-end')
    })
    const second = withProjectLock('lock-a', async () => { order.push('second') })
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])

    await expect(withProjectLock('lock-b', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withProjectLock('lock-b', async () => 'after')).resolves.toBe('after')
  })
})
