import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as Pkg from '@deepseek-ai/dsh-patent-filing'
import { DEFAULT_ENGINE_TIMEOUT_MS, DEFAULT_OUTPUT_DIR } from '@deepseek-ai/dsh-patent-filing'
import { fakeSubprocess, stdoutHandle } from './helpers.ts'

/** Build report the packaged engine prints for a successful build. */
const BUILD_REPORT = JSON.stringify({
  status: 'ok',
  out: '/out/a.docx',
  sections: [{ key: 'abstract', paragraphs: 1, figures: 0 }],
  numbering_total: 3,
  upstream_numbering_seen: 0,
  template_style: {
    section_count: 5,
    eastAsia: '宋体',
    ascii: 'Times New Roman',
    cs: 'Times New Roman',
    size_pt: 12,
    line_spacing: 1.5,
    first_line_indent: 0,
    sizes_pt: [12],
    line_spacings: [1.5],
  },
})

/** Verify report the packaged engine prints for a passing document. */
const VERIFY_REPORT = JSON.stringify({
  passed: true,
  errors: [],
  info: {
    sections: 5,
    headers: ['说明书摘要'],
    paragraphs: 10,
    claims: 2,
    numbering: '1..3',
    tables: 0,
    figures: 1,
    layout: { abstract: { paragraphs: 1, figures: 0 } },
    template: { sections: 5, sizes_pt: [12], line_spacings: [1.5] },
  },
})

/** A python interpreter path that exists on the test host. */
function pythonStub(): { dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-plugin-'))
  const path = join(dir, 'python3')
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  return { dir, path, cleanup: () => { rmSync(dir, { recursive: true, force: true }) } }
}

describe('@deepseek-ai/dsh-patent-filing plugin surface', () => {
  it('exports the function-plugin surface', () => {
    expect(Pkg.name).toBe('patent-filing')
    expect(Pkg.inject).toEqual(['tools', 'subprocess'])
    expect(typeof Pkg.apply).toBe('function')
    expect(typeof Pkg.Config).toBe('function')
  })

  it('exports the engine runner, tool factories, and asset resolvers', () => {
    expect(typeof Pkg.buildFiling).toBe('function')
    expect(typeof Pkg.verifyFiling).toBe('function')
    expect(typeof Pkg.validateContent).toBe('function')
    expect(typeof Pkg.findPython).toBe('function')
    expect(typeof Pkg.requirePython).toBe('function')
    expect(typeof Pkg.getAssetRoot).toBe('function')
    expect(typeof Pkg.getEngineDir).toBe('function')
    expect(typeof Pkg.defaultSpecPath).toBe('function')
    expect(typeof Pkg.defaultTemplatePath).toBe('function')
    expect(typeof Pkg.createBuildPatentFilingTool).toBe('function')
    expect(typeof Pkg.createVerifyPatentFilingTool).toBe('function')
    expect(typeof Pkg.renderBuildResult).toBe('function')
    expect(typeof Pkg.renderVerifyResult).toBe('function')
    expect(Pkg.DEFAULT_OUTPUT_DIR).toBe('.dsh/documents')
  })

  it('registers both tools through the plugin and unregisters them on dispose (HMR-safety)', async () => {
    const python = pythonStub()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.provide('subprocess', fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner)
      const fiber = await ctx.plugin(Pkg, { pythonPath: python.path })
      const names = ctx.tools.schemas().map(schema => schema.name)
      expect(names).toContain('build_patent_filing')
      expect(names).toContain('verify_patent_filing')
      await fiber.dispose()
      const after = ctx.tools.schemas().map(schema => schema.name)
      expect(after).not.toContain('build_patent_filing')
      expect(after).not.toContain('verify_patent_filing')
    } finally {
      python.cleanup()
    }
  })

  it('applies without optional config fields, taking the packaged defaults', async () => {
    const python = pythonStub()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.provide('subprocess', fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner)
      // 只给可选字段：outputRoot/figureScale/timeoutMs 由 Config 填充后再交给 apply。
      Pkg.apply(ctx, Pkg.Config({ pythonPath: python.path, chromePath: '/usr/bin/chrome' }))
      expect(ctx.tools.schemas().some(schema => schema.name === 'build_patent_filing')).toBe(true)
    } finally {
      python.cleanup()
    }
  })

  it('reports a missing interpreter at call time instead of blocking the mount', async () => {
    // 探测顺序的最后一跳是随包运行时；把 HOME 指向空目录、PATH 清空，才能确定地走到"找不到"分支。
    const saved = {
      home: process.env.HOME,
      dshHome: process.env.DSH_HOME,
      path: process.env.PATH,
      pythonPath: process.env.DSH_PYTHON_PATH,
      runtime: process.env.DSH_PRIMARY_RUNTIME,
    }
    const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-filing-home-'))
    try {
      process.env.HOME = emptyHome
      process.env.DSH_HOME = ''
      Reflect.deleteProperty(process.env, 'DSH_PYTHON_PATH')
      Reflect.deleteProperty(process.env, 'DSH_PRIMARY_RUNTIME')
      process.env.PATH = ''
      expect(Pkg.findPython()).toBeUndefined()
      expect(() => Pkg.requirePython()).toThrow(/自带 python-docx 的解释器/)

      // 缺解释器是主机能力问题，不是部署配置错误：整份组合仍要挂得上，缺解释器只挡调用。
      const registered: string[] = []
      Pkg.apply({ tools: { register: (tool: { name: string }) => { registered.push(tool.name) } } } as never, Pkg.Config({}))
      expect(registered).toEqual(['build_patent_filing', 'verify_patent_filing'])
    } finally {
      if (saved.home !== undefined) process.env.HOME = saved.home
      if (saved.dshHome !== undefined) process.env.DSH_HOME = saved.dshHome
      else Reflect.deleteProperty(process.env, 'DSH_HOME')
      if (saved.path !== undefined) process.env.PATH = saved.path
      if (saved.pythonPath !== undefined) process.env.DSH_PYTHON_PATH = saved.pythonPath
      if (saved.runtime !== undefined) process.env.DSH_PRIMARY_RUNTIME = saved.runtime
      rmSync(emptyHome, { recursive: true, force: true })
    }
  })

  it('rejects a configured interpreter path that does not exist', () => {
    expect(() => Pkg.findPython('/nonexistent/python3')).toThrow(/不存在/)
  })
})

describe('Config', () => {
  it('defaults outputRoot, figureScale, and timeoutMs', () => {
    const config = Pkg.Config({})
    expect(config.outputRoot).toBe(DEFAULT_OUTPUT_DIR)
    expect(config.figureScale).toBe(3)
    expect(config.timeoutMs).toBe(DEFAULT_ENGINE_TIMEOUT_MS)
    expect(config.pythonPath).toBeUndefined()
    expect(config.templatePath).toBeUndefined()
  })

  it('accepts explicit deployment values', () => {
    const config = Pkg.Config({
      pythonPath: '/usr/bin/python3',
      chromePath: '/usr/bin/chrome',
      templatePath: '/tpl.docx',
      specPath: '/spec.json',
      outputRoot: 'out/docs',
      figureScale: 4,
      timeoutMs: 300_000,
    })
    expect(config.pythonPath).toBe('/usr/bin/python3')
    expect(config.specPath).toBe('/spec.json')
    expect(config.figureScale).toBe(4)
    expect(config.timeoutMs).toBe(300_000)
  })

  it('rejects a non-positive figureScale and timeoutMs', () => {
    expect(() => Pkg.Config({ figureScale: 0 })).toThrow()
    expect(() => Pkg.Config({ timeoutMs: 0 })).toThrow()
  })
})

describe('verify report is a domain result, not an infrastructure failure', () => {
  it('applies with a verify-only composition', async () => {
    const python = pythonStub()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.provide('subprocess', fakeSubprocess(() => stdoutHandle(VERIFY_REPORT)).spawner)
      Pkg.apply(ctx, Pkg.Config({ pythonPath: python.path }))
      expect(ctx.tools.schemas().some(schema => schema.name === 'verify_patent_filing')).toBe(true)
    } finally {
      python.cleanup()
    }
  })
})
