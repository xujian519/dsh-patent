/**
 * The type graph of one face: the declaration and node model, the type conversion that writes it,
 * and the id allocation that orders it.
 *
 * Both analyzer clusters mutate these four maps, so this module owns them: id allocation,
 * declaration identity, and node identity each have one place to change.
 * @module @deepseek-ai/dsh-typert-generator/type-graph
 */

import ts from 'typescript'
import type {
  EnumMemberModel,
  MemberBase,
  MemberModel,
  MemberVisibility,
  ParameterModel,
  SignatureModel,
  SourceLocation,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
  TypeOperatorName,
  TypeParameterModel,
  TypeTargetModel,
  TypertFace,
} from './model.ts'
import { relative } from 'node:path'
import {
  annotationPosition,
  declarationName,
  declarationText,
  documentationOf,
  hasModifier,
  isTypeDeclaration,
  keywordName,
  literalModel,
  memberName,
  memberText,
  modifierMode,
  optionalParent,
  preferredDeclaration,
  visibilityOf,
} from './node-text.ts'
import {
  externalModuleIdentityForFile,
  importTypeAttributesText,
  isStandardLibraryFile,
  isWithin,
  moduleSpecifierOf,
  realPath,
  slash,
} from './module-path.ts'
import { SourceEditQueued, TypertAnalysisError } from './types.ts'
import type {
  AnalysisMode,
  ModuleIdentity,
  PackageImport,
  PackageRegistration,
  ReferenceSite,
  SourceEdit,
} from './types.ts'

type WithoutId<T> = T extends { readonly id: TypeNodeId } ? Omit<T, 'id'> : never

/** A node model before the graph supplies its id. */
export type TypeNodeInput = WithoutId<TypeNodeModel>

/**
 * Facts the graph reads from the analyzed workspace and the callbacks it calls back into its
 * package analyzer for: the two facts that attribute and resolve a file, the export name a
 * cross-face re-export needs, and the link it records.
 */
interface TypeGraphDeps {
  /** Absolute workspace root that source locations are relative to. */
  readonly root: string
  /** The face whose program this graph models. */
  readonly face: TypertFace
  /** Checker of that program. */
  readonly checker: ts.TypeChecker
  /** Every registration in the workspace, used to attribute a file to the package that owns it. */
  readonly allRegistrations: readonly PackageRegistration[]
  /** Whether a missing annotation is reported or written before a clean re-analysis. */
  readonly mode: AnalysisMode
  /** Queue the source edit that writes a missing annotation. */
  readonly queueEdit: (edit: SourceEdit) => void
  /** Registration owning a source file, when this face has one. */
  readonly registrationForFile: (file: string) => PackageRegistration | undefined
  /** Exported name a symbol carries at another face's package subpath. */
  readonly packageExportName: (
    module: ModuleIdentity,
    symbol: ts.Symbol,
    face: TypertFace,
    requestedName: string,
  ) => string | undefined
  /** Import a type reference reaches after following package-local forwarding modules. */
  readonly packageImportOf: (
    site: ReferenceSite,
    moduleSpecifier: string,
    symbol: ts.Symbol,
    from: PackageRegistration,
  ) => PackageImport | undefined
  /** Record one cross-face re-export link. */
  readonly recordCrossFaceLink: (
    fromPackage: string,
    toFace: TypertFace,
    module: ModuleIdentity,
    name: string,
  ) => void
}

/** The declarations and nodes of one face, with the id allocation that orders them. */
export class TypeGraph {
  private readonly root: string
  private readonly face: TypertFace
  private readonly checker: ts.TypeChecker
  private readonly allRegistrations: readonly PackageRegistration[]
  private readonly mode: AnalysisMode
  private readonly queueEdit: (edit: SourceEdit) => void
  private readonly registrationForFile: (file: string) => PackageRegistration | undefined
  private readonly packageExportName: TypeGraphDeps['packageExportName']
  private readonly packageImportOf: TypeGraphDeps['packageImportOf']
  private readonly recordCrossFaceLink: TypeGraphDeps['recordCrossFaceLink']
  private readonly declarations = new Map<SymbolId, TypeDeclarationModel>()
  private readonly declarationStates = new Set<SymbolId>()
  private readonly nodes = new Map<TypeNodeId, TypeNodeModel>()
  private readonly nodeOrdinals = new Map<string, number>()

  constructor(deps: TypeGraphDeps) {
    this.root = deps.root
    this.face = deps.face
    this.checker = deps.checker
    this.allRegistrations = deps.allRegistrations
    this.mode = deps.mode
    this.queueEdit = deps.queueEdit
    this.registrationForFile = deps.registrationForFile
    this.packageExportName = deps.packageExportName
    this.packageImportOf = deps.packageImportOf
    this.recordCrossFaceLink = deps.recordCrossFaceLink
  }

  /**
   * Read every declaration model the graph holds, in id order.
   * @returns The declaration models of this face.
   */
  declarationModels(): readonly TypeDeclarationModel[] {
    return [...this.declarations.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Read every node model the graph holds, in id order.
   * @returns The node models of this face.
   */
  nodeModels(): readonly TypeNodeModel[] {
    return [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  /**
   * Read one stored node model.
   * @param id - Node id returned by an earlier store.
   * @returns The node model, or undefined when the id was never stored.
   */
  public node(id: TypeNodeId): TypeNodeModel | undefined {
    return this.nodes.get(id)
  }

  /**
   * Store one node under an id the caller minted.
   * @param id - Node id the caller allocated.
   * @param model - Node model without its id.
   */
  setNode(id: TypeNodeId, model: TypeNodeInput): void {
    this.nodes.set(id, { id, ...model })
  }

  /**
   * Store one declaration under an id the caller minted.
   * @param id - Declaration id the caller derived.
   * @param model - Complete declaration model.
   */
  setDeclaration(id: SymbolId, model: TypeDeclarationModel): void {
    this.declarations.set(id, model)
  }
  /**
   * Test whether a node names one of the typert type-meta interfaces, such as `TypertLookupMap`.
   * @param node - Node to read the symbol of.
   * @param name - Type-meta interface name to match.
   * @returns Whether the node's resolved symbol is that interface in a registered package.
   */
  public isTypeMetaSymbol(node: ts.Node, name: string): boolean {
    const symbol = this.checker.getSymbolAtLocation(node)
    if (symbol === undefined) return false
    const resolved = this.resolveSymbol(symbol)
    if (resolved.name !== name) return false
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined) return false
    const registration = this.registrationForFile(declaration.getSourceFile().fileName)
    if (registration?.name === '@deepseek-ai/dsh-typert-protocol') return true
    for (let current: ts.Node | undefined = declaration; current !== undefined; current = optionalParent(current)) {
      if (ts.isModuleDeclaration(current)
        && ts.isStringLiteral(current.name)
        && current.name.text === '@deepseek-ai/dsh-typert-protocol') return true
    }
    return false
  }

  /**
   * Return the declaration model of one business symbol, building it on first sight and reusing it
   * afterwards; a re-entrant call for a symbol already being built resolves through the guard.
   * @param symbol - Symbol whose declaration is required.
   * @param selected - The declaration whose text and documentation the model records.
   * @returns The declaration model, stored under the symbol's id.
   */
  public ensureDeclaration(
    symbol: ts.Symbol,
    selected: ts.ClassDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  ): TypeDeclarationModel {
    const resolved = this.resolveSymbol(symbol)
    const id = this.symbolId(resolved)
    const existing = this.declarations.get(id)
    if (existing !== undefined) return existing
    const declarationParts = (resolved.declarations as ts.Declaration[]).filter(isTypeDeclaration)
    if (declarationParts.length > 1 && !declarationParts.every(ts.isInterfaceDeclaration)) {
      this.fail(
        selected,
        `merged ${ts.SyntaxKind[selected.kind]} declaration ${resolved.name} is not supported`,
      )
    }
    if (selected.name === undefined) {
      this.fail(selected, `anonymous ${ts.SyntaxKind[selected.kind]} cannot be represented as a named type declaration`)
    }
    const owner = this.registrationForFile(selected.getSourceFile().fileName) as PackageRegistration

    this.declarationStates.add(id)
    if (declarationParts.length > 1) {
      const analyzedParts = declarationParts.map((declarationPart) => {
        const part = declarationPart as ts.InterfaceDeclaration
        const partOwner = this.registrationForFile(part.getSourceFile().fileName)
        if (partOwner === undefined) {
          this.fail(part, `merged interface ${resolved.name} contains a declaration outside this face`)
        }
        const typeParameters = this.typeParameters(part.typeParameters)
        const heritage = this.heritage(part)
        const members = this.members(part.members, id)
        return {
          typeParameters,
          heritage,
          members,
          model: {
            ...documentationOf(part),
            package: partOwner.name,
            location: this.location(part),
            typeParameters,
            extends: heritage.extends,
            members: members.map(member => member.id),
          },
        }
      })
      const parameters = this.mergeTypeParameters(analyzedParts.map(part => part.typeParameters), selected, resolved.name)
      const model: TypeDeclarationModel = {
        ...documentationOf(selected),
        id,
        package: owner.name,
        name: declarationName(selected),
        kind: 'interface',
        abstract: false,
        exported: hasModifier(selected, ts.SyntaxKind.ExportKeyword),
        location: this.location(selected),
        text: declarationText(selected),
        typeParameters: parameters,
        extends: analyzedParts.flatMap(part => part.heritage.extends),
        implements: [],
        members: analyzedParts.flatMap(part => part.members),
        parts: analyzedParts.map(part => part.model),
      }
      this.declarations.set(id, model)
      this.declarationStates.delete(id)
      return model
    }
    const parameters = ts.isEnumDeclaration(selected) ? [] : this.typeParameters(selected.typeParameters)
    const heritage = ts.isTypeAliasDeclaration(selected) || ts.isEnumDeclaration(selected)
      ? { extends: [] as TypeNodeId[], implements: [] as TypeNodeId[] }
      : this.heritage(selected)
    const kind = ts.isClassDeclaration(selected)
      ? 'class'
      : ts.isInterfaceDeclaration(selected)
        ? 'interface'
        : ts.isTypeAliasDeclaration(selected)
          ? 'alias'
          : 'enum'
    const model: TypeDeclarationModel = {
      ...documentationOf(selected),
      id,
      package: owner.name,
      name: declarationName(selected),
      kind,
      abstract: hasModifier(selected, ts.SyntaxKind.AbstractKeyword),
      exported: hasModifier(selected, ts.SyntaxKind.ExportKeyword),
      location: this.location(selected),
      text: declarationText(selected),
      typeParameters: parameters,
      extends: heritage.extends,
      implements: heritage.implements,
      members: ts.isTypeAliasDeclaration(selected) || ts.isEnumDeclaration(selected)
        ? []
        : this.members(selected.members, id),
      ...(ts.isTypeAliasDeclaration(selected) ? { type: this.convertType(selected.type) } : {}),
      ...(ts.isEnumDeclaration(selected) ? { enumMembers: this.enumMembers(selected) } : {}),
    }
    this.declarations.set(id, model)
    this.declarationStates.delete(id)
    return model
  }

  private enumMembers(declaration: ts.EnumDeclaration): EnumMemberModel[] {
    return declaration.members.map(member => ({
      ...documentationOf(member),
      name: memberName(member.name),
      ...(member.initializer === undefined ? {} : { initializer: member.initializer.getText() }),
      location: this.location(member),
    }))
  }

  private heritage(
    declaration: ts.ClassDeclaration | ts.InterfaceDeclaration,
  ): { extends: TypeNodeId[]; implements: TypeNodeId[] } {
    const result = { extends: [] as TypeNodeId[], implements: [] as TypeNodeId[] }
    for (const clause of declaration.heritageClauses ?? []) {
      const target = clause.token === ts.SyntaxKind.ExtendsKeyword ? result.extends : result.implements
      for (const type of clause.types) target.push(this.convertHeritage(type))
    }
    return result
  }

  private convertHeritage(node: ts.ExpressionWithTypeArguments): TypeNodeId {
    const symbol = this.checker.getSymbolAtLocation(node.expression) as ts.Symbol
    return this.addNode(node, {
      kind: 'reference',
      name: node.expression.getText(),
      target: this.targetForReference(this.resolveSymbol(symbol), node),
      arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
    })
  }

  private members(
    members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
    ownerId: string,
  ): MemberModel[] {
    const result: MemberModel[] = []
    for (const member of members) {
      if (ts.isPropertyDeclaration(member)
        && memberName(member.name) === 'typertRemote'
        && member.initializer !== undefined
        && ts.isCallExpression(member.initializer)
        && this.isTypeMetaSymbol(member.initializer.expression, 'bindTypertRemote')) continue
      if (ts.isMethodDeclaration(member) && member.body !== undefined
        && members.some(candidate => candidate !== member
          && (ts.isMethodDeclaration(candidate) || ts.isMethodSignature(candidate))
          && memberName(candidate.name) === memberName(member.name)
          && (!ts.isMethodDeclaration(candidate) || candidate.body === undefined))) continue
      const visibility = visibilityOf(member)
      const isStatic = hasModifier(member, ts.SyntaxKind.StaticKeyword)
      if (visibility !== 'public' || isStatic || ts.isConstructorDeclaration(member)) continue
      const base = this.memberBase(member, ownerId, visibility, isStatic)
      if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
        const type = this.requiredType(member, member.type, 'property')
        result.push({ ...base, kind: 'property', type: this.convertType(type) })
      } else if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        result.push({ ...base, kind: 'method', signature: this.signature(member, member.type) })
      } else if (ts.isGetAccessorDeclaration(member)) {
        result.push({ ...base, kind: 'getter', signature: this.signature(member, member.type) })
      } else if (ts.isSetAccessorDeclaration(member)) {
        result.push({ ...base, kind: 'setter', signature: this.signature(member, member.type) })
      } else if (ts.isCallSignatureDeclaration(member)) {
        result.push({ ...base, kind: 'call', signature: this.signature(member, member.type) })
      } else if (ts.isConstructSignatureDeclaration(member)) {
        result.push({ ...base, kind: 'construct', signature: this.signature(member, member.type) })
      } else if (ts.isIndexSignatureDeclaration(member)) {
        result.push({ ...base, kind: 'index', signature: this.signature(member, member.type) })
      }
    }
    return result
  }

  private memberBase(
    member: ts.TypeElement | ts.ClassElement,
    ownerId: string,
    visibility: MemberVisibility,
    isStatic: boolean,
  ): MemberBase {
    const identity = member.name !== undefined
      ? this.memberIdentity(member.name)
      : {
        name: ts.isCallSignatureDeclaration(member)
          ? '(call)'
          : ts.isConstructSignatureDeclaration(member)
            ? '(construct)'
            : '(index)',
      }
    return {
      ...documentationOf(member),
      id: `${ownerId}#${identity.name}@${String(member.getStart())}`,
      ...identity,
      optional: 'questionToken' in member && member.questionToken !== undefined,
      readonly: hasModifier(member, ts.SyntaxKind.ReadonlyKeyword),
      async: hasModifier(member, ts.SyntaxKind.AsyncKeyword),
      abstract: hasModifier(member, ts.SyntaxKind.AbstractKeyword),
      static: isStatic,
      visibility,
      location: this.location(member),
      text: memberText(member),
    }
  }

  private memberIdentity(name: ts.PropertyName): Pick<MemberBase, 'name' | 'jsonName' | 'computed'> {
    if (!ts.isComputedPropertyName(name)) return { name: memberName(name) }
    const expression = name.expression
    if (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression)
      || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return { name: memberName(name), jsonName: expression.text }
    }
    const type = this.checker.getTypeAtLocation(expression)
    return {
      name: memberName(name),
      computed: (type.flags & ts.TypeFlags.UniqueESSymbol) !== 0 ? 'symbol' : 'dynamic',
    }
  }

  /**
   * Read one callable signature, filling a missing return type through {@link requiredType}.
   * @param node - Signature-bearing declaration to read.
   * @param explicitReturn - Authored return type, or undefined when the source omits it.
   * @returns The signature model of that declaration.
   */
  public signature(
    node: ts.SignatureDeclarationBase,
    explicitReturn: ts.TypeNode | undefined,
  ): SignatureModel {
    const parameters: ParameterModel[] = node.parameters.map(parameter => ({
      name: memberName(parameter.name),
      binding: ts.isIdentifier(parameter.name)
        ? 'identifier'
        : ts.isObjectBindingPattern(parameter.name)
          ? 'object'
          : 'array',
      type: this.convertType(this.requiredType(parameter, parameter.type, 'parameter')),
      optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
      rest: parameter.dotDotDotToken !== undefined,
      receiver: ts.isIdentifier(parameter.name) && parameter.name.text === 'this',
      ...(parameter.initializer === undefined ? {} : { initializer: parameter.initializer.getText() }),
    }))
    return {
      typeParameters: this.typeParameters(node.typeParameters),
      parameters,
      returns: ts.isSetAccessorDeclaration(node)
        ? this.addNode(node, { kind: 'keyword', name: 'void' })
        : this.convertType(this.requiredType(node, explicitReturn, 'return')),
    }
  }

  private typeParameters(
    parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  ): TypeParameterModel[] {
    return parameters?.map(parameter => ({
      id: `${this.locationKey(parameter)}#${parameter.name.text}`,
      name: parameter.name.text,
      const: hasModifier(parameter, ts.SyntaxKind.ConstKeyword),
      ...(parameter.constraint === undefined ? {} : { constraint: this.convertType(parameter.constraint) }),
      ...(parameter.default === undefined ? {} : { default: this.convertType(parameter.default) }),
      ...(hasModifier(parameter, ts.SyntaxKind.InKeyword) && hasModifier(parameter, ts.SyntaxKind.OutKeyword)
        ? { variance: 'in-out' as const }
        : hasModifier(parameter, ts.SyntaxKind.InKeyword)
          ? { variance: 'in' as const }
          : hasModifier(parameter, ts.SyntaxKind.OutKeyword)
            ? { variance: 'out' as const }
            : {}),
    })) ?? []
  }

  private mergeTypeParameters(
    parts: readonly (readonly TypeParameterModel[])[],
    site: ts.Node,
    declarationName: string,
  ): TypeParameterModel[] {
    const first = parts[0] as readonly TypeParameterModel[]
    return first.map((parameter, index) => {
      const peers = parts.map(part => part[index] as TypeParameterModel)
      const constraint = peers.find(peer => peer.constraint !== undefined)?.constraint
      const fallback = peers.find(peer => peer.default !== undefined)?.default
      const variances = [...new Set(peers.flatMap(peer => peer.variance === undefined ? [] : [peer.variance]))]
      if (variances.length > 1) {
        this.fail(site, `merged interface ${declarationName} has incompatible variance modifiers`)
      }
      return {
        id: parameter.id,
        name: parameter.name,
        const: peers.some(peer => peer.const),
        ...(constraint === undefined ? {} : { constraint }),
        ...(fallback === undefined ? {} : { default: fallback }),
        ...(variances[0] === undefined ? {} : { variance: variances[0] }),
      }
    })
  }

  /**
   * Return an authored type or, in write mode, queue the edit that adds its inferred annotation and
   * stop the pass there; check mode reports the missing annotation instead.
   * @param owner - Node whose missing annotation is at stake.
   * @param type - Authored type, when the source has one.
   * @param purpose - Public boundary the annotation belongs to.
   * @returns The authored type, which is the only path a caller sees completed.
   */
  public requiredType(
    owner: ts.Node,
    type: ts.TypeNode | undefined,
    purpose: 'property' | 'parameter' | 'return',
  ): ts.TypeNode {
    if (type !== undefined) return type
    if (this.mode === 'check') {
      this.fail(owner, `public ${purpose} is missing an explicit type annotation`)
    }
    const inferred = this.inferType(owner, purpose)
    const rendered = ts.createPrinter().printNode(ts.EmitHint.Unspecified, inferred, owner.getSourceFile())
    const position = annotationPosition(owner, purpose)
    this.queueEdit({ file: realPath(owner.getSourceFile().fileName), position, text: `: ${rendered}` })
    throw new SourceEditQueued()
  }

  private inferType(
    owner: ts.Node,
    purpose: 'property' | 'parameter' | 'return',
  ): ts.TypeNode {
    let type: ts.Type
    if (purpose === 'return') {
      const signature = this.checker.getSignatureFromDeclaration(owner as ts.SignatureDeclaration) as ts.Signature
      type = this.checker.getReturnTypeOfSignature(signature)
    } else {
      type = this.checker.getTypeAtLocation(owner)
    }
    return this.checker.typeToTypeNode(
      type,
      owner,
      ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
    ) as ts.TypeNode
  }

  /**
   * Convert one syntax node into a type node, allocating its id before recursing so a shared start
   * position keeps call order.
   * @param node - Type syntax node to convert.
   * @returns Id of the node model written for it.
   */
  public convertType(node: ts.TypeNode): TypeNodeId {
    const id = this.allocateNodeId(node)
    const add = (model: TypeNodeInput): TypeNodeId => {
      this.nodes.set(id, { id, ...model })
      return id
    }

    const keyword = keywordName(node.kind)
    if (keyword !== undefined) return add({ kind: 'keyword', name: keyword })
    if (ts.isParenthesizedTypeNode(node)) {
      return add({ kind: 'parenthesized', type: this.convertType(node.type) })
    }
    if (ts.isLiteralTypeNode(node)) return add(literalModel(node))
    if (ts.isTypeReferenceNode(node)) {
      const symbol = this.checker.getSymbolAtLocation(node.typeName) as ts.Symbol
      return add({
        kind: 'reference',
        name: node.typeName.getText(),
        target: this.targetForReference(this.resolveSymbol(symbol), node),
        arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
      })
    }
    if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
      return add({
        kind: ts.isUnionTypeNode(node) ? 'union' : 'intersection',
        types: node.types.map(type => this.convertType(type)),
      })
    }
    if (ts.isArrayTypeNode(node)) return add({ kind: 'array', element: this.convertType(node.elementType) })
    if (ts.isTupleTypeNode(node)) {
      return add({
        kind: 'tuple',
        elements: node.elements.map((element) => {
          const named = ts.isNamedTupleMember(element) ? element : undefined
          const raw = named?.type ?? element
          const optional = named?.questionToken !== undefined || ts.isOptionalTypeNode(raw)
          const rest = named?.dotDotDotToken !== undefined || ts.isRestTypeNode(raw)
          const type = ts.isOptionalTypeNode(raw) || ts.isRestTypeNode(raw) ? raw.type : raw
          return {
            ...(named === undefined ? {} : { name: named.name.text }),
            type: this.convertType(type),
            optional,
            rest,
          }
        }),
      })
    }
    if (ts.isTypeLiteralNode(node)) return add({ kind: 'object', members: this.members(node.members, id) })
    if (ts.isFunctionTypeNode(node)) {
      return add({ kind: 'function', signature: this.signature(node, node.type) })
    }
    if (ts.isConstructorTypeNode(node)) {
      return add({
        kind: 'constructor',
        abstract: hasModifier(node, ts.SyntaxKind.AbstractKeyword),
        signature: this.signature(node, node.type),
      })
    }
    if (ts.isIndexedAccessTypeNode(node)) {
      return add({
        kind: 'indexed-access',
        object: this.convertType(node.objectType),
        index: this.convertType(node.indexType),
      })
    }
    if (ts.isTypeOperatorNode(node)) {
      return add({
        kind: 'operator',
        operator: ts.tokenToString(node.operator) as TypeOperatorName,
        type: this.convertType(node.type),
      })
    }
    if (ts.isConditionalTypeNode(node)) {
      return add({
        kind: 'conditional',
        check: this.convertType(node.checkType),
        extends: this.convertType(node.extendsType),
        whenTrue: this.convertType(node.trueType),
        whenFalse: this.convertType(node.falseType),
      })
    }
    if (ts.isInferTypeNode(node)) {
      return add({ kind: 'infer', parameter: this.typeParameters(ts.factory.createNodeArray([node.typeParameter]))[0] as TypeParameterModel })
    }
    if (ts.isMappedTypeNode(node)) {
      const parameter = this.typeParameters(ts.factory.createNodeArray([node.typeParameter]))[0] as TypeParameterModel
      return add({
        kind: 'mapped',
        parameter,
        ...(node.nameType === undefined ? {} : { nameType: this.convertType(node.nameType) }),
        ...(node.type === undefined ? {} : { value: this.convertType(node.type) }),
        readonly: modifierMode(node.readonlyToken),
        optional: modifierMode(node.questionToken),
      })
    }
    if (ts.isTemplateLiteralTypeNode(node)) {
      return add({
        kind: 'template-literal',
        head: node.head.text,
        spans: node.templateSpans.map(span => ({ type: this.convertType(span.type), text: span.literal.text })),
      })
    }
    if (ts.isTypeQueryNode(node)) {
      return add({
        kind: 'type-query',
        expression: node.exprName.getText(),
        arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
      })
    }
    if (ts.isImportTypeNode(node)) {
      const argument = node.argument as ts.LiteralTypeNode & { readonly literal: ts.StringLiteral }
      const symbol = node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
      return add({
        kind: 'import-type',
        module: argument.literal.text,
        ...(node.qualifier === undefined ? {} : { qualifier: node.qualifier.getText() }),
        arguments: node.typeArguments?.map(argument => this.convertType(argument)) ?? [],
        typeof: node.isTypeOf,
        ...(node.attributes === undefined ? {} : { attributes: importTypeAttributesText(node) }),
        ...(symbol === undefined ? {} : { target: this.targetForReference(this.resolveSymbol(symbol), node) }),
      })
    }
    if (ts.isTypePredicateNode(node)) {
      return add({
        kind: 'predicate',
        asserts: node.assertsModifier !== undefined,
        parameter: node.parameterName.getText(),
        ...(node.type === undefined ? {} : { type: this.convertType(node.type) }),
      })
    }
    /* v8 ignore else -- every source TypeNode kind accepted by TypeScript is handled above; this arm keeps
     * future compiler kinds fail-loud. */
    if (ts.isThisTypeNode(node)) return add({ kind: 'this' })
    /* v8 ignore next -- paired with the exhaustive TypeNode guard above. */
    this.fail(node, `unsupported TypeScript type node ${ts.SyntaxKind[node.kind]}`)
  }

  /**
   * Store one node model under a fresh id at its site.
   * @param site - Node whose position orders the id.
   * @param model - Node model without its id.
   * @returns The allocated node id.
   */
  public addNode(site: ts.Node, model: TypeNodeInput): TypeNodeId {
    const id = this.allocateNodeId(site)
    this.nodes.set(id, { id, ...model })
    return id
  }

  /**
   * Store a reference node pointing at a symbol's declaration.
   * @param symbol - Referenced symbol.
   * @param site - Node the reference is written at.
   * @returns The allocated node id.
   */
  public referenceNode(symbol: ts.Symbol, site: ts.Node): TypeNodeId {
    return this.addNode(site, {
      kind: 'reference',
      name: symbol.name,
      target: { kind: 'declaration', symbol: this.symbolId(symbol) },
      arguments: [],
    })
  }

  private targetForReference(symbol: ts.Symbol, site: ReferenceSite): TypeTargetModel {
    const declaration = preferredDeclaration(symbol)
    /* v8 ignore next -- a symbol from a semantically valid source type reference always has a declaration. */
    if (declaration === undefined) this.fail(site, `type symbol ${symbol.name} has no declaration`)
    if (ts.isTypeParameterDeclaration(declaration)) {
      return {
        kind: 'type-parameter',
        parameter: `${this.locationKey(declaration)}#${declaration.name.text}`,
      }
    }
    if (isStandardLibraryFile(declaration.getSourceFile().fileName)) {
      return { kind: 'standard', name: symbol.name }
    }

    const moduleSpecifier = moduleSpecifierOf(site)
    const from = this.registrationForFile(site.getSourceFile().fileName) as PackageRegistration
    const owner = this.registrationForFile(declaration.getSourceFile().fileName)
    if (owner !== undefined) {
      if (owner.name !== from.name) {
        const imported = moduleSpecifier === undefined
          ? undefined
          : this.packageImportOf(site, moduleSpecifier, symbol, from)
        if (imported === undefined) {
          this.fail(site, `reference to ${symbol.name} crosses a package without an explicit package import`)
        }
        if (this.packageExportName(imported.module, symbol, owner.face, imported.name) === undefined) {
          this.fail(
            site,
            `package reference ${imported.name} is not exported by ${imported.module.package} at ${imported.module.subpath}`,
          )
        }
      }
      const typeDeclaration = declaration as ts.ClassDeclaration | ts.InterfaceDeclaration
        | ts.TypeAliasDeclaration | ts.EnumDeclaration
      if (!this.declarationStates.has(this.symbolId(symbol))) this.ensureDeclaration(symbol, typeDeclaration)
      return { kind: 'declaration', symbol: this.symbolId(symbol) }
    }

    const imported = moduleSpecifier === undefined
      ? undefined
      : this.packageImportOf(site, moduleSpecifier, symbol, from)
    const packageFaces = imported === undefined
      ? []
      : [...new Set(this.allRegistrations.filter(candidate => candidate.name === imported.module.package).map(candidate => candidate.face))]
    const otherFace = packageFaces.find(face => face !== this.face)
    if (otherFace !== undefined && imported !== undefined) {
      const { module } = imported
      const exportName = this.packageExportName(module, symbol, otherFace, imported.name)
      if (exportName === undefined) {
        this.fail(site, `cross-face reference ${imported.name} is not exported by ${module.package} at ${module.subpath}`)
      }
      this.recordCrossFaceLink(from.name, otherFace, module, exportName)
      return {
        kind: 'cross-face',
        face: otherFace,
        package: module.package,
        subpath: module.subpath,
        name: exportName,
      }
    }

    if (imported !== undefined) {
      return {
        kind: 'external',
        module: imported.module.package,
        subpath: imported.module.subpath,
        name: symbol.name,
      }
    }

    const external = externalModuleIdentityForFile(declaration.getSourceFile().fileName)
    if (external !== undefined) {
      return {
        kind: 'external',
        module: external.package,
        subpath: external.subpath,
        name: symbol.name,
      }
    }

    this.fail(site, `reference to ${symbol.name} crosses a package or face without an explicit import`)
  }

  /**
   * Resolve the symbol a type node names, following alias symbols.
   * @param node - Type node to read.
   * @returns The resolved symbol, or undefined when the node names none.
   */
  public symbolAtType(node: ts.TypeNode): ts.Symbol | undefined {
    if (ts.isTypeReferenceNode(node)) {
      return this.resolveSymbol(this.checker.getSymbolAtLocation(node.typeName) as ts.Symbol)
    }
    const type = this.checker.getTypeAtLocation(node)
    const symbol = type.aliasSymbol ?? type.getSymbol()
    return symbol === undefined ? undefined : this.resolveSymbol(symbol)
  }

  /**
   * Resolve an import alias to the symbol it denotes.
   * @param symbol - Symbol to resolve.
   * @returns The aliased symbol, or the input when it is not an alias.
   */
  public resolveSymbol(symbol: ts.Symbol): ts.Symbol {
    return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol)
  }

  /**
   * Derive the stable id of a symbol from its package and its declaration's file position.
   * @param symbol - Symbol to identify.
   * @returns The symbol id, which falls back to the bare name without a declaration.
   */
  public symbolId(symbol: ts.Symbol): SymbolId {
    const declaration = preferredDeclaration(symbol)
    if (declaration === undefined) return `symbol:${symbol.name}`
    const location = this.location(declaration)
    return `${this.packageNameForFile(declaration.getSourceFile().fileName)}:${location.file}#${symbol.name}`
  }

  private packageNameForFile(file: string): string {
    const path = realPath(file)
    return this.allRegistrations.find(registration => isWithin(path, registration.root))?.name ?? '<external>'
  }

  /**
   * Mint the id of one node: its file position plus the ordinal this call takes at that position.
   * @param site - Node whose position owns the id.
   * @returns The minted node id.
   */
  public allocateNodeId(site: ts.Node): TypeNodeId {
    const location = this.locationKey(site)
    const ordinal = (this.nodeOrdinals.get(location) ?? 0) + 1
    this.nodeOrdinals.set(location, ordinal)
    return `type:${location}#${String(ordinal)}`
  }

  private locationKey(node: ts.Node): string {
    const location = this.location(node)
    return `${location.file}:${String(location.line)}:${String(location.column)}`
  }

  /**
   * Read a node's 1-based source location relative to the workspace root.
   * @param node - Node to locate.
   * @returns The node's file, line, and column.
   */
  public location(node: ts.Node): SourceLocation {
    const sourceFile = node.getSourceFile()
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return {
      file: slash(relative(this.root, sourceFile.fileName)),
      line: position.line + 1,
      column: position.character + 1,
    }
  }

  /**
   * Stop the analysis with a located diagnostic.
   * @param node - Node the diagnostic points at.
   * @param message - Diagnostic text.
   * @returns Never: the located throw is this call's result.
   */
  public fail(node: ts.Node, message: string): never {
    const location = this.location(node)
    throw new TypertAnalysisError(
      `typert(${this.face}): ${location.file}:${String(location.line)}:${String(location.column)}: ${message}`,
    )
  }
}
