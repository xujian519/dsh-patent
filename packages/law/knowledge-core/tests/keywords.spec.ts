import { describe, expect, it } from 'vitest'
import { extractLawKeywords } from '@deepseek-ai/dsh-knowledge-core'

describe('extractLawKeywords', () => {
  it('splits long queries into >=3 char fragments on stop words', () => {
    expect(extractLawKeywords('专利侵权的赔偿标准是什么')).toEqual(['专利侵权', '赔偿标准'])
  })

  it('keeps a stop-word-free long word', () => {
    expect(extractLawKeywords('赔偿标准')).toEqual(['赔偿标准'])
  })

  it('drops 2-char fragments (trigram needs 3+ chars)', () => {
    expect(extractLawKeywords('赔偿 标准')).toEqual([])
  })

  it('returns empty for blank queries', () => {
    expect(extractLawKeywords('')).toEqual([])
    expect(extractLawKeywords('   ')).toEqual([])
  })

  it('caps the fragment count with max', () => {
    expect(extractLawKeywords('一种新型电池的制造方法以及应用场景', 1)).toEqual(['新型电池'])
    expect(extractLawKeywords('一种新型电池的制造方法以及应用场景', 3)).toEqual(['新型电池', '制造方法', '应用场景'])
  })
})
