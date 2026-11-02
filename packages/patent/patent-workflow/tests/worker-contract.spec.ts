import { describe, expect, it } from 'vitest'
import {
  WorkerRegistry,
  WorkerRegistryError,
  defaultPatentWorkers,
  validateWorkerOutput,
  type WorkerContract,
  type WorkerOutputContract,
} from '@deepseek-ai/dsh-patent-workflow'

/** 构造最小合法 worker 契约（减少样板）。 */
function worker(name: string, overrides: Partial<WorkerContract> = {}): WorkerContract {
  return {
    name,
    tier: 'work',
    description: `描述 ${name}`,
    ...overrides,
  }
}

function output(overrides: Partial<WorkerOutputContract> = {}): WorkerOutputContract {
  return { path: '/out.md', format: 'markdown', contractLevel: 'hard', requiredFields: ['字段A'], ...overrides }
}

describe('WorkerRegistry', () => {
  it('register/get: a pre-registered worker is active and retrievable by name', () => {
    const registry = new WorkerRegistry()
    const def = worker('w1', { tier: 'checker' })
    registry.register(def)
    expect(registry.get('w1')).toBe(def)
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.isActive('w1')).toBe(true)
    expect(registry.isActive('nope')).toBe(false)
  })

  it('register: duplicate names throw; blank name or description throw', () => {
    const registry = new WorkerRegistry()
    registry.register(worker('w1'))
    expect(() => { registry.register(worker('w1')) }).toThrow(WorkerRegistryError)
    expect(() => { registry.register(worker('w1')) }).toThrow(/already registered/)
    expect(() => { registry.register({ ...worker('w2'), name: '  ' }) }).toThrow(WorkerRegistryError)
    expect(() => { registry.register({ ...worker('w3'), description: '' }) }).toThrow(WorkerRegistryError)
  })

  it('register with preRegister: false stays lazy until activate()', () => {
    const registry = new WorkerRegistry()
    const lazy = worker('lazy1', { preRegister: false })
    registry.register(lazy)
    expect(registry.isActive('lazy1')).toBe(false)
    expect(registry.activate('lazy1')).toBe(lazy)
    expect(registry.isActive('lazy1')).toBe(true)
    // 未注册的 worker activate 返回 undefined 且不激活。
    expect(registry.activate('ghost')).toBeUndefined()
    expect(registry.isActive('ghost')).toBe(false)
  })

  it('list/listByTier: filters by tier and lists every registered worker', () => {
    const registry = new WorkerRegistry()
    registry.register(worker('work-a'))
    registry.register(worker('check-a', { tier: 'checker' }))
    registry.register(worker('check-b', { tier: 'checker' }))
    expect(registry.list()).toHaveLength(3)
    expect(registry.listByTier('checker').map(w => w.name)).toEqual(['check-a', 'check-b'])
    expect(registry.listByTier('domain')).toEqual([])
  })

  it('verify: reports missing outputs and hard outputs without requiredFields', () => {
    const registry = new WorkerRegistry()
    registry.register(worker('no-outputs'))
    registry.register(worker('hard-without-fields', { outputs: [{ path: '/x.md', contractLevel: 'hard' }] }))
    registry.register(worker('ok', { outputs: [output()] }))
    const issues = registry.verify()
    expect(issues).toHaveLength(2)
    expect(issues[0]).toMatch(/no-outputs.*未声明 outputs 契约/)
    expect(issues[1]).toMatch(/hard 输出契约缺少 requiredFields/)
  })

  it('verify: a soft output without requiredFields is fine', () => {
    const registry = new WorkerRegistry()
    registry.register(worker('soft-ok', { outputs: [{ path: '/x.md', contractLevel: 'soft' }] }))
    expect(registry.verify()).toEqual([])
  })
})

describe('validateWorkerOutput', () => {
  it('hard (default) required fields missing mark the output degraded with reasons', () => {
    const def = worker('w1', { outputs: [output({ requiredFields: ['技术问题', '技术特征'] })] })
    const result = validateWorkerOutput(def, '只有技术问题。', '/case/out.md')
    expect(result.valid).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.missingHardFields).toEqual(['技术特征'])
    expect(result.degradationReason).toContain('技术特征')
    expect(result.degradationReason).toContain('/case/out.md')
    expect(result.missingSoftFields).toEqual([])
  })

  it('all hard fields present validate cleanly without a degradation reason', () => {
    const def = worker('w1', { outputs: [output({ requiredFields: ['技术问题', '技术特征'] })] })
    const result = validateWorkerOutput(def, '技术问题：A；技术特征：B。')
    expect(result.valid).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.missingHardFields).toEqual([])
    expect(result.degradationReason).toBeUndefined()
  })

  it('soft fields are collected as missing but never degrade the output', () => {
    const def = worker('w1', {
      outputs: [
        { path: '/x.md', contractLevel: 'soft', requiredFields: ['可选A', '可选B'] },
        output({ requiredFields: ['硬A'] }),
      ],
    })
    const result = validateWorkerOutput(def, '硬A 存在')
    expect(result.valid).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.missingSoftFields).toEqual(['可选A', '可选B'])
    expect(result.missingHardFields).toEqual([])
  })

  it('structured contract level is treated as hard', () => {
    const def = worker('w1', { outputs: [{ path: '/x.md', contractLevel: 'structured', requiredFields: ['结论'] }] })
    const missing = validateWorkerOutput(def, '完全没有相关内容')
    expect(missing.valid).toBe(false)
    expect(missing.degraded).toBe(true)
    expect(missing.missingHardFields).toEqual(['结论'])
    const present = validateWorkerOutput(def, '结论：具备新颖性')
    expect(present.valid).toBe(true)
    expect(present.degraded).toBe(false)
  })

  it('a worker without outputs validates trivially', () => {
    const result = validateWorkerOutput(worker('bare'), '任何输出')
    expect(result.valid).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.missingHardFields).toEqual([])
  })

  it('an output without requiredFields contributes no hard field checks', () => {
    const def = worker('w1', { outputs: [{ path: '/x.md', contractLevel: 'hard' }] })
    const result = validateWorkerOutput(def, '任意内容')
    expect(result.valid).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.missingHardFields).toEqual([])
    expect(result.missingSoftFields).toEqual([])
  })
})

describe('patent-search-commander 检索完备性门禁', () => {
  const commander = defaultPatentWorkers().find(w => w.name === 'patent-search-commander')!

  it('一份只有来源与日期的检索报告被判定缺锚点声明', () => {
    const report = [
      '## 检索式',
      'C3 = 脱液 AND 压盘',
      '## 对比文件',
      '| 文献号 | 公开日 |',
      '| CN216629177U | 2022-04-29 |',
    ].join('\n')
    const result = validateWorkerOutput(commander, report)
    expect(result.valid).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.missingHardFields).toEqual(['命名族清单', '正交维度'])
  })

  it('一份声明了命名族与正交维度的检索报告通过校验', () => {
    const report = [
      '## 命名族清单',
      '| 功能 | 族 A | 族 B | 族 C |',
      '| 脱液 | 压榨 | 挤压 | 离心 |',
      '## 正交维度',
      'IPC A47J 31/44；申请人反查；引证扩展',
      '## 检索式',
      'C3 = 脱液 AND 压盘',
      '## 对比文件',
      '| CN216629177U |',
      '## 公开日',
      '2022-04-29',
    ].join('\n')
    const result = validateWorkerOutput(commander, report)
    expect(result.valid).toBe(true)
    expect(result.degraded).toBe(false)
    expect(result.missingHardFields).toEqual([])
  })
})

describe('defaultPatentWorkers', () => {
  it('ships the built-in patent workers with hard output contracts', () => {
    const workers = defaultPatentWorkers()
    expect(workers.map(w => w.name)).toEqual([
      'patent-technical-analyzer',
      'patent-search-commander',
      'patent-novelty-analyzer',
      'patent-inventiveness-analyzer',
      'patent-oa-writer',
      'quality_checker',
      'case-manager',
      'applicant-counsel',
      'formal-examiner',
      'invalidity-petitioner',
      'patentee-defender',
      'defendant-counsel',
      'adjudicator',
      'tech-investigator',
      'patent-illustrator',
      'patent-document-renderer',
    ])
    for (const def of workers) {
      expect(def.outputs?.length).toBeGreaterThan(0)
      expect(def.outputs!.every(o => o.requiredFields && o.requiredFields.length > 0)).toBe(true)
    }
    const analyzer = workers.find(w => w.name === 'patent-technical-analyzer')!
    expect(analyzer.tier).toBe('work')
    expect(analyzer.forbiddenActions).toEqual(['claim_strategy', 'draft_claims', 'draft_specification'])
    const novelty = workers.find(w => w.name === 'patent-novelty-analyzer')!
    expect(novelty.triggersHITL).toBe(true)
    expect(novelty.canInvoke).toContain('patent-search-commander')
    const checker = workers.find(w => w.name === 'quality_checker')!
    expect(checker.tier).toBe('checker')
    const docRenderer = workers.find(w => w.name === 'patent-document-renderer')!
    expect(docRenderer.tier).toBe('work')
    expect(docRenderer.triggersHITL).toBe(true)
    expect(docRenderer.allowedTools).toContain('render_patent_document')
    expect(docRenderer.forbiddenActions?.some(a => a.includes('实体结论'))).toBe(true)
    const illustrator = workers.find(w => w.name === 'patent-illustrator')!
    expect(illustrator.tier).toBe('work')
    expect(illustrator.triggersHITL).toBe(true)
    expect(illustrator.allowedTools).toContain('add_patent_figure_references')
    expect(illustrator.outputs?.[0]?.requiredFields).toEqual(['附图文件', '附图标记表', '图文一致性', '形式要件核验'])
  })
})
