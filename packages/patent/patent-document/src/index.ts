/**
 * Function plugin porting the Sati patent document renderer into the DeepSeek
 * Harness: template resolution, brand injection, headless-Chrome PDF rendering
 * through ctx.subprocess, the render_patent_document tool, and the
 * verify_deliverable consistency check.
 * @module @deepseek-ai/dsh-patent-document
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_PDF_TIMEOUT_MS } from './document/pdfRenderer.ts'
import { createRenderPatentDocumentTool } from './tool/render-patent-document.ts'
import { createVerifyDeliverableTool } from './tool/verify-deliverable.ts'

// Public library API: the ported document engine and the tool factories.
export * from './document/index.ts'
export { createRenderPatentDocumentTool, renderDocumentResult, TEMPLATE_IDS } from './tool/render-patent-document.ts'
export type { RenderPatentDocumentToolOptions } from './tool/render-patent-document.ts'
export { createVerifyDeliverableTool, renderDeliverableResult, verifyDeliverable } from './tool/verify-deliverable.ts'
export type { DeliverableArtifactInput, VerifyDeliverableInput, VerifyDeliverableOutput } from './tool/verify-deliverable.ts'

/** Cordis plugin name. */
export const name = 'patent-document'

/** Services the plugin requires before registration. */
export const inject = ['tools', 'subprocess']

/** Model-facing patent-document plugin configuration. */
export interface Config {
  /** Absolute Chrome executable used for PDF; overrides DSH_CHROME_PATH/CHROME_PATH discovery. */
  chromePath?: string
  /**
   * Explicit output directory used only when the matter directory cannot be resolved,
   * the call omits outputDir, and the call does not name a case id.
   */
  outputRoot?: string
  /** Work root (`workbenchCaseRoot`). One matter is `<root>/<case id>/`. */
  workbenchCaseRoot?: string
  /** Headless-Chrome print timeout in milliseconds; defaults to the renderer's exported default (120000). */
  pdfTimeoutMs: number
}

/** Schemastery configuration: optional Chrome override, default output directory, and print timeout. */
export const Config: z<Partial<Config>, Config> = z.object({
  chromePath: z.string(),
  outputRoot: z.string(),
  workbenchCaseRoot: z.string(),
  pdfTimeoutMs: z.number().step(1).min(1).default(DEFAULT_PDF_TIMEOUT_MS),
})

/**
 * Register the render_patent_document and verify_deliverable tools.
 * @param ctx - registrant context carrying the tool registry and subprocess service.
 *   An Agent call to verify_deliverable reads `workingDirectory` from this context at execution time.
 * @param config - deployment's Chrome path override, default output directory, and print timeout.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(createRenderPatentDocumentTool({
    subprocess: ctx.subprocess,
    ...(config.chromePath !== undefined ? { chromePath: config.chromePath } : {}),
    ...(config.workbenchCaseRoot === undefined ? {} : { workRoot: config.workbenchCaseRoot }),
    ...(config.outputRoot === undefined ? {} : { outputRoot: config.outputRoot }),
    pdfTimeoutMs: config.pdfTimeoutMs,
  }))
  ctx.tools.register(createVerifyDeliverableTool(ctx))
}
