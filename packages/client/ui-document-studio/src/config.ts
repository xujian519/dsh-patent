/** Browser preview limits shared by the Host configuration and the studio. */
import z from '@deepseek-ai/schemastery'

/** Deployment limits applied to the studio's inline preview. */
export interface Config {
  /**
   * Largest HTML file the studio renders inline, in bytes. A larger file is
   * handed to the sidebar or the OS application instead of building a frame
   * the browser would stall on.
   */
  htmlPreviewMaxBytes: number
}

/** Studio preview settings, defaulting to an 8 MiB inline HTML cap. */
export const Config: z<{ htmlPreviewMaxBytes?: number }, Config> = z.object({
  htmlPreviewMaxBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(8 * 1024 * 1024),
})
