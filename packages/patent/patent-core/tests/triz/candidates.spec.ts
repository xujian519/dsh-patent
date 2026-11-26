import { expect, it } from 'vitest'
import { buildTrizCandidateUnits, TRIZ_CANDIDATE_STATUS } from '@deepseek-ai/dsh-patent-core'
import type { TrizContradiction, TrizMatrixStatus, TrizPrincipleRef } from '../../src/triz/types.ts'

/** 将一条矛盾按给定状态与方向装配出来；名称固定以便断言文本。 */
function contradiction(
  id: string,
  matrixStatus: TrizMatrixStatus,
  solutionDirections: string[],
  principles: TrizPrincipleRef[] = [{ number: 15, name: '动态性' }],
): TrizContradiction {
  return {
    id,
    improving: { number: 3, name: '运动物体长度' },
    worsening: { number: 1, name: '运动物体重量' },
    statement: `${id} 的矛盾表述`,
    evidence: '增大预紧力以提升结构稳定性',
    principles,
    matrixStatus,
    solutionDirections,
  }
}

it('一条方案方向折一个候选，四要素与来源齐备', () => {
  const build = buildTrizCandidateUnits([
    contradiction('C1', 'recommended', ['把预紧力改为可调分组', '装配工位改双工位'], [
      { number: 15, name: '动态性' },
      { number: 8, name: '均衡性' },
    ]),
  ])

  expect(build.skipped).toEqual([])
  expect(build.units).toHaveLength(2)
  const [first, second] = build.units
  expect(first!.id).toBe('K1')
  expect(second!.id).toBe('K2')
  expect(first!.contradictionId).toBe('C1')
  expect(first!.problem).toBe('C1 的矛盾表述')
  expect(first!.insight).toBe('借助15 动态性、8 均衡性化解「运动物体长度」与「运动物体重量」的取舍')
  expect(first!.effect).toBe('改善运动物体长度，且不以牺牲运动物体重量为代价')
  expect(first!.feature).toBe('把预紧力改为可调分组')
  expect(second!.feature).toBe('装配工位改双工位')
  expect(first!.contradictionEvidence).toBe('增大预紧力以提升结构稳定性')
  expect(first!.status).toBe(TRIZ_CANDIDATE_STATUS)
  expect(first!.principles).toHaveLength(2)
})

it('候选编号跨矛盾连续，不按矛盾重新起号', () => {
  const build = buildTrizCandidateUnits([
    contradiction('C1', 'recommended', ['方向甲']),
    contradiction('C2', 'recommended', ['方向乙', '方向丙']),
  ])

  expect(build.units.map(unit => [unit.id, unit.contradictionId, unit.feature]))
    .toEqual([['K1', 'C1', '方向甲'], ['K2', 'C2', '方向乙'], ['K3', 'C2', '方向丙']])
})

it('负控制：物理矛盾（对角格）有方向也不折出候选，只记入 skipped', () => {
  const build = buildTrizCandidateUnits([contradiction('C1', 'physical', ['方向甲', '方向乙'], [])])

  expect(build.units).toEqual([])
  expect(build.skipped).toEqual([{ contradictionId: 'C1', matrixStatus: 'physical', directionCount: 2 }])
})

it('负控制：矩阵转录空缺有方向也不折出候选', () => {
  const build = buildTrizCandidateUnits([contradiction('C3', 'gap', ['方向甲'], [])])

  expect(build.units).toEqual([])
  expect(build.skipped).toEqual([{ contradictionId: 'C3', matrixStatus: 'gap', directionCount: 1 }])
})

it('无方向的空原理矛盾既不产候选也不记录', () => {
  const build = buildTrizCandidateUnits([contradiction('C1', 'physical', [], [])])

  expect(build.units).toEqual([])
  expect(build.skipped).toEqual([])
})

it('空白方案方向剔除：剩余方向数决定候选数与计数', () => {
  const noPrinciple = buildTrizCandidateUnits([contradiction('C1', 'gap', ['   ', ''], [])])
  expect(noPrinciple.units).toEqual([])
  expect(noPrinciple.skipped).toEqual([])

  const build = buildTrizCandidateUnits([contradiction('C2', 'recommended', ['  ', '有效方向 ', ''])])
  expect(build.units).toHaveLength(1)
  expect(build.units[0]!.feature).toBe('有效方向')
})

it('原理名称缺失时按编号引用，候选文本不出现悬空空格', () => {
  const build = buildTrizCandidateUnits([
    contradiction('C1', 'recommended', ['方向甲'], [{ number: 35, name: '' }, { number: 1, name: '分割原理' }]),
  ])

  expect(build.units[0]!.insight).toBe('借助35、1 分割原理化解「运动物体长度」与「运动物体重量」的取舍')
})

it('空输入得到空的候选产物', () => {
  expect(buildTrizCandidateUnits([])).toEqual({ units: [], skipped: [] })
})
