/**
 * Production client composition without the page: mount the Loader over a
 * module system, create every manifest row, wait for quiescence, and audit
 * activation. `AppWebEntry` and the whole-client test carrier both call it.
 * @module @deepseek-ai/dsh-client-web/src/boot-client
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { BootManifest, BootPluginRow, ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import { STATE_LABELS } from './loader-status.ts'

/** Entry state label as the boot page renders it. */
export type EntryStateLabel = (typeof STATE_LABELS)[keyof typeof STATE_LABELS] | 'loading' | 'failed'

/** Inputs of {@link bootClient}. */
interface ClientBootOptions {
  /** Fresh root Context that will own the plugin tree. */
  readonly ctx: Context
  /** Module system installed as `loader.internal`. */
  readonly modules: ClientModuleLoader
  /** Parsed manifest whose `plugins` rows become Loader entries (entry name = row id). */
  readonly manifest: BootManifest
  /** Per-entry state reporting (the boot page); omitted when no one renders progress. */
  readonly onEntryState?: (name: string, state: EntryStateLabel) => void
}

/**
 * Compose the client: `ctx.plugin(Loader)`, `loader.internal = modules`, one
 * `loader.create({ name })` per manifest row, `loader.await()`, then
 * {@link auditClientActivation}. A row whose module cannot be imported is
 * marked failed; the Loader logs its import error, the module system records
 * it, and the audit names that error text in its report.
 * @param options - context, module system, manifest, optional progress sink.
 * @returns resolves after every required entry is active; rejects with the audit report otherwise.
 */
export async function bootClient(options: ClientBootOptions): Promise<void> {
  const { ctx, manifest, onEntryState } = options
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.internal = options.modules as never

  ctx.on('internal/status', (fiber) => {
    const entry = fiber.entry
    if (entry === undefined || entry.fiber === undefined) return
    onEntryState?.(entry.options.name, STATE_LABELS[entry.fiber.state])
  })

  const rows = manifest.plugins.map(row => row.id)
  for (const name of rows) onEntryState?.(name, 'loading')
  await options.modules.entries.start(loader, manifest)
  for (const entry of loader.entries()) {
    if (entry.fiber === undefined) onEntryState?.(entry.options.name, 'failed')
  }

  await loader.await()
  await auditClientActivation(ctx, options.modules, manifest.plugins)
}

/** One inactive Loader entry and the reason the audit names for it. */
interface InactiveEntry {
  name: string
  /** Row policy: an inactive required entry keeps the application from starting. */
  required: boolean
  detail: string
}

/**
 * Apply client startup policy to a settled Loader tree.
 *
 * An inactive required entry rejects startup with every inactive entry named.
 * A row the active profile installed is optional: its inactivity warns instead,
 * because the application is usable without a plugin half the deployment does
 * not own, and Settings → Plugins carries the client synchronization failure
 * and its retry.
 * @param ctx - root Context carrying the Loader.
 * @param modules - the module system whose recorded import failures name why an entry
 *   has no fiber; a row with no record points at the console.
 * @param rows - boot rows carrying the per-entry required marks.
 * @param warn - sink for optional-entry warnings.
 * @throws {Error} when a required entry is inactive, listing every inactive entry with its reason.
 */
export async function auditClientActivation(
  ctx: Context,
  modules: Pick<ClientModuleLoader, 'importError'>,
  rows: readonly BootPluginRow[],
  warn: (line: string) => void = warnToConsole,
): Promise<void> {
  // Rows outside the boot graph (a child plugin of an active row) are required here.
  const optionalRows = new Set(rows.filter(row => !row.required).map(row => row.id))
  const failures: InactiveEntry[] = []
  for (const entry of ctx.loader.entries()) {
    const name = entry.options.name
    const required = !optionalRows.has(name)
    if (entry.fiber === undefined) {
      const importError = modules.importError(name)
      failures.push({
        name,
        required,
        detail: importError === undefined
          ? 'import failed (see console for the import error)'
          : `import failed: ${importError.message}`,
      })
      continue
    }
    const state = STATE_LABELS[entry.fiber.state]
    if (state === 'active') continue
    if (state === 'pending') {
      const missing = Object.keys(entry.fiber.inject).filter(service => ctx.get(service) === undefined)
      failures.push({
        name,
        required,
        detail: `pending (waiting for service${missing.length === 1 ? '' : 's'}: ${missing.join(', ') || 'unknown'})`,
      })
      continue
    }
    failures.push({
      name,
      required,
      // Only a FAILED fiber carries the activation error that `await()` rethrows.
      detail: state === 'failed' ? `failed${await activationErrorDetail(entry.fiber)}` : state,
    })
  }
  const blocking = failures.filter(failure => failure.required)
  if (blocking.length > 0) {
    throw new Error([
      `web boot: ${String(blocking.length)} required ${blocking.length === 1 ? 'entry' : 'entries'} did not activate`,
      ...failures.map(inactiveDiagnostic),
    ].join('\n'))
  }
  if (failures.length > 0) {
    warn([
      `web boot: warning: ${String(failures.length)} ${failures.length === 1 ? 'entry' : 'entries'} did not activate`,
      ...failures.map(inactiveDiagnostic),
      '',
    ].join('\n'))
  }
}

/** Stable per-entry text for the boot report and optional warnings. */
function inactiveDiagnostic({ name, required, detail }: InactiveEntry): string {
  return `${name}${required ? ' (required)' : ''}: ${detail}`
}

/** Default optional-entry sink: the audit runs before any page surface owns the report. */
function warnToConsole(line: string): void {
  console.warn(line)
}

/**
 * Read the activation error the fiber failed with, one line of it: the report
 * reaches the boot page and the Desktop crash dialog, and the console already
 * carries the full stack through the Loader's own logging.
 * @param fiber - the failed fiber, whose settled error {@link Fiber.await} rethrows.
 * @returns the message prefixed with `: `, or `''` when the fiber carries none.
 */
async function activationErrorDetail(fiber: Fiber): Promise<string> {
  try {
    await fiber.await()
  } catch (error) {
    return `: ${error instanceof Error ? error.message : String(error)}`
  }
  return ''
}
