/**
 * Loopback status route: `GET /openviking/status` returns health and queue
 * state as JSON for the web surface (and curl). Registered only when a web
 * server is mounted; headless profiles never see it.
 * @module @deepseek-ai/dsh-openviking/status-route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { OpenVikingClient } from './client.ts'

/** Status payload the route serves. */
interface OpenVikingStatus {
  readonly endpoint: string
  readonly healthy: boolean
  readonly version?: string | undefined
  readonly queueHealthy: boolean
  readonly queueErrors: boolean
}

/** Fresh status from the service; failures degrade to healthy: false.
 * @param client - OpenViking HTTP client.
 * @returns the resolved status payload.
 */
export async function readStatus(client: OpenVikingClient): Promise<OpenVikingStatus> {
  try {
    const health = await client.health()
    const queue = await client.queue()
    return {
      endpoint: client.endpoint,
      healthy: health.status === 'ok',
      version: health.version,
      queueHealthy: queue.is_healthy,
      queueErrors: queue.has_errors,
    }
  } catch {
    return { endpoint: client.endpoint, healthy: false, queueHealthy: false, queueErrors: true }
  }
}

/**
 * Register the status route when a web server is mounted.
 * @param ctx - plugin context.
 * @param client - OpenViking client.
 */
export function registerStatusRoute(ctx: Context, client: OpenVikingClient): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/openviking/status',
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405)
          res.end()
          return
        }
        void readStatus(client).then((status) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(`${JSON.stringify(status)}\n`)
        })
      },
    }), 'openviking: status route')
  })
}
