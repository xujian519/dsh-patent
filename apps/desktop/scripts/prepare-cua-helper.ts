/** Ensure a macOS Desktop payload carries the Computer Use helper its bundled provider requires. */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { execa } from 'execa'
import { nativeExecutablePath } from '../../../packages/experimental/cua-macos/src/native-build.ts'
import { CUA_MANIFEST } from '../../../scripts/cua-helper/payload.ts'
import { pnpmCommand } from '../../../scripts/release/process.ts'

/** Staging outcome for one Desktop build. */
export type CuaHelperPlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'present' }
  | { readonly kind: 'official' }
  | { readonly kind: 'development' }
  | { readonly kind: 'unavailable' }

/**
 * Decide how a Desktop build obtains the Computer Use helper.
 * A checkout that already staged a helper keeps it; otherwise a release build uses the notarized artifact pipeline and
 * an unsigned local build compiles the development variant.
 * @param input - Target platform, whether the packed dsh ships the bundle, and what the checkout already holds.
 * @returns The staging outcome; a `skip` reason explains why no helper is needed.
 */
export function planCuaHelper(input: {
  platform: NodeJS.Platform
  shipsCuaBundle: boolean
  receiptPresent: boolean
  officialPayloadPresent: boolean
  development: boolean
}): CuaHelperPlan {
  if (input.platform !== 'darwin') return { kind: 'skip', reason: 'the target platform is not macOS' }
  if (!input.shipsCuaBundle) return { kind: 'skip', reason: 'the packed dsh does not ship Computer Use' }
  if (input.officialPayloadPresent) return { kind: 'present' }
  if (input.receiptPresent) return { kind: 'present' }
  return input.development ? { kind: 'development' } : { kind: 'unavailable' }
}

async function installedExecutable(directory: string): Promise<string | undefined> {
  for (const variant of ['release', 'dev'] as const) {
    try { return await nativeExecutablePath(directory, variant) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arch: { type: 'string' },
      development: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const arch = values.arch
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('desktop CUA helper: --arch must be arm64 or x64')
  const root = resolve(import.meta.dirname, '../../..')
  const packageRoot = join(root, 'packages/experimental/cua-macos')
  const directory = join(packageRoot, 'native', 'bin', `darwin-${arch}`)
  const cli = JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const plan = planCuaHelper({
    platform: (process.env.DSH_DESKTOP_TARGET_PLATFORM ?? process.platform) as NodeJS.Platform,
    shipsCuaBundle: cli.dependencies?.['@deepseek-ai/dsh-cua-bundle'] !== undefined,
    receiptPresent: existsSync(join(directory, 'current.json')),
    officialPayloadPresent: existsSync(join(packageRoot, CUA_MANIFEST)) && existsSync(join(directory, 'current.json')),
    development: values.development ?? false,
  })
  if (plan.kind === 'skip') {
    console.log(`desktop CUA helper: skipped because ${plan.reason}`)
    return
  }
  if (plan.kind === 'present') {
    const executable = await installedExecutable(directory)
    if (executable === undefined) throw new Error(`desktop CUA helper: ${directory} holds a receipt without a usable application`)
    console.log(`desktop CUA helper: reusing ${executable}`)
    return
  }
  if (plan.kind === 'unavailable') {
    throw new Error('desktop CUA helper: this release build ships Computer Use without a staged helper. '
      + 'Stage the notarized artifact with scripts/cua-helper/package.ts and scripts/cua-helper/stage.ts, '
      + 'or package a local artifact with --unsigned to compile the development variant.')
  }
  if (plan.kind === 'development') {
    await execa('/usr/bin/xcrun', ['python3', join(packageRoot, 'native', 'build_app.py'),
      '--output-directory', directory, '--arch', arch === 'x64' ? 'x86_64' : 'arm64',
      '--variant', 'dev', '--identity', '-'], { cwd: root, stdio: 'inherit' })
    console.log(`desktop CUA helper: staged the development application in ${directory}`)
  } else {
    const output = join(root, 'dist', 'cua-helper')
    rmSync(output, { recursive: true, force: true })
    const [pnpm, ...prefix] = pnpmCommand()
    await execa(pnpm, [...prefix, 'exec', 'tsx', 'scripts/cua-helper/package.ts', '--out', output], { cwd: root, stdio: 'inherit' })
    const extracted = join(output, 'extracted')
    mkdirSync(extracted, { recursive: true })
    await execa('tar', ['-xzf', join(output, 'cua-helper.tgz'), '-C', extracted], { cwd: root, stdio: 'inherit' })
    await execa(pnpm, [...prefix, 'exec', 'tsx', 'scripts/cua-helper/stage.ts', '--from', extracted], { cwd: root, stdio: 'inherit' })
    console.log(`desktop CUA helper: staged the notarized application in ${directory}`)
  }
  const executable = await installedExecutable(directory)
  if (executable === undefined) throw new Error(`desktop CUA helper: staging did not produce a usable application in ${directory}`)
  console.log(`desktop CUA helper: prepared ${executable}`)
}

if (import.meta.main) await main()
