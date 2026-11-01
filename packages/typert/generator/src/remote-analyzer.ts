/**
 * The Remote/RPC analyzer of one face: the decorator and gateway readings that mark an invocation,
 * the type-meta maps a lookup or Context argument comes from, the strict JSON boundary every wire
 * field projects to, and the invocation models the emitter consumes.
 *
 * The declarations and nodes those boundaries produce belong to {@link TypeGraph}, which owns their
 * ids; this module reads and writes them through it.
 * @module @deepseek-ai/dsh-typert-generator/remote-analyzer
 */

import ts from 'typescript'
import type {
  InvocationModel,
  InvocationParameterModel,
  MemberModel,
  PackageModel,
  RemoteBoundaryModel,
  RemoteTypeImportModel,
  SymbolId,
  TypeNodeId,
  TypeNodeModel,
  TypertFace,
} from './model.ts'
import { isStandardLibraryFile, realPath } from './module-path.ts'
import {
  documentationOf,
  hasModifier,
  isRemoteSegment,
  memberName,
  packageExportSpecifier,
  preferredDeclaration,
  stringLiteralValue,
  visibilityOf,
} from './node-text.ts'
import { packageExportTargets, sourcePathForExport } from './package-exports.ts'
import { EMPTY_DOCUMENTATION, TypertAnalysisError } from './types.ts'
import type { PackageRegistration } from './types.ts'
import type { TypeGraph, TypeNodeInput } from './type-graph.ts'

const PUBLIC_REMOTE_TYPE_ROOTS = new Set([
  '@deepseek-ai/dsh-util-values',
])

interface StaticLookupDeclaration {
  readonly key: string
  readonly hostSymbol: SymbolId
  readonly wireType: ts.TypeNode
  readonly site: ts.Node
}

interface StaticContextDeclaration {
  readonly key: string
  readonly wireType: ts.TypeNode
  readonly site: ts.Node
}

interface GatewayBinding {
  readonly service: string
  readonly namespace: string
  readonly site: ts.Node
}

/**
 * Facts the Remote/RPC analyzer reads from the analyzed face, and the graph it writes through.
 */
interface RemoteAnalyzerDeps {
  /** Checker of the face program, used to resolve every authored wire type. */
  readonly checker: ts.TypeChecker
  /** Face program whose type-meta declarations list the lookup and Context keys. */
  readonly program: ts.Program
  /** Declaration, node, and id ownership shared with the rest of the face analysis. */
  readonly graph: TypeGraph
  /** Registration owning a source file, when this face has one. */
  readonly registrationForFile: (file: string) => PackageRegistration | undefined
  /** Parsed source files of the face program, keyed by real path. */
  readonly sourceFiles: ReadonlyMap<string, ts.SourceFile>
}

/**
 * Reads the Remote/RPC contract of one face: which methods are invocations, what each wire field
 * carries, and how the strict codec types project onto the type graph.
 */
export class RemoteAnalyzer {
  private readonly checker: ts.TypeChecker
  private readonly program: ts.Program
  private readonly graph: TypeGraph
  private readonly registrationForFile: (file: string) => PackageRegistration | undefined
  private readonly sourceFiles: ReadonlyMap<string, ts.SourceFile>
  private staticLookups: readonly StaticLookupDeclaration[] | undefined
  private staticContexts: ReadonlyMap<string, StaticContextDeclaration> | undefined

  constructor(deps: RemoteAnalyzerDeps) {
    this.checker = deps.checker
    this.program = deps.program
    this.graph = deps.graph
    this.registrationForFile = deps.registrationForFile
    this.sourceFiles = deps.sourceFiles
  }

  /**
   * Collect every Remote invocation one package declares.
   * @param registration - Package whose reachable classes are read.
   * @param reachable - Source files whose class declarations may carry Remote methods.
   * @returns One model per decorated method, in declaration order.
   */
  collectInvocations(
    registration: PackageRegistration,
    reachable: readonly ts.SourceFile[],
  ): InvocationModel[] {
    const result: InvocationModel[] = []
    for (const sourceFile of reachable) {
      for (const statement of sourceFile.statements) {
        if (!ts.isClassDeclaration(statement)) continue
        const marked = statement.members.flatMap((member) => {
          const invocation = this.remoteMarker(member)
          if (invocation === undefined) return []
          if (!ts.isMethodDeclaration(member)) {
            this.graph.fail(member, 'Remote decorators require a public instance method')
          }
          return [{ method: member, invocation }]
        })
        const first = marked[0]
        if (first === undefined) continue
        const binding = this.gatewayBinding(statement)
        if (binding === undefined) {
          this.graph.fail(
            first.method,
            'Remote methods require TypertRemoteService or readonly typertGateway = bindTypertRemote(this, serviceKey)',
          )
        }
        for (const { method, invocation } of marked) {
          result.push(this.invocationModel(registration, binding, method, invocation))
        }
      }
    }
    return result
  }

  private invocationModel(
    registration: PackageRegistration,
    binding: GatewayBinding,
    method: ts.MethodDeclaration,
    invocation:
      | { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
      | { readonly kind: 'context'; readonly context: string; readonly exportName?: string },
  ): InvocationModel {
    if (visibilityOf(method) !== 'public' || hasModifier(method, ts.SyntaxKind.StaticKeyword)) {
      this.graph.fail(method, 'Remote decorators require a public instance method')
    }
    if (hasModifier(method, ts.SyntaxKind.AbstractKeyword) || method.body === undefined) {
      this.graph.fail(method, 'Remote methods must have a concrete implementation')
    }
    if (!ts.isIdentifier(method.name)) {
      this.graph.fail(method, 'Remote method names must be identifiers')
    }
    if ((method.typeParameters?.length ?? 0) > 0) {
      this.graph.fail(method, 'generic Remote methods are not supported')
    }
    const documentation = documentationOf(method)
    const methodName = method.name.text
    const exportedMethod = invocation.exportName ?? methodName

    const lookups = this.lookupDeclarations()
    const lookupByHost = new Map(lookups.map(lookup => [lookup.hostSymbol, lookup]))
    const parameters: InvocationParameterModel[] = []
    let cancellation: InvocationModel['cancellation']
    const wires = new Set<string>()
    for (const [parameterIndex, parameter] of method.parameters.entries()) {
      if (!ts.isIdentifier(parameter.name)) {
        this.graph.fail(parameter, 'Remote parameters must use identifier bindings')
      }
      if (parameter.dotDotDotToken !== undefined) this.graph.fail(parameter, 'Remote parameters cannot be rest parameters')
      if (parameter.initializer !== undefined) this.graph.fail(parameter, 'Remote parameters cannot have default values')
      if (parameter.name.text === 'this') this.graph.fail(parameter, 'Remote methods cannot declare an explicit this parameter')
      const optional = parameter.questionToken !== undefined
      const authoredType = this.graph.requiredType(parameter, parameter.type, 'parameter')
      const cancellationName = parameter.name.text === 'signal'
      const cancellationType = this.isGlobalAbortSignal(authoredType)
      if (cancellationName || cancellationType) {
        if (!cancellationName || !cancellationType) {
          this.graph.fail(parameter, 'Remote cancellation must use a parameter named signal with the global AbortSignal type')
        }
        if (parameterIndex !== method.parameters.length - 1) {
          this.graph.fail(parameter, 'Remote cancellation signal must be the final parameter')
        }
        cancellation = { parameter: 'signal' }
        continue
      }
      const hostSymbol = this.graph.symbolAtType(authoredType)
      const lookup = hostSymbol === undefined ? undefined : lookupByHost.get(this.graph.symbolId(hostSymbol))
      let modeled: InvocationParameterModel
      if (lookup !== undefined) {
        if (optional) this.graph.fail(parameter, `lookup parameter for ${lookup.key} cannot be optional`)
        if (parameter.name.text !== lookup.key) {
          this.graph.fail(parameter, `lookup parameter for ${lookup.key} must also be named ${lookup.key}`)
        }
        const boundary = this.remoteBoundary(
          lookup.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:${lookup.key}Id`,
          true,
        )
        modeled = {
          name: parameter.name.text,
          wire: `${lookup.key}Id`,
          source: 'lookup',
          lookup: lookup.key,
          boundary,
        }
      } else {
        if (hostSymbol !== undefined && this.isWorkspaceClass(hostSymbol)) {
          this.graph.fail(parameter, `non-JSON class parameter ${hostSymbol.name} requires a TypertLookupMap entry`)
        }
        modeled = {
          name: parameter.name.text,
          wire: parameter.name.text,
          source: 'json',
          ...optional ? { optional: true as const } : {},
          boundary: this.remoteBoundary(
            authoredType,
            `${registration.name}#${binding.namespace}/${exportedMethod}:${parameter.name.text}`,
            false,
            'undefined',
            optional,
          ),
        }
      }
      if (wires.has(modeled.wire)) this.graph.fail(parameter, `duplicate Remote wire field ${modeled.wire}`)
      wires.add(modeled.wire)
      const description = documentation.tags.find(tag => tag.name === 'param' && tag.argument === modeled.name)?.comment?.replace(/^[-—–]\s*/, '')
      parameters.push({ ...modeled, ...(description === undefined ? {} : { description }) })
    }

    let receiver: InvocationModel['invocation'] = { kind: 'direct' }
    if (invocation.kind === 'context') {
      const context = this.contextDeclarations().get(invocation.context)
      if (context === undefined) {
        this.graph.fail(method, `Remote Scope ${invocation.context} has no TypertContextMap entry`)
      }
      const wire = `${invocation.context}Id`
      if (wires.has(wire)) this.graph.fail(method, `Remote Scope wire field ${wire} conflicts with a method parameter`)
      receiver = {
        kind: 'context',
        context: invocation.context,
        wire,
        boundary: this.remoteBoundary(
          context.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:${wire}`,
          true,
        ),
      }
    }

    let scope: InvocationModel['scope']
    if (invocation.kind === 'direct') {
      const lookupParameters = parameters.filter(parameter => parameter.source === 'lookup')
      const parameter = lookupParameters.length === 1 ? lookupParameters[0] : undefined
      const context = parameter?.lookup === undefined
        ? undefined
        : this.contextDeclarations().get(parameter.lookup)
      if (parameter !== undefined && context !== undefined) {
        const contextBoundary = this.remoteBoundary(
          context.wireType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:scope:${context.key}`,
          true,
        )
        if (contextBoundary.typeSymbol !== parameter.boundary.typeSymbol) {
          this.graph.fail(
            method,
            `Remote scope ${context.key} wire type ${contextBoundary.typeSymbol} does not match lookup wire type ${parameter.boundary.typeSymbol}`,
          )
        }
        scope = { context: context.key, wire: parameter.wire }
      }
    }

    const mode = invocation.kind === 'direct' ? invocation.mode : undefined
    const { result: resultType, uplink: uplinkType } = this.remoteResultType(method, mode)
    const uplink: InvocationModel['uplink'] = uplinkType === undefined
      ? undefined
      : {
        boundary: this.remoteBoundary(
          uplinkType,
          `${registration.name}#${binding.namespace}/${exportedMethod}:uplink`,
          false,
          'undefined',
        ),
      }
    return {
      ...documentation,
      id: `${registration.name}#${binding.namespace}/${exportedMethod}`,
      service: binding.service,
      namespace: binding.namespace,
      method: exportedMethod,
      ...(exportedMethod === methodName ? {} : { implementation: methodName }),
      ...(mode === undefined ? {} : { mode }),
      invocation: receiver,
      ...(scope === undefined ? {} : { scope }),
      parameters,
      ...(uplink === undefined ? {} : { uplink }),
      ...(cancellation === undefined ? {} : { cancellation }),
      result: this.remoteBoundary(
        resultType,
        `${registration.name}#${binding.namespace}/${exportedMethod}:result`,
        false,
        'undefined-or-void',
        false,
        mode === undefined,
      ),
      location: this.graph.location(method.name),
    }
  }

  private gatewayBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const field = this.gatewayFieldBinding(declaration)
    const base = this.gatewayServiceBinding(declaration)
    if (field !== undefined && base !== undefined) {
      this.graph.fail(field.site, 'TypertRemoteService subclasses must not declare a second typertRemote binding')
    }
    return field ?? base
  }

  private gatewayFieldBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const candidates = declaration.members.filter((member): member is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(member) && memberName(member.name) === 'typertRemote')
    const [property, duplicate] = candidates
    if (property === undefined) return undefined
    if (duplicate !== undefined) this.graph.fail(duplicate, 'Service has more than one typertGateway field')
    if (visibilityOf(property) !== 'public'
      || hasModifier(property, ts.SyntaxKind.StaticKeyword)
      || !hasModifier(property, ts.SyntaxKind.ReadonlyKeyword)) {
      this.graph.fail(property, 'typertGateway must be a public readonly instance field')
    }
    if (property.initializer === undefined
      || !ts.isCallExpression(property.initializer)
      || !this.graph.isTypeMetaSymbol(property.initializer.expression, 'bindTypertRemote')) {
      this.graph.fail(property, 'typertGateway must call bindTypertRemote()')
    }
    const call = property.initializer
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      this.graph.fail(call, 'bindTypertRemote() requires this, service key, and an optional options object')
    }
    if (call.arguments[0]?.kind !== ts.SyntaxKind.ThisKeyword) {
      this.graph.fail(call.arguments[0] ?? call, 'bindTypertRemote() first argument must be this')
    }
    return this.gatewayBindingArguments(call, property)
  }

  private gatewayServiceBinding(declaration: ts.ClassDeclaration): GatewayBinding | undefined {
    const heritage = (declaration.heritageClauses ?? [])
      .filter(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)
      .flatMap(clause => [...clause.types])
      .find(type => this.graph.isTypeMetaSymbol(type.expression, 'TypertRemoteService'))
    if (heritage === undefined) return undefined

    const constructor = declaration.members.find(ts.isConstructorDeclaration)
    if (constructor?.body === undefined) {
      this.graph.fail(heritage, 'TypertRemoteService subclasses must declare a constructor with super(ctx, serviceKey)')
    }
    const call = constructor.body.statements.flatMap((statement) => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return []
      return statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword ? [statement.expression] : []
    })[0]
    if (call === undefined) {
      this.graph.fail(constructor, 'TypertRemoteService constructor must call super(ctx, serviceKey) directly')
    }
    if (call.arguments.length < 2 || call.arguments.length > 3) {
      this.graph.fail(call, 'TypertRemoteService super() requires context, service key, and an optional options object')
    }
    return this.gatewayBindingArguments(call, heritage)
  }

  private gatewayBindingArguments(call: ts.CallExpression, site: ts.Node): GatewayBinding {
    const serviceArgument = call.arguments[1]
    if (serviceArgument === undefined) this.graph.fail(call, 'Gateway service key must be a string literal')
    const service = stringLiteralValue(serviceArgument)
    if (service === undefined) this.graph.fail(serviceArgument, 'Gateway service key must be a string literal')
    let namespace = service
    const options = call.arguments[2]
    if (options !== undefined) {
      if (!ts.isObjectLiteralExpression(options)) {
        this.graph.fail(options, 'bindTypertRemote() options must be an object literal')
      }
      for (const propertyOption of options.properties) {
        if (!ts.isPropertyAssignment(propertyOption)
          || memberName(propertyOption.name) !== 'namespace') {
          this.graph.fail(propertyOption, 'bindTypertRemote() only supports a namespace option')
        }
        const value = stringLiteralValue(propertyOption.initializer)
        if (value === undefined) this.graph.fail(propertyOption.initializer, 'Gateway namespace must be a string literal')
        namespace = value
      }
    }
    if (!isRemoteSegment(service)) this.graph.fail(serviceArgument, 'Gateway service key must contain only RPC endpoint segment characters')
    if (!isRemoteSegment(namespace)) this.graph.fail(options ?? call, 'Gateway namespace must contain only RPC endpoint segment characters')
    return { service, namespace, site }
  }

  /**
   * Read the options object of `@Remote` or `@RemoteScope`. `resources`
   * accepts any expression: its readers run only at runtime, where the
   * Gateway reads them from the prototype descriptor, so generation records
   * nothing for them.
   */
  private remoteOptions(
    argument: ts.Expression,
    decorator: 'Remote' | 'RemoteScope',
  ): { readonly exportName?: string; readonly mode?: 'stream' } {
    const requirement = decorator === 'Remote'
      ? 'Remote() options require name, mode: "stream", or resources'
      : 'RemoteScope() options require name or resources'
    if (!ts.isObjectLiteralExpression(argument) || argument.properties.length === 0) this.graph.fail(argument, requirement)
    let options: { readonly exportName?: string; readonly mode?: 'stream' } = {}
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property)) this.graph.fail(property, `${decorator}() options must use named values`)
      const name = memberName(property.name)
      if (decorator === 'Remote' && name === 'mode' && stringLiteralValue(property.initializer) === 'stream') {
        options = { ...options, mode: 'stream' }
      } else if (name === 'name') {
        const value = stringLiteralValue(property.initializer)
        if (value === undefined || !isRemoteSegment(value)) this.graph.fail(property, `${decorator}() name must be an endpoint segment`)
        options = { ...options, exportName: value }
      } else if (name !== 'resources') {
        this.graph.fail(property, requirement)
      }
    }
    return options
  }

  private remoteMarker(
    member: ts.ClassElement,
  ):
    | { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
    | { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
    | undefined {
    let found:
      | { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
      | { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
      | undefined
    for (const decorator of ts.canHaveDecorators(member) ? ts.getDecorators(member) ?? [] : []) {
      const expression = decorator.expression
      let marker: typeof found
      if (this.graph.isTypeMetaSymbol(expression, 'Remote')) {
        marker = { kind: 'direct' }
      } else if (ts.isCallExpression(expression)
        && this.graph.isTypeMetaSymbol(expression.expression, 'Remote')) {
        if (expression.arguments.length !== 1) this.graph.fail(expression, 'Remote() requires one name or options object')
        const argument = expression.arguments[0]
        if (argument === undefined) this.graph.fail(expression, 'Remote() requires one name or options object')
        const exportName = stringLiteralValue(argument)
        if (exportName !== undefined) {
          if (!isRemoteSegment(exportName)) {
            this.graph.fail(argument, 'Remote() name must contain only RPC endpoint segment characters')
          }
          marker = { kind: 'direct', exportName }
        } else {
          marker = { kind: 'direct', ...this.remoteOptions(argument, 'Remote') }
        }
      } else if (ts.isCallExpression(expression)
        && this.graph.isTypeMetaSymbol(expression.expression, 'RemoteScope')) {
        if (expression.arguments.length < 1 || expression.arguments.length > 2) {
          this.graph.fail(expression, 'RemoteScope() requires a Context key and optional exported method name')
        }
        const context = stringLiteralValue(expression.arguments[0])
        if (context === undefined || !isRemoteSegment(context)) {
          this.graph.fail(expression.arguments[0] ?? expression, 'RemoteScope() key must be a string literal containing only RPC endpoint segment characters')
        }
        const option = expression.arguments[1]
        const exportName = option === undefined ? undefined : stringLiteralValue(option)
        if (option === undefined || exportName !== undefined) {
          if (exportName !== undefined && !isRemoteSegment(exportName)) {
            this.graph.fail(option ?? expression, 'RemoteScope() name must be a string literal containing only RPC endpoint segment characters')
          }
          marker = { kind: 'context', context, ...exportName === undefined ? {} : { exportName } }
        } else {
          const options = this.remoteOptions(option, 'RemoteScope')
          marker = { kind: 'context', context, ...options.exportName === undefined ? {} : { exportName: options.exportName } }
        }
      } else {
        continue
      }
      if (found !== undefined) this.graph.fail(decorator, 'a method can have only one Remote invocation decorator')
      found = marker
    }
    return found
  }

  /**
   * The item types a Remote method's authored return type declares. Unary
   * methods unwrap `Promise<T>`; stream methods unwrap `Iterable<Out>`,
   * `AsyncIterable<Out>`, or the protocol's `RemoteStream<Out, In>`, whose
   * second type argument is the uplink item type unless it is `never`.
   */
  private remoteResultType(
    method: ts.MethodDeclaration,
    mode?: 'stream',
  ): { readonly result: ts.TypeNode; readonly uplink?: ts.TypeNode } {
    const authored = this.graph.requiredType(method, method.type, 'return')
    if (ts.isTypeReferenceNode(authored)) {
      const symbol = this.checker.getSymbolAtLocation(authored.typeName)
      const resolved = symbol === undefined ? undefined : this.graph.resolveSymbol(symbol)
      const declaration = resolved === undefined ? undefined : preferredDeclaration(resolved)
      const [result, uplink] = authored.typeArguments ?? []
      const arity = authored.typeArguments?.length ?? 0
      if (resolved !== undefined && declaration !== undefined && result !== undefined) {
        const standard = isStandardLibraryFile(declaration.getSourceFile().fileName)
        const wrappers = mode === undefined ? ['Promise'] : ['Iterable', 'AsyncIterable']
        if (standard && wrappers.includes(resolved.name) && arity === 1) return { result }
        if (mode !== undefined
          && resolved.name === 'RemoteStream'
          && this.graph.isTypeMetaSymbol(authored.typeName, 'RemoteStream')
          && arity <= 2) {
          return uplink === undefined || this.isNeverType(uplink) ? { result } : { result, uplink }
        }
      }
    }
    if (mode !== undefined) {
      this.graph.fail(method, 'stream Remote methods must return Iterable<Out>, AsyncIterable<Out>, or RemoteStream<Out, In>')
    }
    return { result: authored }
  }

  private isNeverType(type: ts.TypeNode): boolean {
    return (this.checker.getTypeFromTypeNode(type).flags & ts.TypeFlags.Never) !== 0
  }

  private isGlobalAbortSignal(type: ts.TypeNode): boolean {
    const symbol = this.graph.symbolAtType(type)
    if (symbol?.name !== 'AbortSignal') return false
    return symbol.declarations?.some(declaration =>
      isStandardLibraryFile(declaration.getSourceFile().fileName)) === true
  }

  private lookupDeclarations(): readonly StaticLookupDeclaration[] {
    if (this.staticLookups !== undefined) return this.staticLookups
    const byKey = new Map<string, StaticLookupDeclaration>()
    const byHost = new Map<SymbolId, StaticLookupDeclaration>()
    for (const declaration of this.typeMetaMapMembers('TypertLookupMap')) {
      if (!ts.isPropertySignature(declaration) || declaration.type === undefined) {
        this.graph.fail(declaration, 'TypertLookupMap entries must be required properties')
      }
      const key = memberName(declaration.name)
      if (!isRemoteSegment(key)) this.graph.fail(declaration.name, 'TypertLookupMap key must contain only RPC endpoint segment characters')
      if (!ts.isTypeReferenceNode(declaration.type)
        || !this.graph.isTypeMetaSymbol(declaration.type.typeName, 'TypertLookup')
        || declaration.type.typeArguments?.length !== 2) {
        this.graph.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
      }
      const hostType = declaration.type.typeArguments[0]
      const wireType = declaration.type.typeArguments[1]
      if (hostType === undefined || wireType === undefined) {
        this.graph.fail(declaration.type, 'TypertLookupMap values must be TypertLookup<Host, Wire>')
      }
      const host = this.graph.symbolAtType(hostType)
      if (host === undefined) this.graph.fail(hostType, 'TypertLookup Host must be a named type')
      const entry: StaticLookupDeclaration = {
        key,
        hostSymbol: this.graph.symbolId(host),
        wireType,
        site: declaration,
      }
      if (byKey.has(key)) this.graph.fail(declaration, `duplicate TypertLookupMap key ${key}`)
      if (byHost.has(entry.hostSymbol)) this.graph.fail(declaration, `Host type ${host.name} has more than one Typert lookup`)
      byKey.set(key, entry)
      byHost.set(entry.hostSymbol, entry)
    }
    this.staticLookups = [...byKey.values()]
    return this.staticLookups
  }

  private contextDeclarations(): ReadonlyMap<string, StaticContextDeclaration> {
    if (this.staticContexts !== undefined) return this.staticContexts
    const result = new Map<string, StaticContextDeclaration>()
    for (const declaration of this.typeMetaMapMembers('TypertContextMap')) {
      if (!ts.isPropertySignature(declaration) || declaration.type === undefined) {
        this.graph.fail(declaration, 'TypertContextMap entries must be required properties')
      }
      const key = memberName(declaration.name)
      if (!isRemoteSegment(key)) this.graph.fail(declaration.name, 'TypertContextMap key must contain only RPC endpoint segment characters')
      if (!ts.isTypeReferenceNode(declaration.type)
        || !this.graph.isTypeMetaSymbol(declaration.type.typeName, 'TypertContext')
        || declaration.type.typeArguments?.length !== 1) {
        this.graph.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
      }
      if (result.has(key)) this.graph.fail(declaration, `duplicate TypertContextMap key ${key}`)
      const wireType = declaration.type.typeArguments[0]
      if (wireType === undefined) this.graph.fail(declaration.type, 'TypertContextMap values must be TypertContext<Wire>')
      result.set(key, {
        key,
        wireType,
        site: declaration,
      })
    }
    this.staticContexts = result
    return result
  }

  private typeMetaMapMembers(name: 'TypertLookupMap' | 'TypertContextMap'): ts.TypeElement[] {
    const result: ts.TypeElement[] = []
    for (const sourceFile of this.program.getSourceFiles()) {
      for (const statement of sourceFile.statements) {
        if (!ts.isModuleDeclaration(statement)
          || !ts.isStringLiteral(statement.name)
          || statement.name.text !== '@deepseek-ai/dsh-typert-protocol'
          || statement.body === undefined
          || !ts.isModuleBlock(statement.body)) continue
        for (const nested of statement.body.statements) {
          if (ts.isInterfaceDeclaration(nested) && nested.name.text === name) result.push(...nested.members)
        }
      }
    }
    return result
  }

  private remoteBoundary(
    authoredType: ts.TypeNode,
    fallbackTypeSymbol: string,
    requireNamed: boolean,
    topLevelAbsence: 'reject' | 'undefined' | 'undefined-or-void' = 'reject',
    optional = false,
    allowBytes = false,
  ): RemoteBoundaryModel {
    const type = this.graph.convertType(authoredType)
    const declaredType = this.checker.getTypeFromTypeNode(authoredType)
    // An optional parameter's authored node carries no `undefined`; the codec
    // still has to accept the omitted wire field the consumer sends.
    const resolvedType = optional
      ? this.checker.getNullableType(declaredType, ts.TypeFlags.Undefined)
      : declaredType
    const codecType = this.resolvedRemoteCodecType(authoredType, resolvedType, topLevelAbsence, allowBytes)
    const acceptsUndefined = topLevelAbsence !== 'reject' && this.includesRemoteAbsence(resolvedType)
    const rootSymbol = this.namedWorkspaceType(authoredType)
    const imports = new Map<SymbolId, RemoteTypeImportModel>()
    const visit = (node: ts.Node): void => {
      if ((ts.isTypeReferenceNode(node) || ts.isImportTypeNode(node))) {
        const symbol = ts.isTypeReferenceNode(node)
          ? this.checker.getSymbolAtLocation(node.typeName)
          : node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
        if (symbol !== undefined) {
          const resolved = this.graph.resolveSymbol(symbol)
          const declaration = preferredDeclaration(resolved)
          if (declaration !== undefined
            && !isStandardLibraryFile(declaration.getSourceFile().fileName)
            && this.registrationForFile(declaration.getSourceFile().fileName) !== undefined) {
            const imported = this.publicRemoteType(resolved, node)
            imports.set(imported.symbol, imported)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(authoredType)
    if (rootSymbol !== undefined) {
      const imported = this.publicRemoteType(rootSymbol, authoredType)
      return {
        type,
        codecType,
        acceptsUndefined,
        typeSymbol: `${imported.specifier}#${imported.name}`,
        imports: [...imports.values()].sort((left, right) =>
          left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name)),
      }
    }
    if (requireNamed) this.graph.fail(authoredType, 'lookup and Context wire types must be named public types')
    return {
      type,
      codecType,
      acceptsUndefined,
      typeSymbol: fallbackTypeSymbol,
      imports: [...imports.values()].sort((left, right) =>
        left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name)),
    }
  }

  /**
   * Project one authored Remote boundary through the complete face Program.
   * Consumer declarations retain the authored alias, while codecs use this
   * concrete graph so declaration-merged mapped and conditional types are
   * validated without teaching the compiler-independent emitter TypeScript's
   * type evaluator.
   */
  private resolvedRemoteCodecType(
    authoredType: ts.TypeNode,
    resolvedType: ts.Type,
    topLevelAbsence: 'reject' | 'undefined' | 'undefined-or-void',
    allowBytes: boolean,
  ): TypeNodeId {
    this.assertRemoteJsonType(
      resolvedType,
      authoredType,
      new Set(),
      topLevelAbsence !== 'reject',
      topLevelAbsence === 'undefined-or-void',
      allowBytes,
    )
    const completed = new Map<ts.Type, TypeNodeId>()
    const active = new Map<ts.Type, TypeNodeId>()
    const recursiveDeclarations = new Map<ts.Type, SymbolId>()
    const convert = (type: ts.Type): TypeNodeId => {
      const cached = completed.get(type)
      if (cached !== undefined) return cached
      const activeId = active.get(type)
      if (activeId !== undefined) {
        if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
          const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
          const elementId = element === undefined ? undefined : active.get(element)
          if (element !== undefined && elementId !== undefined) {
            return this.graph.addNode(authoredType, {
              kind: 'array',
              element: this.resolvedCycleReference(
                element,
                authoredType,
                elementId,
                recursiveDeclarations,
              ),
            })
          }
        }
        return this.resolvedCycleReference(type, authoredType, activeId, recursiveDeclarations)
      }
      const id = this.graph.allocateNodeId(authoredType)
      active.set(type, id)
      try {
        const add = (model: TypeNodeInput): TypeNodeId => {
          this.graph.setNode(id, model)
          completed.set(type, id)
          return id
        }
        const alias = type.aliasSymbol
        const aliasDeclaration = alias === undefined ? undefined : preferredDeclaration(this.graph.resolveSymbol(alias))
        if (alias?.name === 'JsonValue' && aliasDeclaration !== undefined
          && this.registrationForFile(aliasDeclaration.getSourceFile().fileName)?.name === '@deepseek-ai/dsh-util-values') {
          return add({ kind: 'keyword', name: 'unknown', json: true })
        }
        const flags = type.flags
        if (this.isRemoteByteArray(type)) {
          return add({ kind: 'reference', name: 'Uint8Array', target: { kind: 'standard', name: 'Uint8Array' }, arguments: [] })
        }
        if ((flags & ts.TypeFlags.Any) !== 0) return add({ kind: 'keyword', name: 'any' })
        if ((flags & ts.TypeFlags.Unknown) !== 0) return add({ kind: 'keyword', name: 'unknown' })
        if ((flags & ts.TypeFlags.Never) !== 0) return add({ kind: 'keyword', name: 'never' })
        if ((flags & ts.TypeFlags.String) !== 0) return add({ kind: 'keyword', name: 'string' })
        if ((flags & ts.TypeFlags.Number) !== 0) return add({ kind: 'keyword', name: 'number' })
        if ((flags & ts.TypeFlags.BigInt) !== 0) return add({ kind: 'keyword', name: 'bigint' })
        if ((flags & ts.TypeFlags.Boolean) !== 0) return add({ kind: 'keyword', name: 'boolean' })
        if ((flags & ts.TypeFlags.ESSymbol) !== 0) return add({ kind: 'keyword', name: 'symbol' })
        if ((flags & ts.TypeFlags.Undefined) !== 0) return add({ kind: 'keyword', name: 'undefined' })
        if ((flags & ts.TypeFlags.Void) !== 0) return add({ kind: 'keyword', name: 'void' })
        if ((flags & ts.TypeFlags.Null) !== 0) return add({ kind: 'literal', value: null, text: 'null' })
        if ((flags & ts.TypeFlags.StringLiteral) !== 0) {
          const value = (type as ts.StringLiteralType).value
          return add({ kind: 'literal', value, text: JSON.stringify(value) })
        }
        if ((flags & ts.TypeFlags.NumberLiteral) !== 0) {
          const value = (type as ts.NumberLiteralType).value
          return add({ kind: 'literal', value, text: String(value) })
        }
        if ((flags & ts.TypeFlags.BigIntLiteral) !== 0) {
          const value = (type as ts.BigIntLiteralType).value
          const text = `${value.negative ? '-' : ''}${value.base10Value}n`
          return add({ kind: 'literal', value: BigInt(`${value.negative ? '-' : ''}${value.base10Value}`), text })
        }
        if ((flags & ts.TypeFlags.BooleanLiteral) !== 0) {
          const value = (type as ts.Type & { readonly intrinsicName?: string }).intrinsicName === 'true'
          return add({ kind: 'literal', value, text: String(value) })
        }
        if (type.isIntersection()) {
          const material = type.types.filter(member => !this.isRemotePhantomConstraint(member))
          if (material.length === 1) {
            const projected = convert(material[0] as ts.Type)
            const { id: _projectedId, ...value } = this.graph.node(projected) as TypeNodeModel
            return add(value)
          }
          // Object intersections contribute one request object; closing each operand
          // separately would reject fields declared by its sibling operands.
          if (!material.every(member => (member.flags & ts.TypeFlags.Object) !== 0
            && !this.checker.isArrayType(member) && !this.checker.isTupleType(member))) {
            return add({ kind: 'intersection', types: material.map(convert) })
          }
        } else if (type.isUnion()) {
          return add({
            kind: 'union',
            types: type.types.map(convert),
          })
        }
        if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
          this.graph.fail(authoredType, 'Remote codec contains an unresolved type parameter')
        }
        if ((flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) {
          this.graph.fail(
            authoredType,
            `Remote codec type ${this.checker.typeToString(type, authoredType, ts.TypeFormatFlags.NoTruncation)} has no concrete Zod projection`,
          )
        }
        if (this.checker.isTupleType(type)) {
          const reference = type as ts.TypeReference
          const target = reference.target as ts.TupleType
          const arguments_ = this.checker.getTypeArguments(reference)
          return add({
            kind: 'tuple',
            elements: arguments_.map((argument, index) => {
              const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required
              return {
                type: (elementFlags & ts.ElementFlags.Rest) !== 0
                  ? this.graph.addNode(authoredType, { kind: 'array', element: convert(argument) })
                  : convert(argument),
                optional: (elementFlags & ts.ElementFlags.Optional) !== 0,
                rest: (elementFlags & (ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0,
              }
            }),
          })
        }
        if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
          const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
          if (element === undefined) this.graph.fail(authoredType, 'Remote codec array has no element type')
          return add({ kind: 'array', element: convert(element) })
        }
        if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
          this.graph.fail(authoredType, 'Remote codec cannot contain callable or constructable values')
        }
        const members: MemberModel[] = []
        for (const property of this.checker.getPropertiesOfType(type)) {
          const declaration = property.valueDeclaration ?? property.declarations?.[0]
          const propertyType = this.checker.getTypeOfSymbolAtLocation(property, declaration ?? authoredType)
          const symbolKey = property.getName()
          members.push({
            ...(declaration === undefined ? EMPTY_DOCUMENTATION : documentationOf(declaration)),
            id: `${id}#${symbolKey}`,
            name: symbolKey,
            ...(symbolKey.startsWith('__@') ? { computed: 'symbol' as const } : {}),
            optional: (property.flags & ts.SymbolFlags.Optional) !== 0,
            readonly: declaration !== undefined && hasModifier(declaration, ts.SyntaxKind.ReadonlyKeyword),
            async: false,
            abstract: false,
            static: false,
            visibility: 'public',
            location: this.graph.location(authoredType),
            text: '',
            kind: 'property',
            type: convert(propertyType),
          })
        }
        for (const [index, info] of this.checker.getIndexInfosOfType(type).entries()) {
          members.push({
            ...EMPTY_DOCUMENTATION,
            id: `${id}#index:${String(index)}`,
            name: '(index)',
            optional: false,
            readonly: info.isReadonly,
            async: false,
            abstract: false,
            static: false,
            visibility: 'public',
            location: this.graph.location(authoredType),
            text: '',
            kind: 'index',
            signature: {
              typeParameters: [],
              parameters: [{
                name: 'key',
                binding: 'identifier',
                type: convert(info.keyType),
                optional: false,
                rest: false,
                receiver: false,
              }],
              returns: convert(info.type),
            },
          })
        }
        return add({ kind: 'object', members })
      } finally {
        active.delete(type)
      }
    }
    return convert(resolvedType)
  }

  private assertRemoteJsonType(
    type: ts.Type,
    site: ts.TypeNode,
    active: Set<ts.Type>,
    allowUndefined: boolean,
    allowVoid: boolean,
    allowBytes = false,
  ): void {
    const flags = type.flags
    if ((flags & ts.TypeFlags.Undefined) !== 0 && allowUndefined) return
    if ((flags & ts.TypeFlags.Void) !== 0 && allowVoid) return
    if ((flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
      this.graph.fail(site, `Remote boundary contains unconstrained ${this.checker.typeToString(type)} data`)
    }
    if ((flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) {
      this.graph.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`)
    }
    if ((flags & (ts.TypeFlags.StringLike
      | ts.TypeFlags.NumberLike
      | ts.TypeFlags.BooleanLike
      | ts.TypeFlags.Null
      | ts.TypeFlags.Never)) !== 0) return
    if (this.isRemoteByteArray(type)) {
      if (allowBytes) return
      this.graph.fail(site, 'Remote Uint8Array is only supported in unary results')
    }
    if (type.isUnion()) {
      for (const member of type.types) {
        this.assertRemoteJsonType(member, site, active, allowUndefined, allowVoid, allowBytes)
      }
      return
    }
    if (type.isIntersection()) {
      const material = type.types.filter(member => !this.isRemotePhantomConstraint(member))
      if (material.length === 0) this.graph.fail(site, 'Remote boundary contains a symbol-only object')
      for (const member of material) this.assertRemoteJsonType(member, site, active, false, false, allowBytes)
      return
    }
    if ((flags & ts.TypeFlags.TypeParameter) !== 0) {
      this.graph.fail(site, 'Remote boundary contains an unresolved type parameter')
    }
    if ((flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) === 0) {
      this.graph.fail(site, `Remote boundary contains non-JSON type ${this.checker.typeToString(type)}`)
    }
    const symbol = type.getSymbol()
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (declaration !== undefined && (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))) {
      this.graph.fail(site, `Remote boundary contains class instance ${symbol?.name ?? this.checker.typeToString(type)}`)
    }
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      this.graph.fail(site, 'Remote boundary contains callable or constructable data')
    }
    if (active.has(type)) return
    active.add(type)
    try {
      if (this.checker.isTupleType(type)) {
        const reference = type as ts.TypeReference
        const target = reference.target as ts.TupleType
        const arguments_ = this.checker.getTypeArguments(reference)
        arguments_.forEach((argument, index) => {
          const elementFlags = target.elementFlags[index] ?? ts.ElementFlags.Required
          this.assertRemoteJsonType(
            argument,
            site,
            active,
            (elementFlags & ts.ElementFlags.Optional) !== 0,
            false,
            allowBytes,
          )
        })
        return
      }
      if (this.checker.isArrayType(type) || this.checker.isArrayLikeType(type)) {
        const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number)
        if (element === undefined) this.graph.fail(site, 'Remote boundary array has no element type')
        this.assertRemoteJsonType(element, site, active, false, false, allowBytes)
        return
      }
      const properties = this.checker.getPropertiesOfType(type)
      if (properties.some(property => property.getName().startsWith('__@'))) {
        this.graph.fail(site, 'Remote boundary contains a symbol-keyed property')
      }
      for (const property of properties) {
        const propertyDeclaration = property.valueDeclaration ?? property.declarations?.[0]
        const propertyType = this.checker.getTypeOfSymbolAtLocation(property, propertyDeclaration ?? site)
        this.assertRemoteJsonType(
          propertyType,
          site,
          active,
          (property.flags & ts.SymbolFlags.Optional) !== 0,
          false,
          allowBytes,
        )
      }
      for (const info of this.checker.getIndexInfosOfType(type)) {
        if ((info.keyType.flags & ts.TypeFlags.ESSymbolLike) !== 0) {
          this.graph.fail(site, 'Remote boundary contains a symbol index signature')
        }
        this.assertRemoteJsonType(info.type, site, active, false, false, allowBytes)
      }
    } finally {
      active.delete(type)
    }
  }

  private isRemoteByteArray(type: ts.Type): boolean {
    const symbol = type.getSymbol()
    return symbol?.name === 'Uint8Array'
      && symbol.declarations?.some(declaration => isStandardLibraryFile(declaration.getSourceFile().fileName)) === true
  }

  private includesRemoteAbsence(type: ts.Type): boolean {
    if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return true
    return type.isUnion() && type.types.some(member => this.includesRemoteAbsence(member))
  }

  private isRemotePhantomConstraint(type: ts.Type): boolean {
    if ((type.flags & ts.TypeFlags.Unknown) !== 0) return true
    if ((type.flags & ts.TypeFlags.Any) !== 0 || (type.flags & ts.TypeFlags.Object) === 0) return false
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return false
    if (this.checker.getIndexInfosOfType(type).length > 0) return false
    return this.checker.getPropertiesOfType(type).every(property => property.getName().startsWith('__@'))
  }

  private resolvedCycleReference(
    type: ts.Type,
    site: ts.TypeNode,
    resolvedType: TypeNodeId,
    recursiveDeclarations: Map<ts.Type, SymbolId>,
  ): TypeNodeId {
    const symbol = type.aliasSymbol ?? type.getSymbol()
    if (symbol === undefined) this.graph.fail(site, 'Remote codec contains an unnamed recursive type')
    const resolved = this.graph.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined || isStandardLibraryFile(declaration.getSourceFile().fileName)) {
      this.graph.fail(site, `Remote codec recursive type ${resolved.name} has no workspace declaration`)
    }
    const owner = this.registrationForFile(declaration.getSourceFile().fileName)
    if (owner === undefined) this.graph.fail(site, `Remote codec recursive type ${resolved.name} is not owned by this face`)
    let id = recursiveDeclarations.get(type)
    if (id === undefined) {
      id = `${this.graph.symbolId(resolved)}#remote-codec:${resolvedType}`
      recursiveDeclarations.set(type, id)
      this.graph.setDeclaration(id, {
        ...EMPTY_DOCUMENTATION,
        id,
        package: owner.name,
        name: `${resolved.name}RemoteCodec`,
        kind: 'alias',
        abstract: false,
        exported: false,
        location: this.graph.location(declaration),
        text: '',
        typeParameters: [],
        extends: [],
        implements: [],
        members: [],
        type: resolvedType,
      })
    }
    return this.graph.addNode(site, {
      kind: 'reference',
      name: `${resolved.name}RemoteCodec`,
      target: { kind: 'declaration', symbol: id },
      arguments: [],
    })
  }

  private namedWorkspaceType(node: ts.TypeNode): ts.Symbol | undefined {
    if (!ts.isTypeReferenceNode(node) && !ts.isImportTypeNode(node)) return undefined
    const symbol = ts.isTypeReferenceNode(node)
      ? this.checker.getSymbolAtLocation(node.typeName)
      : node.qualifier === undefined ? undefined : this.checker.getSymbolAtLocation(node.qualifier)
    if (symbol === undefined) return undefined
    const resolved = this.graph.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved)
    if (declaration === undefined
      || isStandardLibraryFile(declaration.getSourceFile().fileName)
      || this.registrationForFile(declaration.getSourceFile().fileName) === undefined) return undefined
    return resolved
  }

  private publicRemoteType(symbol: ts.Symbol, site: ts.Node): RemoteTypeImportModel {
    const declaration = preferredDeclaration(symbol)
    if (declaration === undefined) this.graph.fail(site, `type ${symbol.name} has no declaration`)
    const registration = this.registrationForFile(declaration.getSourceFile().fileName)
    if (registration === undefined) this.graph.fail(site, `type ${symbol.name} is not owned by a workspace package`)
    const candidates: RemoteTypeImportModel[] = []
    for (const [subpath, target] of packageExportTargets(registration.manifest)) {
      if ((subpath === '.' && !PUBLIC_REMOTE_TYPE_ROOTS.has(registration.name))
        || subpath === './package.json' || subpath === './typert'
        || subpath === './client/typert' || subpath === './remote' || target.includes('*')) continue
      const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target)))
      if (sourceFile === undefined) continue
      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)
      if (moduleSymbol === undefined) continue
      for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
        if (this.graph.resolveSymbol(exported) !== symbol) continue
        candidates.push({
          symbol: this.graph.symbolId(symbol),
          specifier: packageExportSpecifier(registration.name, subpath),
          name: exported.name,
        })
      }
    }
    const selected = candidates.sort((left, right) =>
      left.specifier.localeCompare(right.specifier) || left.name.localeCompare(right.name))[0]
    if (selected === undefined) {
      this.graph.fail(site, `Remote boundary type ${symbol.name} must be exported from a public non-root type subpath`)
    }
    return selected
  }

  private isWorkspaceClass(symbol: ts.Symbol): boolean {
    const declaration = preferredDeclaration(symbol)
    return declaration !== undefined
      && ts.isClassDeclaration(declaration)
      && this.registrationForFile(declaration.getSourceFile().fileName) !== undefined
  }
}

/**
 * Reject two invocations that would share an RPC endpoint or an invocation id across the packages
 * of one face, which the generated client could not address apart.
 * @param face - Face whose packages are checked, named in the reported conflict.
 * @param packages - Analyzed packages of that face.
 */
export function validateInvocationIdentity(face: TypertFace, packages: readonly PackageModel[]): void {
  const endpoints = new Map<string, InvocationModel>()
  const ids = new Map<string, InvocationModel>()
  for (const invocation of packages.flatMap(packageModel => packageModel.invocations)) {
    const endpoint = `${invocation.namespace}/${invocation.method}`
    const existingEndpoint = endpoints.get(endpoint)
    if (existingEndpoint !== undefined) {
      throw new TypertAnalysisError(
        `typert(${face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote endpoint ${endpoint} conflicts with ${existingEndpoint.id}`,
      )
    }
    const existingId = ids.get(invocation.id)
    if (existingId !== undefined) {
      throw new TypertAnalysisError(
        `typert(${face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote invocation id ${invocation.id} conflicts with ${existingId.id}`,
      )
    }
    endpoints.set(endpoint, invocation)
    ids.set(invocation.id, invocation)
  }
}
