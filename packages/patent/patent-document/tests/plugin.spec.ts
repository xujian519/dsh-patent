import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Pkg from '@deepseek-ai/dsh-patent-document'
import { fakeSubprocess, successHandle } from './helpers.ts'

describe('@deepseek-ai/dsh-patent-document plugin surface', () => {
  it('exports the function-plugin surface', () => {
    expect(Pkg.name).toBe('patent-document')
    expect(Pkg.inject).toEqual(['tools', 'subprocess'])
    expect(typeof Pkg.apply).toBe('function')
    expect(typeof Pkg.Config).toBe('function')
  })

  it('exports the document engine and tool factory', () => {
    expect(typeof Pkg.renderPatentDocument).toBe('function')
    expect(typeof Pkg.renderPdf).toBe('function')
    expect(typeof Pkg.findChrome).toBe('function')
    expect(typeof Pkg.buildBrandStyle).toBe('function')
    expect(typeof Pkg.mergeBrand).toBe('function')
    expect(typeof Pkg.loadBrandFromPath).toBe('function')
    expect(typeof Pkg.DocumentRenderError).toBe('function')
    expect(typeof Pkg.createRenderPatentDocumentTool).toBe('function')
    expect(typeof Pkg.renderDocumentResult).toBe('function')
    expect(Pkg.DEFAULT_OUTPUT_DIR).toBe('.dsh/documents')
  })

  it('registers render_patent_document through the plugin and unregisters it on dispose (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('subprocess', fakeSubprocess(() => successHandle()).runtime)
    const fiber = await ctx.plugin(Pkg, {})
    expect(ctx.tools.schemas().some(s => s.name === 'render_patent_document')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'render_patent_document')).toBe(false)
  })

  it('applies an explicit chromePath while outputRoot stays unset', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('subprocess', fakeSubprocess(() => successHandle()).runtime)
    Pkg.apply(ctx, Pkg.Config({ chromePath: '/usr/bin/chrome' }))
    expect(ctx.tools.schemas().some(s => s.name === 'render_patent_document')).toBe(true)
  })
})
