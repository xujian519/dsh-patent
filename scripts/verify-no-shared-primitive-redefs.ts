// Fail if any package redefines a shared primitive that already lives in
// @deepseek-ai/dsh-value. Prevents F-CROSS-001 (four packages each carried
// their own copy of messageOf / errorText / escapeRegExp / asRecord).

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const GATE = 'verify-no-shared-primitive-redefs'
const PRIMITIVES: readonly string[] = ['messageOf', 'errorText', 'escapeRegExp', 'asRecord']
const ROOT = resolve(import.meta.dirname, '..')
const DSH_VALUE_DIR = resolve(ROOT, 'packages/util/value/src/index.ts')
const REPORT_ONLY = process.argv.includes('--report')

// Known non-primitive helpers that coincidentally share a primitive name but
// have different signatures (Win32 error formatting, console-arg stringify,
// etc.). Exempting these is the explicit gate policy, not an oversight.
const EXEMPT: ReadonlySet<string> = new Set([
  'packages/subprocess/win32-process/src/ffi.ts:errorText',
  'packages/extensions/cordis-client-runner/src/client/evaluator.ts:errorText',
])

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function walk(): string[] {
  const violations: string[] = []
  for (const file of globSync(
    [
      'packages/*/*/src/**/*.ts',
      'packages/*/*/src/**/*.tsx',
      'apps/*/src/**/*.ts',
      'apps/*/src/**/*.tsx',
    ],
    { cwd: ROOT },
  ).sort()) {
    if (resolve(ROOT, file) === DSH_VALUE_DIR) continue

    const source = readFileSync(resolve(ROOT, file), 'utf8')
    for (const primitive of PRIMITIVES) {
      if (EXEMPT.has(file + ':' + primitive)) continue
      const escaped = escape(primitive)
      const fnRegex = new RegExp('\\b(?:export\\s+)?function\\s+' + escaped + '\\s*\\(')
      const arrowRegex = new RegExp('\\b(?:const|let|var)\\s+' + escaped + '\\s*=\\s*\\(')
      const asyncArrowRegex = new RegExp('\\b(?:const|let|var)\\s+' + escaped + '\\s*=\\s*async\\s*\\(')
      const funcExprRegex = new RegExp('\\b(?:const|let|var)\\s+' + escaped + '\\s*=\\s*function\\s*\\(')
      if (fnRegex.test(source)
        || arrowRegex.test(source)
        || asyncArrowRegex.test(source)
        || funcExprRegex.test(source)) {
        violations.push(
          file + ': redefines shared primitive ' + primitive + ' (import from @deepseek-ai/dsh-value)',
        )
      }
    }
  }
  return violations
}

function main(): void {
  const violations = walk()
  if (violations.length > 0) {
    const mode = REPORT_ONLY ? ' [REPORT]' : ''
    console.error(`${GATE}: ${violations.length} violation(s)${mode}`)
    for (const v of violations) console.error(`  ${v}`)
    if (!REPORT_ONLY) process.exitCode = 1
    return
  }
  console.log(`${GATE}: 0 violations - all shared primitives imported from @deepseek-ai/dsh-value`)
}

if (import.meta.main) main()
