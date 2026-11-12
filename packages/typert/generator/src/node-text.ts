/**
 * Syntax-node readings for the analyzer: declaration text, member names,
 * modifiers, JSDoc, and literal models. Every helper takes compiler nodes and
 * returns strings or plain model values.
 * @module @deepseek-ai/dsh-typert-generator/node-text
 */

import ts from 'typescript'
import type {
  DocumentationModel,
  JsDocTagModel,
  KeywordTypeName,
  MemberModel,
  MemberVisibility,
  TypeNodeModel,
} from './model.ts'
import { EMPTY_DOCUMENTATION, TypertAnalysisError } from './types.ts'

/**
 * Select the declaration that should describe a symbol.
 * @param symbol - the symbol to describe.
 * @returns its first type declaration, else its value declaration, else its first declaration.
 */
export function preferredDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
  return symbol.declarations?.find(isTypeDeclaration)
    ?? symbol.valueDeclaration
    ?? symbol.declarations?.[0]
}

/**
 * Read the parent TypeScript attaches during binding, which the public node type does not declare.
 * @param node - the child node.
 * @returns the parent node, or undefined for a root.
 */
export function optionalParent(node: ts.Node): ts.Node | undefined {
  return (node as ts.Node & { readonly parent?: ts.Node }).parent
}

/**
 * Narrow a node to the declaration kinds the model treats as types.
 * @param node - the node to test.
 * @returns true for a class, interface, type alias, or enum declaration.
 */
export function isTypeDeclaration(
  node: ts.Node,
): node is ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration {
  return ts.isClassDeclaration(node)
    || ts.isInterfaceDeclaration(node)
    || ts.isTypeAliasDeclaration(node)
    || ts.isEnumDeclaration(node)
}

/**
 * Read the name a type declaration binds.
 * @param declaration - the declaration to name.
 * @returns the declared name.
 */
export function declarationName(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): string {
  return (declaration.name as ts.Identifier).text
}

/**
 * Render one member's signature: its source text without the body, with whitespace collapsed.
 * @param member - the member to render.
 * @returns the single-line signature text.
 */
export function memberText(member: ts.TypeElement | ts.ClassElement): string {
  const sourceFile = member.getSourceFile()
  const full = member.getText(sourceFile)
  const body = (member as { body?: ts.Node }).body
  const signature = body === undefined ? full : full.slice(0, full.length - body.getText(sourceFile).length)
  return signature.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

/**
 * Print a declaration's source text, projecting a class through the shape it exposes.
 * @param declaration - the declaration to print.
 * @returns the printed declaration text with line endings normalized.
 */
export function declarationText(
  declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
): string {
  const printer = ts.createPrinter({ removeComments: true })
  const projected = ts.isClassDeclaration(declaration) ? classShape(declaration) : declaration
  return printer.printNode(ts.EmitHint.Unspecified, projected, declaration.getSourceFile()).replace(/\r/g, '')
}

function classShape(node: ts.ClassDeclaration): ts.ClassDeclaration {
  const nonPublic = (member: ts.ClassElement): boolean => {
    if (ts.isClassStaticBlockDeclaration(member)) return true
    if ('name' in member && ts.isPrivateIdentifier(member.name)) return true
    return (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some(modifier =>
      modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword) ?? false
  }
  const members = node.members.flatMap((member): ts.ClassElement[] => {
    if (nonPublic(member)) return []
    if (ts.isMethodDeclaration(member)) {
      if (member.body !== undefined && node.members.some(candidate => ts.isMethodDeclaration(candidate)
        && candidate.body === undefined && memberName(candidate.name) === memberName(member.name)
        && hasModifier(candidate, ts.SyntaxKind.StaticKeyword) === hasModifier(member, ts.SyntaxKind.StaticKeyword))) return []
      return [ts.factory.updateMethodDeclaration(
        member,
        member.modifiers,
        member.asteriskToken,
        member.name,
        member.questionToken,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (ts.isConstructorDeclaration(member)) {
      return [ts.factory.updateConstructorDeclaration(member, member.modifiers, member.parameters, undefined)]
    }
    if (ts.isGetAccessorDeclaration(member)) {
      return [ts.factory.updateGetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (ts.isSetAccessorDeclaration(member)) {
      return [ts.factory.updateSetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.parameters,
        undefined,
      )]
    }
    if (ts.isPropertyDeclaration(member)) {
      return [ts.factory.updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        member.questionToken ?? member.exclamationToken,
        member.type,
        undefined,
      )]
    }
    return [member]
  })
  return ts.factory.updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  )
}

/**
 * Read a node's documentation: its last JSDoc block, its tags, and the raw comment text.
 * @param node - the node to read.
 * @returns the documentation model, empty when the node carries no JSDoc block.
 */
export function documentationOf(node: ts.Node): DocumentationModel {
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc)
  const block = blocks.at(-1)
  if (block === undefined) return EMPTY_DOCUMENTATION
  const description = normalizedDocText(ts.getTextOfJSDocComment(block.comment))
  const tags: JsDocTagModel[] = ts.getJSDocTags(node).map((tag) => {
    const named = tag as ts.JSDocTag & { name?: ts.Node }
    const comment = normalizedDocText(ts.getTextOfJSDocComment(tag.comment))
    return {
      name: tag.tagName.text,
      ...(named.name === undefined ? {} : { argument: named.name.getText() }),
      ...(comment === undefined ? {} : { comment }),
      text: tag.getText(tag.getSourceFile()).trim(),
    }
  })
  return {
    ...(description === undefined ? {} : {
      description,
      summary: firstSentence(description),
    }),
    tags,
    jsDoc: rawJsDoc(node),
  }
}

function normalizedDocText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  /* v8 ignore next -- TypeScript represents whitespace-only JSDoc as undefined before this helper is called. */
  return normalized.length === 0 ? undefined : normalized
}

function firstSentence(value: string): string {
  return (/^(.*?[.!?])(?:\s|$)/.exec(value)?.[1] ?? value).trim()
}

function rawJsDoc(node: ts.Node): string {
  const sourceFile = node.getSourceFile()
  const source = sourceFile.getFullText()
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) as ts.CommentRange[]
  const range = ranges.filter(candidate => source.slice(candidate.pos, candidate.pos + 3) === '/**').at(-1) as ts.CommentRange
  const raw = source.slice(range.pos, range.end)
  const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos)
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
  const indent = source.slice(lineStart, range.pos)
  return raw.split('\n')
    .map((text, index) => index > 0 && text.startsWith(indent) ? text.slice(indent.length) : text)
    .join('\n')
}

/**
 * Read the mode a node's `@typert` tag declares.
 * @param node - the node to read.
 * @returns `object`, or `schema` for a bare, `schema`, or `type` argument, or undefined without the tag.
 */
export function typertMode(node: ts.Node): 'object' | 'schema' | undefined {
  for (const tag of ts.getJSDocTags(node)) {
    if (tag.tagName.text !== 'typert') continue
    const mode = (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/, 1)[0]
    if (mode === 'object') return 'object'
    if (mode === '' || mode === 'schema' || mode === 'type') return 'schema'
  }
  return undefined
}

/**
 * Find the `@typert service` tag on a node.
 * @param node - the node to read.
 * @returns the tag, or undefined when the node declares no typert service.
 */
export function typertServiceTag(node: ts.Node): ts.JSDocTag | undefined {
  return ts.getJSDocTags(node).find(tag => tag.tagName.text === 'typert'
    && (ts.getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/, 1)[0] === 'service')
}

/**
 * Read a member name as written, including computed names.
 * @param name - the property or binding name to read.
 * @returns the name text.
 */
export function memberName(name: ts.PropertyName | ts.BindingName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name)
    || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text
  if (ts.isComputedPropertyName(name)) return `[${name.expression.getText()}]`
  return name.getText()
}

/**
 * Read the value of a string or template literal node.
 * @param node - the node to read.
 * @returns the literal's text, or undefined for an absent or non-string node.
 */
export function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined
}

/**
 * Report whether a subpath segment can name a remote boundary.
 * @param value - the segment to test.
 * @returns true when the segment is a plain name rather than `.` or `..`.
 */
export function isRemoteSegment(value: string): boolean {
  // Generation bootstraps workspace artifacts before dsh-typert-protocol is built,
  // so this extraction-only copy must mirror isTypertRemoteSegment().
  return value !== '.' && value !== '..' && /^[A-Za-z0-9_$.-]+$/.test(value)
}

/**
 * Read the name an expression denotes.
 * @param node - the expression to read.
 * @returns the identifier or property name, or undefined for any other expression.
 */
export function expressionName(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  return undefined
}

/**
 * Join a package name and an export subpath into the specifier a consumer imports.
 * @param packageName - the package's name.
 * @param subpath - the export subpath, `.` for the package root.
 * @returns the specifier text.
 */
export function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}

/**
 * Classify a member's visibility.
 * @param node - the member to classify.
 * @returns `private`, `protected`, or `public`.
 */
export function visibilityOf(node: ts.Node): MemberVisibility {
  if ('name' in node && node.name !== undefined && ts.isPrivateIdentifier(node.name as ts.Node)) return 'private'
  if (hasModifier(node, ts.SyntaxKind.PrivateKeyword)) return 'private'
  if (hasModifier(node, ts.SyntaxKind.ProtectedKeyword)) return 'protected'
  return 'public'
}

/**
 * Report whether a node carries a modifier of one kind.
 * @param node - the node to test.
 * @param kind - the modifier syntax kind to look for.
 * @returns true when the modifier is present.
 */
export function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(modifier => modifier.kind === kind) ?? false
}

/**
 * Report whether a member reaches the model's exported surface.
 * @param member - the member to test.
 * @returns true for a public instance member.
 */
export function exposableMember(member: MemberModel): boolean {
  return member.visibility === 'public' && !member.static
}

/**
 * Map a keyword type syntax kind to the model's keyword name.
 * @param kind - the syntax kind to map.
 * @returns the keyword name, or undefined for a non-keyword kind.
 */
export function keywordName(kind: ts.SyntaxKind): KeywordTypeName | undefined {
  switch (kind) {
    case ts.SyntaxKind.AnyKeyword: return 'any'
    case ts.SyntaxKind.BigIntKeyword: return 'bigint'
    case ts.SyntaxKind.BooleanKeyword: return 'boolean'
    case ts.SyntaxKind.NeverKeyword: return 'never'
    case ts.SyntaxKind.NumberKeyword: return 'number'
    case ts.SyntaxKind.ObjectKeyword: return 'object'
    case ts.SyntaxKind.StringKeyword: return 'string'
    case ts.SyntaxKind.SymbolKeyword: return 'symbol'
    case ts.SyntaxKind.UndefinedKeyword: return 'undefined'
    case ts.SyntaxKind.UnknownKeyword: return 'unknown'
    case ts.SyntaxKind.VoidKeyword: return 'void'
    default: return undefined
  }
}

/**
 * Build the model entry for a literal type node.
 * @param node - the literal type node to model.
 * @returns the literal's model entry without its graph id.
 * @throws when the literal is syntax this extraction does not model.
 */
export function literalModel(node: ts.LiteralTypeNode): Omit<Extract<TypeNodeModel, { kind: 'literal' }>, 'id'> {
  const literal = node.literal
  if (ts.isStringLiteral(literal)) return { kind: 'literal', value: literal.text, text: literal.getText() }
  if (ts.isNoSubstitutionTemplateLiteral(literal)) {
    return { kind: 'literal', value: literal.text, text: literal.getText() }
  }
  if (ts.isNumericLiteral(literal)) return { kind: 'literal', value: Number(literal.text), text: literal.getText() }
  if (ts.isBigIntLiteral(literal)) return { kind: 'literal', value: BigInt(literal.text.slice(0, -1)), text: literal.getText() }
  if (literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: 'literal', value: true, text: 'true' }
  if (literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: 'literal', value: false, text: 'false' }
  if (literal.kind === ts.SyntaxKind.NullKeyword) return { kind: 'literal', value: null, text: 'null' }
  /* v8 ignore else -- all remaining LiteralTypeNode syntax is a signed numeric or bigint literal. */
  if (ts.isPrefixUnaryExpression(literal)
    && (ts.isNumericLiteral(literal.operand) || ts.isBigIntLiteral(literal.operand))) {
    return {
      kind: 'literal',
      value: ts.isBigIntLiteral(literal.operand)
        ? BigInt(literal.getText().slice(0, -1))
        : Number(literal.getText()),
      text: literal.getText(),
    }
  }
  /* v8 ignore next -- TypeScript's LiteralTypeNode grammar is exhausted above; this contains future compiler syntax. */
  throw new TypertAnalysisError(`typert: unsupported literal type ${literal.getText()}`)
}

/**
 * Classify an optional modifier token by what it does to the modifier.
 * @param token - the token TypeScript parsed, if any.
 * @returns `add`, `remove`, or `preserve`.
 */
export function modifierMode(token: ts.ReadonlyKeyword | ts.PlusToken | ts.MinusToken | ts.QuestionToken | undefined):
  'add' | 'remove' | 'preserve' {
  if (token?.kind === ts.SyntaxKind.PlusToken) return 'add'
  if (token?.kind === ts.SyntaxKind.MinusToken) return 'remove'
  return token === undefined ? 'preserve' : 'add'
}

/**
 * Locate where a type annotation attaches on a property, parameter, or return type.
 * @param node - the declaration carrying the annotation.
 * @param purpose - which annotation the position belongs to.
 * @returns the source position the annotation follows.
 */
export function annotationPosition(
  node: ts.Node,
  purpose: 'property' | 'parameter' | 'return',
): number {
  if (purpose === 'return') return (node as ts.SignatureDeclarationBase).parameters.end + 1
  return (node as ts.ParameterDeclaration | ts.PropertyDeclaration | ts.PropertySignature).name.end
}
