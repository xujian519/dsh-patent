#!/usr/bin/env node
/**
 * legal-knowledge-install — copies a source legal.db into the dsh legal
 * knowledge data directory, optionally dropping the FTS5 indexes. Usage:
 *   legal-knowledge-install --from <source> [--output <path>] [--no-fts]
 *
 * `--from` is required: the default source path resolves to the installer's
 * default output, so a run without it would overwrite the source with itself.
 * @module @deepseek-ai/dsh-legal-knowledge/bin
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { errorMessage } from '@deepseek-ai/dsh-value'
import { installLegalKnowledgeDb } from './install.ts'

/** Parsed command line. */
export interface InstallArguments {
  /** Source legal.db to read; the installer never writes it. */
  readonly from: string | undefined
  /** Explicit output path; the installer's default sits under the data directory. */
  readonly output: string | undefined
  /** Drop the FTS5 indexes, degrading full-text search to LIKE. */
  readonly noFts: boolean
  /** Print usage instead of installing. */
  readonly help: boolean
}

/**
 * Parse the installer's command line.
 * @param argv - arguments after the executable and script path.
 * @returns the parsed values; {@link InstallArguments.from} is undefined when omitted.
 */
export function parseInstallArguments(argv: readonly string[]): InstallArguments {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: 'string' },
      output: { type: 'string' },
      'no-fts': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false, short: 'h' },
    },
  })
  return {
    from: values.from,
    output: values.output,
    noFts: values['no-fts'],
    help: values.help,
  }
}

/** Usage text. */
const USAGE = [
  'legal-knowledge-install — build the legal knowledge query database.',
  '',
  'Usage: legal-knowledge-install --from <path> [options]',
  '',
  'Options:',
  '  --from <path>    Source legal.db (required).',
  '  --output <path>  Output path (default ~/.dsh/legal-knowledge/legal.db).',
  '  --no-fts         Drop the FTS5 indexes; full-text search degrades to LIKE.',
  '  -h, --help       Print this help.',
].join('\n')

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const args = parseInstallArguments(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }
  if (args.from === undefined) {
    console.error('legal-knowledge-install: --from <path> is required.')
    console.error(USAGE)
    process.exit(2)
  }
  try {
    await installLegalKnowledgeDb({
      sourceDbPath: args.from,
      output: args.output,
      noFts: args.noFts,
    })
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}
