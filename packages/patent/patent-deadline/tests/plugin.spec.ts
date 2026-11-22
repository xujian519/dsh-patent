import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Pkg from '../src/index.ts'

async function install(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(Pkg, config)
  return { ctx, fiber }
}

describe('@deepseek-ai/dsh-patent-deadline plugin surface', () => {
  it('exports the function-plugin surface', () => {
    expect(Pkg.name).toBe('patent-deadline')
    expect(typeof Pkg.apply).toBe('function')
    expect(typeof Pkg.Config).toBe('function')
  })

  it('exports the library API', () => {
    expect(typeof Pkg.periodEnd).toBe('function')
    expect(typeof Pkg.parseCalendarDate).toBe('function')
    expect(typeof Pkg.addCalendarMonths).toBe('function')
    expect(typeof Pkg.resolveDeliveryDate).toBe('function')
    expect(typeof Pkg.resolveDeliveryMode).toBe('function')
    expect(typeof Pkg.DeadlineQueryError).toBe('function')
    expect(typeof Pkg.loadWorkCalendar).toBe('function')
    expect(typeof Pkg.evaluateDeadlines).toBe('function')
    expect(typeof Pkg.renderDeadlineReport).toBe('function')
    expect(typeof Pkg.createPatentDeadlinesTool).toBe('function')
    expect(typeof Pkg.createPatentDeadlineService).toBe('function')
    expect(typeof Pkg.describePatentKind).toBe('function')
    expect(Pkg.CALENDAR_FILE_NAME).toBe('cn-holidays.yaml')
  })

  it('registers patent_deadlines and unregisters it on dispose (HMR-safety)', async () => {
    const { ctx, fiber } = await install()
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_deadlines')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_deadlines')).toBe(false)
  })

  it('stays tool-only by default: no patentDeadline service is published', async () => {
    const { ctx } = await install()
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_deadlines')).toBe(true)
    expect(ctx.get('patentDeadline')).toBeUndefined()
  })

  it('publishes the patentDeadline service without a tool when mounted service-only', async () => {
    const { ctx, fiber } = await install({ provideService: true, exposeTool: false })
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_deadlines')).toBe(false)
    const service = ctx.get('patentDeadline')
    expect(service).toBeDefined()
    expect(service?.calendarCoverage().years.length).toBeGreaterThan(0)
    await fiber.dispose()
    expect(ctx.get('patentDeadline')).toBeUndefined()
  })

  it('mounts service-only without the tools service', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    const fiber = await ctx.plugin(Pkg, { provideService: true, exposeTool: false })
    expect(ctx.get('patentDeadline')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('patentDeadline')).toBeUndefined()
  })

  it('publishes the service and the tool when both roles are requested', async () => {
    const { ctx } = await install({ provideService: true })
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_deadlines')).toBe(true)
    expect(ctx.get('patentDeadline')).toBeDefined()
  })

  it('defaults an empty config when apply is called directly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await Pkg.apply(ctx, {})
    expect(ctx.tools.schemas().some(schema => schema.name === 'patent_deadlines')).toBe(true)
  })

  it('rejects a mount that neither publishes the service nor registers the tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { provideService: false, exposeTool: false })).rejects.toThrow(/不能同时为 false/)
  })

  it('rejects a negative reminder horizon at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { reminderLeadDays: -1 })).rejects.toThrow()
  })

  it('fails loud at load when the configured time zone is unusable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { timeZone: 'Not/AZone' })).rejects.toThrow()
  })

  it('fails loud at load when the configured calendar directory has no asset', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(Pkg, { calendarDir: '/nonexistent/calendar-dir' })).rejects.toThrow(/无法读取工作日历资产/)
  })
})
