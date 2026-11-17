import { describe, expect, it } from 'vitest'
import { buildWorkflowEvidenceLedger } from '@deepseek-ai/dsh-patent-core'
import { CitationCheckHandler, citationCheckAtom } from '../src/atoms/handlers/builtin/citation.ts'

const handler = new CitationCheckHandler()

describe('citation-check atom', () => {
  it('声明的输出键以报告为主输出，参数可覆盖引用文本与检索结果键', () => {
    expect(citationCheckAtom.name).toBe('citation-check')
    expect(citationCheckAtom.category).toBe('gate')
    expect(citationCheckAtom.outputSchema[0]).toBe('citation_check_report')
    expect(citationCheckAtom.inputSchema).toContain('novelty_conclusion')
  })

  it('D 标号在检索结果中接地时通过', async () => {
    const out = await handler.execute({
      state: { novelty_conclusion: '相对于 D1 不具备新颖性', prior_art: [{ patent: 'CN111111111A' }] },
    })
    expect(out.citation_check_grounded).toBe(true)
    expect(out.citation_check_failures).toEqual([])
    expect(String(out.citation_check_report)).toContain('引用全部接地')
  })

  it('D10 不会被 D1 前缀误接受（拒绝路径）', async () => {
    const out = await handler.execute({
      state: { novelty_conclusion: '另引用 D10 佐证', prior_art: [{ title: 'D1 的某专利' }] },
    })
    expect(out.citation_check_grounded).toBe(false)
    expect(out.citation_check_failures).toEqual(['D10'])
    expect(String(out.citation_check_report)).toContain('D10')
  })

  it('D 标号按证据台账收据接地（即使检索结果没有可提取的专利号）', async () => {
    const state = {
      novelty_conclusion: '对比文件2 破坏新颖性',
      prior_art: [{ title: '某篇没有专利号的检索结果' }, { title: '第二篇检索结果' }],
    }
    const out = await handler.execute({ state })
    expect(out.citation_check_grounded).toBe(true)
    expect(out.citation_check_failures).toEqual([])

    const ledger = buildWorkflowEvidenceLedger(state, { manifestId: 'patent_novelty_v1' })
    expect(ledger.receipts.filter(receipt => receipt.source === 'prior-art').map(receipt => receipt.citationId)).toEqual([
      'D1',
      'D2',
    ])
  })

  it('D 标号在证据台账中没有对应收据时拒绝', async () => {
    const out = await handler.execute({
      state: {
        novelty_conclusion: '引用 D3 破坏新颖性',
        prior_art: [{ title: '第一篇检索结果' }, { title: '第二篇检索结果' }],
      },
    })
    expect(out.citation_check_grounded).toBe(false)
    expect(out.citation_check_failures).toEqual(['D3'])
  })

  it('专利号引用按 prior_art 中的专利号接地', async () => {
    const out = await handler.execute({
      state: {
        novelty_result: JSON.stringify({ assessments: [{ prior_art: 'US11452699B2 公开了该特征' }] }),
        prior_art: [{ patent: 'US11452699B2' }],
      },
    })
    expect(out.citation_check_grounded).toBe(true)
  })

  it('prior-art-filter 保留的原始 D 标号优先于数组位次', async () => {
    const shifted = await handler.execute({
      state: {
        novelty_conclusion: 'D1 破坏新颖性',
        prior_art: [{ title: 'CN222222222A', dLabel: 'D2' }],
      },
    })
    expect(shifted.citation_check_grounded).toBe(false)
    expect(shifted.citation_check_failures).toEqual(['D1'])

    const original = await handler.execute({
      state: {
        novelty_conclusion: 'D2 破坏新颖性',
        prior_art: [{ title: 'CN222222222A', dLabel: 'D2' }],
      },
    })
    expect(original.citation_check_grounded).toBe(true)
  })

  it('params 可指定引用文本键与检索结果键', async () => {
    const out = await handler.execute({
      state: {
        ref_text_keys: ['conclude'],
        prior_art_key: 'search_hits',
        conclude: '与 D2 的区别在于连接方式',
        search_hits: [{ title: 'D2 的检索结果' }],
      },
    })
    expect(out.citation_check_grounded).toBe(true)
  })

  it('配置键保留首尾空格，按原样读取 state', async () => {
    const out = await handler.execute({
      state: {
        ref_text_keys: [' conclude '],
        prior_art_key: ' search hits ',
        ' conclude ': '与 D2 的区别在于连接方式',
        ' search hits ': [{ title: 'D2', dLabel: 'D2' }],
      },
    })
    expect(out.citation_check_grounded).toBe(true)
  })

  it('检索结果为空时放行并说明跳过原因（不双重惩罚）', async () => {
    const out = await handler.execute({ state: { novelty_conclusion: '引用 D1' } })
    expect(out.citation_check_grounded).toBe(true)
    expect(String(out.citation_check_report)).toContain('检索结果为空')
  })

  it('没有引用文本时降级，不把上游失败当成接地', async () => {
    const out = await handler.execute({ state: { prior_art: [{ patent: 'CN111111111A' }] } })
    expect(String(out._error)).toContain('[citation-check]')
    expect(String(out._error)).toContain('缺少引用文本')
    expect(out.citation_check_grounded).toBeUndefined()
  })

  it('ref_text_keys 配置非法时降级', async () => {
    const nonArray = await handler.execute({ state: { ref_text_keys: 'novelty_conclusion' } })
    expect(String(nonArray._error)).toContain('ref_text_keys')
    const empty = await handler.execute({ state: { ref_text_keys: [] } })
    expect(String(empty._error)).toContain('ref_text_keys')
    const blank = await handler.execute({ state: { ref_text_keys: ['  '] } })
    expect(String(blank._error)).toContain('ref_text_keys')
  })

  it('prior_art_key 配置非法时降级', async () => {
    const out = await handler.execute({ state: { prior_art_key: 3, novelty_conclusion: 'D1' } })
    expect(String(out._error)).toContain('prior_art_key')
  })
})
