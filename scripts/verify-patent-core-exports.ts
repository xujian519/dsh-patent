/**
 * Reject a `@deepseek-ai/dsh-patent-core` root-barrel name that no file outside
 * the package imports, unless the export is marked `@public`.
 *
 * The package entry is a published surface. A helper that only this package
 * calls stays on the module that defines it; re-exporting it makes every rename
 * an external break. `export *` is rejected because a star would publish names
 * this gate does not list.
 *
 * Discovery is syntax-aware. An import, an `export { … } from` re-export, an
 * `import('…').Name` type query, and a destructured dynamic `import()` count.
 * Text in strings and comments does not. Files under `packages/patent/patent-core/`
 * do not count: the package's own tests may import a helper from the module
 * that defines it.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

const GATE = 'verify-patent-core-exports'
const root = resolve(import.meta.dirname, '..')

/** Package specifier this gate reads. */
export const PATENT_CORE_SPECIFIER = '@deepseek-ai/dsh-patent-core'

/** Repository-relative path of the package's only entry. */
export const PATENT_CORE_ENTRY = 'packages/patent/patent-core/src/index.ts'

/** Repository-relative prefix whose files are not outside consumers. */
const PACKAGE_PREFIX = 'packages/patent/patent-core/'

/** One name the root barrel exports. */
export interface BarrelExport {
  /** The name importers bind. */
  readonly name: string
  /** One-based line of the export specifier. */
  readonly line: number
  /** True when a comment on the specifier or its statement contains `@public`. */
  readonly documentedPublic: boolean
}

/** A star re-export, which this gate does not resolve. */
export interface StarExport {
  /** One-based line of the `export` keyword. */
  readonly line: number
}

/**
 * Read the named exports and star re-exports of the package entry.
 * @param text - source of `src/index.ts`.
 * @param fileName - path used only for diagnostics.
 * @returns every named export and every star re-export.
 */
export function readBarrelExports(text: string, fileName: string): { names: BarrelExport[]; stars: StarExport[] } {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const names: BarrelExport[] = []
  const stars: StarExport[] = []
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1
    if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      stars.push({ line })
      continue
    }
    const statementPublic = commentHasPublic(text, statement)
    for (const element of statement.exportClause.elements) {
      names.push({
        name: element.name.text,
        line: source.getLineAndCharacterOfPosition(element.getStart(source)).line + 1,
        documentedPublic: statementPublic || commentHasPublic(text, element),
      })
    }
  }
  return { names, stars }
}

/**
 * Names a single file imports from the patent-core package.
 * @param text - file source.
 * @param fileName - path used only so the parser can classify TSX.
 * @returns the imported names. A namespace import or a bare `export *` returns `['*']`.
 */
export function namesImportedFromPatentCore(text: string, fileName: string): readonly string[] {
  if (!text.includes(PATENT_CORE_SPECIFIER)) return []
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (isPatentCoreModule(node)) {
      names.push(...moduleBindingNames(node))
    }
    if (ts.isImportTypeNode(node) && isPatentCoreLiteral(node.argument)) {
      const qualifier = node.qualifier
      if (qualifier && ts.isIdentifier(qualifier)) names.push(qualifier.text)
      else if (qualifier && ts.isQualifiedName(qualifier)) names.push(leftmost(qualifier))
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteral(argument) && argument.text === PATENT_CORE_SPECIFIER) {
        names.push(...dynamicImportNames(node))
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/**
 * Barrel names that fail the gate.
 * @param barrel - exports read from the package entry.
 * @param imported - names imported by files outside the package.
 * @returns human-readable violations, stars first, then unused names.
 */
export function barrelViolations(
  barrel: { names: readonly BarrelExport[]; stars: readonly StarExport[] },
  imported: ReadonlySet<string>,
): string[] {
  const violations: string[] = []
  for (const star of barrel.stars) {
    violations.push(`${PATENT_CORE_ENTRY}:${String(star.line)} uses export *, which publishes names this gate does not list. Name each export.`)
  }
  for (const item of barrel.names) {
    if (item.documentedPublic || imported.has('*') || imported.has(item.name)) continue
    violations.push(`${PATENT_CORE_ENTRY}:${String(item.line)} exports ${item.name}, which no file outside the package imports. Mark the specifier @public or stop exporting it.`)
  }
  return violations
}

/**
 * TypeScript files whose imports can count, excluding the package itself and build output.
 * @param repositoryRoot - absolute repository root.
 * @returns repository-relative POSIX paths. Empty when the glob matches nothing.
 */
export function consumerFiles(repositoryRoot: string): string[] {
  const files = globSync('**/*.{ts,tsx}', {
    cwd: repositoryRoot,
    exclude: path => path.includes('node_modules')
      || path.includes('.desktop-build')
      || path.includes('pnpm-store')
      || path.includes('/lib/')
      || path.includes('/dist/')
      || path.startsWith('lib/')
      || path.startsWith('dist/'),
  })
  return files
    .map(file => file.split(sep).join('/'))
    .filter(file => !skippedConsumer(file))
    .sort()
}

/**
 * Names imported from the package by every consumer file.
 * @param repositoryRoot - absolute repository root.
 * @returns the imported names. Throws when the consumer corpus is empty.
 */
export function importedPatentCoreNames(repositoryRoot: string): Set<string> {
  const files = consumerFiles(repositoryRoot)
  if (files.length === 0) throw new Error(`${GATE}: consumer corpus is empty`)
  const names = new Set<string>()
  for (const file of files) {
    const text = readFileSync(resolve(repositoryRoot, file), 'utf8')
    for (const name of namesImportedFromPatentCore(text, file)) names.add(name)
  }
  return names
}

/**
 * Violations for the repository's current package entry.
 * @param repositoryRoot - absolute repository root.
 * @returns human-readable violations.
 */
export function collectPatentCoreExportViolations(repositoryRoot: string = root): string[] {
  const text = readFileSync(resolve(repositoryRoot, PATENT_CORE_ENTRY), 'utf8')
  return barrelViolations(readBarrelExports(text, PATENT_CORE_ENTRY), importedPatentCoreNames(repositoryRoot))
}

/** CLI entry. Exit 1 when the barrel exports a name nobody outside the package imports. */
function main(): void {
  const violations = collectPatentCoreExportViolations()
  if (violations.length === 0) {
    console.log(`${GATE}: every ${PATENT_CORE_SPECIFIER} export is imported outside the package or marked @public.`)
    return
  }
  console.error(`${GATE}: ${String(violations.length)} violation(s):`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exitCode = 1
}

/** True when a comment on the node contains the public-export marker. */
function commentHasPublic(text: string, node: ts.Node): boolean {
  const source = node.getSourceFile()
  const ranges = [
    ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
    ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
  ]
  return ranges.some(range => text.slice(range.pos, range.end).includes('@public'))
    || source.text.slice(node.getFullStart(), node.getStart(source)).includes('@public')
}

/** True for an import or export whose module specifier is the package. */
function isPatentCoreModule(node: ts.Node): node is ts.ImportDeclaration | ts.ExportDeclaration {
  return (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
    && node.moduleSpecifier !== undefined
    && ts.isStringLiteral(node.moduleSpecifier)
    && node.moduleSpecifier.text === PATENT_CORE_SPECIFIER
}

/** True when an `import()` type argument names the package. */
function isPatentCoreLiteral(argument: ts.ImportTypeNode['argument']): boolean {
  return ts.isLiteralTypeNode(argument)
    && ts.isStringLiteral(argument.literal)
    && argument.literal.text === PATENT_CORE_SPECIFIER
}

/** Names bound by one import or re-export of the package. `*` means the whole barrel. */
function moduleBindingNames(node: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
    return ['*']
  }
  if (ts.isExportDeclaration(node) && !node.exportClause) return ['*']
  const named = ts.isImportDeclaration(node) ? node.importClause?.namedBindings : node.exportClause
  if (!named || (!ts.isNamedImports(named) && !ts.isNamedExports(named))) return []
  return named.elements.map(element => element.propertyName?.text ?? element.name.text)
}

/** Names pulled out of a dynamic `import()` of the package. */
function dynamicImportNames(node: ts.CallExpression): string[] {
  const awaited = ts.isAwaitExpression(node.parent) ? node.parent : node
  const declaration = awaited.parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isObjectBindingPattern(declaration.name)) return []
  const names: string[] = []
  for (const element of declaration.name.elements) {
    if (element.propertyName && ts.isIdentifier(element.propertyName)) names.push(element.propertyName.text)
    else if (ts.isIdentifier(element.name)) names.push(element.name.text)
  }
  return names
}

/** Left-most identifier of a qualified import type. */
function leftmost(name: ts.QualifiedName): string {
  return ts.isIdentifier(name.left) ? name.left.text : leftmost(name.left)
}

/** Build output and the package under test are not outside consumers. */
function skippedConsumer(file: string): boolean {
  return file.startsWith(PACKAGE_PREFIX)
    || file.includes('/node_modules/')
    || file.startsWith('node_modules/')
    || file.includes('/lib/')
    || file.startsWith('lib/')
    || file.includes('/dist/')
    || file.includes('.desktop-build/')
    || file.includes('pnpm-store/')
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main()
