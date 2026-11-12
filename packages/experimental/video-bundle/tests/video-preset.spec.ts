/**
 * The video preset must keep the production contract that the mode's skills
 * rely on: one video-mode row with the local ComfyUI provider enabled, the six
 * production skills mounted, the budget and confirmation threshold in the
 * persona, and no second deliverable channel (`present`). This spec reads the
 * shipped declaration; the tool and service behavior is covered by
 * `@deepseek-ai/dsh-video-mode`'s own tests.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const PRESET = join(REPO_ROOT, 'packages/experimental/video-bundle/presets/video.patch.yml')
const SKILLS = join(REPO_ROOT, 'packages/experimental/video-bundle/skills/video')

/** One preset row: the fields this spec reads. */
interface PresetRow {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
}

/**
 * Find one row by id anywhere in the preset declaration.
 * @param node - a preset node, list, or scalar.
 * @param id - row id to find.
 * @returns the row, or undefined.
 */
function findRow(node: unknown, id: string): PresetRow | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRow(child, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null) return undefined
  const row = node as Record<string, unknown>
  if (row['id'] === id) return row
  for (const value of Object.values(row)) {
    const found = findRow(value, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** Load the shipped preset. */
async function loadPreset(): Promise<unknown> {
  return yaml.load(await readFile(PRESET, 'utf8'), { schema: entryListSchema })
}

/** Read one row's config object. */
function configOf(row: PresetRow | undefined): Record<string, unknown> {
  return objectOf(row?.config)
}

/** Read an object value, or an empty object for anything else. */
function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

describe('video preset declaration', () => {
  it('declares the video mode id, name, and order', async () => {
    const preset = findRow(await loadPreset(), 'preset-video')
    const config = configOf(preset)
    expect(config['id']).toBe('video')
    expect(config['name']).toBe('视频模式')
    expect(config['order']).toBe(8)
  })

  it('mounts one video-mode row with cloud H3 video and local keyframes, and no second delivery channel', async () => {
    const preset = await loadPreset()
    const row = findRow(preset, 'video-mode')
    expect(row?.name).toBe('@deepseek-ai/dsh-video-mode')
    expect(row?.disabled).toBeUndefined()
    const config = configOf(row)
    expect(config['fakeProvider']).toBe(false)
    expect(config['videoModel']).toBe('MiniMax-H3')
    expect(config['imageModel']).toBe('z-image-turbo')
    expect(config['speechModel']).toBe('speech-2.8-turbo')
    expect(config['ffmpegPath']).toBe('ffmpeg')
    const comfyui = objectOf(config['comfyui'])
    expect(comfyui['enabled']).toBe(true)
    expect(comfyui['baseUrl']).toBe('http://127.0.0.1:8188')
    expect(objectOf(comfyui['video'])['resolution']).toBe('480p')
    const minimax = objectOf(config['minimax'])
    expect(minimax['enabled']).toBe(true)
    expect(minimax['apiKeyEnv']).toBe('MINIMAX_API_KEY')
    expect(minimax['baseUrl']).toBe('https://api.minimax.cn')
    expect(minimax['resolution']).toBe('768P')
    const speech = objectOf(minimax['speech'])
    expect(speech['enabled']).toBe(true)
    expect(speech['model']).toBe('speech-2.8-turbo')
    expect(speech['voiceId']).toBe('Chinese (Mandarin)_News_Anchor')
    const siliconflow = objectOf(config['siliconflow'])
    expect(siliconflow['enabled']).toBe(true)
    expect(siliconflow['apiKeyEnv']).toBe('SILICONFLOW_API_KEY')
    expect(siliconflow['baseUrl']).toBe('https://api.siliconflow.cn/v1')
    expect(siliconflow['model']).toBe('Wan-AI/Wan2.2-I2V-A14B')
    expect(siliconflow['aspectRatio']).toBe('9:16')
    expect(siliconflow['pricePerVideo']).toBe(2)
    expect(siliconflow['currency']).toBe('CNY')
    expect(findRow(preset, 'present')).toBeUndefined()
  })

  it('names the budget and the single-generation confirmation threshold in the persona', async () => {
    const persona = configOf(findRow(await loadPreset(), 'persona'))['prefix']
    expect(typeof persona).toBe('string')
    const text = persona as string
    expect(text).toContain('50 元')
    expect(text).toContain('10 元')
    expect(text).toContain('关键帧优先')
    expect(text).toContain('video_deliver')
  })

  it('mounts the six production skills from the shipped directory', async () => {
    const entries = await readdir(SKILLS, { withFileTypes: true })
    const skillDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    expect(skillDirs).toEqual([
      'video-assemble',
      'video-brief',
      'video-deliver',
      'video-generate',
      'video-storyboard',
      'video-voice',
    ])
    for (const dir of skillDirs) {
      const source = await readFile(join(SKILLS, dir, 'SKILL.md'), 'utf8')
      expect(source, `${dir} frontmatter`).toContain(`name: ${dir}`)
    }
  })
})
