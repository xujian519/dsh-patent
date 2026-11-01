/**
 * Construction of the pi-ai `Provider` that one configured route registers into
 * the adapter's `Models` collection.
 *
 * Two constructions, one decision: a route the installed catalog ships, whose
 * profile does not override the wire protocol, **reuses that catalog provider**
 * with its models replaced — the catalog provider owns API implementations this
 * package cannot reconstruct (Bedrock loads its Smithy module through a
 * separate entry point), so rebuilding it from parts would silently narrow
 * which providers work. Every other route — one pi-ai has never heard of, or a
 * catalog route pointed at a different protocol — is built by `createProvider`
 * over the protocol table below, with the catalog provider's request-contract
 * wrappers re-applied to those replacement streams.
 *
 * Credentials never reach this module's storage: the harness resolves a route's
 * key through `ctx.credentials` before the request enters pi-ai and hands it
 * over as a stream option, which `Models` presents to `resolve()` as the
 * credential key.
 *
 * @module dsh-llm-pi-ai/provider
 */

import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { cloudflareStreams } from '@earendil-works/pi-ai/providers/cloudflare-stream'
import { withOpenCodeSessionHeader } from '@earendil-works/pi-ai/providers/opencode-headers'
import { catalogProvider, PiAiCatalogError } from './catalog.ts'
import { createProvider } from './models.ts'

/**
 * Wire protocols a configured route may name, mapped to pi-ai's lazily loaded
 * implementations. Each entry is the factory that pi-ai's matching provider
 * factory uses, so a hand-declared route reaches exactly the implementation a
 * catalog route would.
 *
 * The table is deliberately narrow: the protocols a hand-declared route
 * actually reads, each completely describable with a key, an
 * endpoint, and headers. Bedrock signs with SigV4 over AWS credentials and a
 * region, Vertex needs a project, a location, and application-default
 * credentials, Azure needs provider environment plus an api-version, and Codex
 * authenticates through OAuth — none of which this configuration shape can
 * express, so offering them would hand back a provider that cannot
 * authenticate. The remainder are absent for want of a consumer rather than a
 * blocker: each is one line here once a deployment needs it. Catalog routes
 * still reach every protocol through their own provider; only an explicit
 * override is refused.
 */
const PROTOCOLS: Readonly<Record<string, () => ProviderStreams>> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
}

/**
 * Every wire protocol a configured route may name, most-reached first. The
 * order is the table's and therefore stable; a configuration surface offering
 * a choice presents the first as its default, which is why the protocol a
 * hand-declared gateway most often speaks — and the one endpoint interrogation
 * can read — leads.
 * @returns the supported protocol identifiers.
 */
export function supportedProtocols(): readonly string[] {
  return Object.keys(PROTOCOLS)
}

/**
 * Request-contract wrappers by catalog provider id. A catalog provider owns
 * more than its api implementations: the OpenCode gateways refuse any request
 * without a per-conversation `x-opencode-session`, so pi-ai wraps each of that
 * provider's implementations to derive the header from the request's
 * `sessionId`; the Cloudflare providers resolve the account and gateway
 * placeholders in a model's endpoint from the request's ambient values, which
 * only that provider's own auth resolution supplies. Replacing those
 * implementations with the protocol table's, which an explicit route `api`
 * does, drops the obligation — the gateway refuses the request before the
 * model runs, or the endpoint keeps its literal placeholders. Each wrapper is
 * re-applied to the replacement so the catalog provider's obligation survives
 * the override.
 *
 * Keyed by catalog provider id, never by endpoint host: a route naming a
 * catalog provider inherits that provider's obligations, and a route pi-ai
 * does not ship — a private gateway the deployment describes itself — has no
 * catalog contract to inherit. The wrappers come from pi-ai rather than being
 * restated here, so the header name, the placeholder names, and their
 * per-request derivations stay upstream-owned.
 */
const CATALOG_STREAM_WRAPPERS: Readonly<Record<string, (streams: ProviderStreams) => ProviderStreams>> = {
  'cloudflare-ai-gateway': cloudflareStreams,
  'cloudflare-workers-ai': cloudflareStreams,
  opencode: withOpenCodeSessionHeader,
  'opencode-go': withOpenCodeSessionHeader,
}

/**
 * Api-key auth for a route the harness authenticates itself. `Models` calls
 * this after the adapter has already resolved the route's credential, so a
 * missing key here is not this layer's failure: a named-but-unresolvable
 * reference has already failed the request with `MISSING_CREDENTIAL`, and a
 * route naming no credential at all is deliberately unauthenticated. Reporting
 * it as configured hands the decision to the protocol, which is where the
 * requirement actually lives — pi-ai's OpenAI-compatible implementation, for
 * one, still insists on a key or an `Authorization` header of its own.
 * @param name - display name used as the resolution's status label.
 * @returns the api-key auth for a harness-authenticated route.
 */
function harnessApiKeyAuth(name: string): ApiKeyAuth {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential?.key === undefined ? {} : { apiKey: credential.key },
      source: name,
    }),
  }
}

/** The resolved route facts provider construction reads. */
interface ProviderSpec {
  /** Provider route key; also the `Models` collection key and each model's `provider`. */
  provider: string
  /** Display name for selectors and status labels. */
  displayName: string
  /** Wire protocol override; absent means each model keeps its catalog protocol. */
  api?: string
  /** Endpoint override already applied to {@link models}; kept for provider-level display. */
  baseURL?: string
  /** The route's materialized models, in configuration order. */
  models: readonly Model<Api>[]
  /**
   * Whether the profile names a credential, which it does through `apiKeyEnv`
   * alone: configuration carries the reference, never the secret. Only that
   * decides whether {@link routeAuth} adds the harness's own api-key method to
   * a catalog provider that offers none; the key itself still arrives per
   * request, never at construction.
   */
  namesCredential: boolean
}

/**
 * The auth one route resolves its credential through.
 *
 * A catalog route keeps the installed provider's own auth, which is what
 * preserves provider-native ambient discovery for a profile naming no
 * credential. That holds even when the profile repoints the protocol: which
 * environment a provider reads is a property of the provider, not of the wire
 * format its models speak.
 *
 * The single addition covers a catalog provider that offers no api-key method
 * at all. pi-ai resolves a request's `apiKey` override only when the provider
 * declares one (`resolveProviderAuth` checks `provider.auth.apiKey` before
 * honouring the override), so an OAuth-only provider — `openai-codex` is the
 * one the installed catalog ships — would refuse a profile's explicit key with
 * `Provider is not configured` before any request went out. Adding the harness
 * method beside the provider's own restores that route. A keyless profile adds
 * nothing and still reports the honest refusal, because this adapter resolves
 * credentials through its own seam and holds no OAuth store to fall back on.
 * @param spec - the resolved route facts.
 * @param catalog - the installed catalog provider, when pi-ai ships one.
 * @returns the auth to construct this route's provider with.
 */
function routeAuth(spec: ProviderSpec, catalog: Provider | undefined): Provider['auth'] {
  if (catalog === undefined) return { apiKey: harnessApiKeyAuth(spec.displayName) }
  if (catalog.auth.apiKey !== undefined || !spec.namesCredential) return catalog.auth
  return { ...catalog.auth, apiKey: harnessApiKeyAuth(spec.displayName) }
}

/**
 * Reuse an installed catalog provider with this route's models and identity.
 * Model dispatch stays with the catalog provider, so its API implementations,
 * compatibility quirks, and ambient credential discovery are preserved exactly.
 * Catalog-owned dynamic refresh is dropped: this route's catalog is the
 * settings document, and a background refresh would contradict it.
 */
function reuseCatalogProvider(base: Provider, spec: ProviderSpec): Provider {
  // Provider-level `baseUrl` is display metadata: pi-ai routes every request
  // through `Model.baseUrl`, which model resolution has already overridden.
  const baseUrl = spec.baseURL ?? base.baseUrl
  return {
    id: spec.provider,
    name: spec.displayName,
    ...baseUrl === undefined ? {} : { baseUrl },
    auth: routeAuth(spec, base),
    getModels: () => spec.models,
    // Delegated rather than copied: the catalog provider stays the receiver, so
    // an implementation holding state on itself keeps working.
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
}

/**
 * Build the pi-ai provider for one resolved route.
 * @param spec - the resolved route facts.
 * @returns the provider to register in the adapter's `Models` collection.
 * @throws Error when the route names a wire protocol this build cannot serve.
 */
export function buildProvider(spec: ProviderSpec): Provider {
  const catalog = catalogProvider(spec.provider)
  // A catalog route keeping its catalog protocol reuses the catalog provider;
  // an explicit protocol means the deployment is repointing the route at a
  // different wire format, which only the protocol table can serve.
  if (catalog !== undefined && spec.api === undefined) return reuseCatalogProvider(catalog, spec)

  // Every model on this path carries the route's protocol: model resolution
  // requires one for a route the catalog cannot default, and an explicit one
  // replaces each catalog model's own. So the route has a single API.
  const factory = spec.api === undefined ? undefined : PROTOCOLS[spec.api]
  if (factory === undefined) {
    throw new PiAiCatalogError(
      `llm-pi-ai: provider "${spec.provider}" names api "${spec.api}", which this build cannot serve;`
      + ` supported protocols are ${supportedProtocols().join(', ')}`,
    )
  }
  // A route the catalog ships but this profile repoints keeps that provider's
  // request contract; a route the catalog does not ship has none to keep.
  const wrapper = catalog === undefined ? undefined : CATALOG_STREAM_WRAPPERS[spec.provider]
  const streams = factory()
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...spec.baseURL === undefined ? {} : { baseUrl: spec.baseURL },
    auth: routeAuth(spec, catalog),
    models: spec.models,
    api: wrapper === undefined ? streams : wrapper(streams),
  })
}
