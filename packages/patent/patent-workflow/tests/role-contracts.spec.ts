import { describe, expect, it } from 'vitest'
import {
  defaultPatentWorkers,
  defaultRoleContracts,
  roleContract,
  roleWorkers,
  validateWorkerOutput,
  workerDeliverables,
  workerTools,
  type RoleStance,
} from '@deepseek-ai/dsh-patent-workflow'

const STANCES: readonly RoleStance[] = [
  'neutral',
  'agent-side',
  'examiner',
  'applicant',
  'defense',
  'attacker',
  'judge',
]

describe('defaultRoleContracts', () => {
  it('ships the fourteen team roles with unique ids and legal stances', () => {
    const roles = defaultRoleContracts()
    expect(roles).toHaveLength(14)
    const ids = roles.map(role => role.role)
    expect(new Set(ids).size).toBe(ids.length)
    for (const role of roles) {
      expect(STANCES).toContain(role.stance)
      expect(role.name || null).toBeTruthy()
      expect(role.workers.length).toBeGreaterThan(0)
      expect(Array.isArray(role.forbiddenActions)).toBe(true)
    }
  })

  it('every referenced worker resolves to a registered patent worker with a hard output contract', () => {
    const byName = new Map(defaultPatentWorkers().map(worker => [worker.name, worker]))
    for (const role of defaultRoleContracts()) {
      for (const name of role.workers) {
        const worker = byName.get(name)
        expect(worker, `role "${role.role}" references unknown worker "${name}"`).toBeDefined()
        expect(worker!.outputs?.length).toBeGreaterThan(0)
        expect(worker!.outputs!.every(o => o.requiredFields && o.requiredFields.length > 0)).toBe(true)
      }
    }
  })
})

describe('roleWorkers', () => {
  it('resolves a known role to its worker contract objects', () => {
    const workers = roleWorkers('researcher')
    expect(workers.map(w => w.name)).toEqual(['patent-search-commander'])
    expect(roleWorkers('drafter').map(w => w.name)).toEqual(['patent-technical-analyzer', 'patent-oa-writer'])
    expect(roleWorkers('adjudicator').map(w => w.name)).toEqual(['adjudicator'])
  })

  it('returns an empty list for an unknown role', () => {
    expect(roleWorkers('no-such-role')).toEqual([])
  })
})

describe('roleContract', () => {
  it('looks up a role by id and returns undefined for an unknown id', () => {
    const researcher = roleContract('researcher')
    expect(researcher?.name).toBe('检索员')
    expect(researcher?.stance).toBe('neutral')
    expect(roleContract('case-manager')?.forbiddenActions).toContain('不评技术或法律实体内容')
    expect(roleContract('no-such-role')).toBeUndefined()
  })

  it('resolves the illustrator role to its neutral stance and figure worker', () => {
    const illustrator = roleContract('illustrator')
    expect(illustrator?.name).toBe('制图员')
    expect(illustrator?.stance).toBe('neutral')
    expect(illustrator?.triggersHITL).toBe(true)
    expect(roleWorkers('illustrator').map(w => w.name)).toEqual(['patent-illustrator'])
    expect(workerDeliverables('illustrator')).toBe('附图文件、附图标记表、图文一致性、形式要件核验')
  })

  it('resolves the document-specialist role to its neutral stance and worker', () => {
    const specialist = roleContract('document-specialist')
    expect(specialist?.name).toBe('文档专员')
    expect(specialist?.stance).toBe('neutral')
    expect(specialist?.triggersHITL).toBe(true)
    expect(roleWorkers('document-specialist').map(w => w.name)).toEqual(['patent-document-renderer'])
  })
})

describe('workerDeliverables', () => {
  it('joins the required fields across a role\'s workers', () => {
    expect(workerDeliverables('researcher')).toBe('检索式、对比文件、公开日、命名族清单、正交维度')
    expect(workerDeliverables('drafter')).toBe('技术问题、技术特征、技术效果、意见陈述、修改对照')
    expect(workerDeliverables('patentee-defender')).toBe('质证意见、反证清单、修改权利要求方案')
    expect(workerDeliverables('document-specialist')).toBe('交付场景、矫正清单、渲染产物')
  })

  it('returns an empty string for an unknown role', () => {
    expect(workerDeliverables('no-such-role')).toBe('')
  })
})

describe('workerTools', () => {
  it('joins the tools a role\'s workers declare, without duplicates', () => {
    expect(workerTools('researcher')).toBe('patent_search、patent_metadata、patent_legal_status、web_search、web_fetch、patent_analysis_report、patent_eval')
    expect(workerTools('drafter')).toBe('read、web_fetch、write、patent_eval')
    expect(workerTools('illustrator')).toBe('read、write、generate_patent_figure、generate_structure_figure、add_patent_figure_references、analyze_patent_figure、search_patent_figure、check_claim_figure_coverage、validate_specification')
  })

  it('returns an empty string for an unknown role', () => {
    expect(workerTools('no-such-role')).toBe('')
  })
})

describe('role worker output validation', () => {
  it('a new role worker degrades when a hard required field is missing', () => {
    const [caseManager] = roleWorkers('case-manager')
    const missing = validateWorkerOutput(caseManager!, '只有案卷目录。', '/case/case-manager-report.md')
    expect(missing.valid).toBe(false)
    expect(missing.degraded).toBe(true)
    expect(missing.missingHardFields).toContain('期限节点')
    expect(missing.degradationReason).toContain('/case/case-manager-report.md')

    const present = validateWorkerOutput(caseManager!, '案卷目录：A；期限节点：2026-01-01；补充清单：B')
    expect(present.valid).toBe(true)
    expect(present.degraded).toBe(false)
  })
})
