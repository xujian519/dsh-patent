/**
 * Module and path resolution for the analyzer: which module a type reference
 * reaches, which package a resolved file belongs to, and the path, diagnostic,
 * and filesystem helpers those answers need.
 * @module @deepseek-ai/dsh-typert-generator/module-path
 */

import { existsSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { TypertAnalysisError } from './types.ts'
import type { TypertFace } from './model.ts'
import type { ModuleIdentity, ReferenceSite } from './types.ts'

/** One `import` binding of a local name; `name` is absent for a namespace import. */
interface ImportBinding {
  readonly specifier: string
  readonly name?: string
}

/**
 * Resolve the module specifier a type reference reaches.
 * @param node - the type reference to resolve.
 * @returns the specifier, or undefined when the reference names no imported binding.
 */
export function moduleSpecifierOf(node: ReferenceSite): string | undefined {
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument as ts.LiteralTypeNode & { readonly literal: ts.StringLiteral }
    return argument.literal.text
  }
  const symbol = ts.isTypeReferenceNode(node)
    ? node.typeName
    : node.expression
  const sourceFile = node.getSourceFile()
  const first = ts.isIdentifier(symbol) ? symbol.text : symbol.getFirstToken(sourceFile)?.getText(sourceFile)
  return first === undefined ? undefined : importBindingOf(sourceFile, first)?.specifier
}

/**
 * Recover the name the referenced module exports a type under.
 * @param node - the type reference to resolve.
 * @param moduleSpecifier - the resolved specifier, named in the rejection message.
 * @returns the exported name.
 * @throws when the reference's local name has no import binding.
 */
export function authoredExportName(node: ReferenceSite, moduleSpecifier: string): string {
  if (ts.isImportTypeNode(node)) return (node.qualifier as ts.EntityName).getText().split('.')[0] as string

  const referenced = ts.isTypeReferenceNode(node)
    ? node.typeName.getText().split('.')
    : node.expression.getText().split('.')
  const localName = referenced[0] as string
  const binding = importBindingOf(node.getSourceFile(), localName)
  /* v8 ignore next -- moduleSpecifierOf returns only the import inspected by importBindingOf. */
  if (binding === undefined) throw new TypertAnalysisError(`typert: cannot recover export name for ${localName} from ${moduleSpecifier}`)
  return binding.name ?? (referenced[1] as string)
}

/**
 * Find the import statement that binds a local name in a source file.
 * @param sourceFile - the file whose imports are searched.
 * @param localName - the local name to find.
 * @returns the binding, or undefined when no import binds that name.
 */
export function importBindingOf(sourceFile: ts.SourceFile, localName: string): ImportBinding | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const specifier = statement.moduleSpecifier.text
    if (statement.importClause.name?.text === localName) return { specifier, name: 'default' }
    const bindings = statement.importClause.namedBindings
    if (bindings === undefined) continue
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === localName) return { specifier }
      continue
    }
    const element = bindings.elements.find(candidate => candidate.name.text === localName)
    if (element !== undefined) return { specifier, name: element.propertyName?.text ?? element.name.text }
  }
  return undefined
}

/**
 * Read the import attributes text of an `import(...)` type node.
 * @param node - the import type node to read.
 * @returns the attributes text between the argument and the closing parenthesis.
 */
export function importTypeAttributesText(node: ts.ImportTypeNode): string {
  const sourceFile = node.getSourceFile()
  const children = node.getChildren(sourceFile)
  const comma = children.find(child => child.kind === ts.SyntaxKind.CommaToken) as ts.Node
  const close = children.find(child => child.kind === ts.SyntaxKind.CloseParenToken) as ts.Node
  return sourceFile.text.slice(comma.end, close.pos).trim()
}

/**
 * Split a bare package specifier into its package name and subpath.
 * @param specifier - the specifier to split.
 * @returns the identity, or undefined for a relative or absolute specifier.
 */
export function moduleIdentity(specifier: string): ModuleIdentity | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined
  const parts = specifier.split('/')
  const packageLength = specifier.startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  const rest = parts.slice(packageLength).join('/')
  return {
    package: packageName,
    subpath: rest.length === 0 ? '.' : `./${rest}`,
  }
}

/**
 * Derive the package identity of a file resolved out of `node_modules`.
 * @param file - the resolved file path.
 * @returns the identity, or undefined for a file outside `node_modules`.
 */
export function externalModuleIdentityForFile(file: string): ModuleIdentity | undefined {
  const normalized = slash(file)
  const marker = '/node_modules/'
  const index = normalized.lastIndexOf(marker)
  if (index < 0) return undefined
  const parts = normalized.slice(index + marker.length).split('/')
  const packageLength = (parts[0] as string).startsWith('@') ? 2 : 1
  const packageName = parts.slice(0, packageLength).join('/')
  return { package: packageName, subpath: '.' }
}

/**
 * Report whether a file is one of TypeScript's bundled library declarations.
 * @param file - the file path to test.
 * @returns true for a `lib.*.d.ts` file under `typescript/lib`.
 */
export function isStandardLibraryFile(file: string): boolean {
  const base = file.replaceAll('\\', '/')
  return /\/typescript\/lib\/lib\.[^/]+\.d\.ts$/.test(base)
}

/**
 * Flatten a diagnostic's message chain into one string.
 * @param diagnostic - the diagnostic to format.
 * @returns the flattened message.
 */
export function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}

/**
 * Format a located program diagnostic with its file position and Typert's face prefix.
 * @param root - the workspace root the reported file path is relative to.
 * @param face - the face being analyzed.
 * @param diagnostic - the located diagnostic to format.
 * @returns the formatted message.
 */
export function formatProgramDiagnostic(root: string, face: TypertFace, diagnostic: ts.DiagnosticWithLocation): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
  const file = slash(relative(root, diagnostic.file.fileName))
  return `typert(${face}): ${file}:${String(position.line + 1)}:${String(position.character + 1)}: TypeScript TS${String(diagnostic.code)}: ${message}`
}

const realPathCache = new Map<string, string>()

/**
 * Resolve a path to its canonical form.
 * @param path - the path to resolve.
 * @returns the canonical path, or the absolute path when it does not exist.
 */
export function realPath(path: string): string {
  const absolute = resolve(path)
  const cached = realPathCache.get(absolute)
  if (cached !== undefined) return cached
  // Only existing paths are memoized: a path can come into existence later,
  // but an existing path's canonical form is stable for the process lifetime
  // (analysis edits rewrite file contents, never the directory tree).
  if (!existsSync(absolute)) return absolute
  const resolved = realpathSync(absolute)
  realPathCache.set(absolute, resolved)
  return resolved
}

/**
 * Report whether a path is a root itself or lies under it.
 * @param path - the path to test.
 * @param root - the root to test against.
 * @returns true when the path is inside the root.
 */
export function isWithin(path: string, root: string): boolean {
  const absolute = realPath(path)
  const parent = realPath(root)
  return absolute === parent || absolute.startsWith(parent + sep)
}

/**
 * Replace backslashes with forward slashes.
 * @param value - the path to normalize.
 * @returns the path with forward slashes.
 */
export function slash(value: string): string {
  return value.replaceAll('\\', '/')
}
