import { describe, expect, it } from 'vitest'
import { analyzeSlop, visibleChars } from '../src/quality/slop-engine.ts'

describe('analyzeSlop structure-issue detection', () => {
  it('detects all six structure-issue categories and scores the document', () => {
    const text = [
      '本申请解决的技术问题是精度问题。',
      '区别特征在于采用了新型结构。该区别特征使得本申请具有显著的进步。',
      '区别特征：采用新型结构，长度足够长超过三十个字符用于触发冒号分支。',
      '|区别特征|对比文件¶0123|',
      '|区别特征|对比文件[2020]|',
      '|区别特征|对比方案|',
      '这不是精度问题，而是成本问题。',
      '权利要求被驳回。',
      '审查员认定为非显而易见。',
      '审查员认定有误，请复核。',
      '第1条 第2条 第3条 第4条',
      '检索数据库命中 D1¶0123。',
      '进一步地，本发明对现有方案进行了深入分析。',
    ].join('\n\n')

    const analysis = analyzeSlop(text)
    const types = analysis.issues.map(i => i.type)
    expect(types).toContain('empty_three_step')
    expect(types).toContain('fake_comparison')
    expect(types).toContain('binary_turn')
    expect(types).toContain('passive_voice')
    expect(types).toContain('oa_formula')
    expect(types).toContain('reason_pile')
    // 10+ issues → rhythm 4; D1 + ¶0123 present → evidence 9 (both +2, no +1)
    expect(analysis.score.rhythm).toBe(4)
    expect(analysis.score.evidence).toBe(9)
    // 开头正文点明了争点（「精度问题」），但同段有 oa_formula 套话「审查员认定有误」→ 5 而非 8。
    expect(analysis.score.directness).toBe(5)
    // 进一步地 (deleted) + 深入分析→分析 (replaced)
    expect(analysis.changes).toHaveLength(2)
    expect(analysis.changes[0]?.replacement).toBe('（删除）')
    expect(analysis.changes[1]?.replacement).toBe('分析')
    // Checklist detail counts the present passive-voice category.
    expect(analysis.checklist[1]?.detail).toBe('1 处被动句')
  })

  it('renders rhythm 6 for two issues and 无 for absent categories', () => {
    const analysis = analyzeSlop('区别特征：冒号后无编号。\n这不是精度问题，而是成本问题。')
    expect(analysis.issues).toHaveLength(2)
    expect(analysis.score.rhythm).toBe(6)
    expect(analysis.checklist[1]?.detail).toBe('无')
  })

  it('scores practicality from the phrase-cleanup count', () => {
    const heavy = analyzeSlop('进一步地，此外，值得一提的是，不难发现，毋庸置疑，综上所述，本申请具有显著进步。')
    expect(heavy.changes.length).toBe(7)
    expect(heavy.score.practicality).toBe(5)

    const medium = analyzeSlop('进一步地，此外，综上所述。')
    expect(medium.changes.length).toBe(3)
    expect(medium.score.practicality).toBe(7)
  })

  it('scores concision from paragraph count only when no budget is declared', () => {
    const text = Array.from({ length: 18 }, (_, i) => `第${i + 1}段说明一个事实`).join('\n\n')
    // 撰写链路（权项草稿）没有声明预算的调用方：沿用旧口径，读数不漂移。
    expect(analyzeSlop(text).score.concision).toBe(5)
  })

  it('scores concision against the declared budget, not the paragraph count', () => {
    // 40 段、360 个可见字：旧口径按段数必判 5 分——八节意见陈述书必然踩中。
    const text = Array.from({ length: 40 }, () => '本段说明一个事实').join('\n\n')
    const at = (charBudget: number): number => analyzeSlop(text, { charBudget }).score.concision
    expect(at(400)).toBe(8) // 预算内不扣分
    expect(at(300)).toBe(6) // 超出 25% 以内
    expect(at(240)).toBe(4) // 超出 50%（含）以内
    expect(at(200)).toBe(3) // 超出 50% 以上
  })

  it('reads directness from the opening prose, skipping the biblio header and headings', () => {
    const text = [
      '# 意见陈述书',
      '',
      '**申请号：** CN2026XXXXXXXX.X',
      '**发明名称：** 一种智能保温杯',
      '',
      '> 说明：本稿未使用未核验的对比文件。',
      '',
      '## 一、总体立场',
      '',
      '审查意见对权利要求 1 的创造性异议不能成立。',
    ].join('\n')
    // 抬头与标题不是正文第一段：跳过它们才能读到真正点明争点的那一句。
    expect(analyzeSlop(text).score.directness).toBe(8)
  })

  it('drops directness when the opening is a formulaic plea even if it names the issue', () => {
    const plea = '申请人恳请审查员重新考虑本申请关于创造性的问题。'
    // 点明了争点（「问题」），但开头就是「请审查员重新考虑」——请愿不是论证。
    expect(analyzeSlop(plea).score.directness).toBe(5)
    expect(analyzeSlop('审查意见对权利要求 1 的创造性异议不能成立。').score.directness).toBe(8)
  })

  it('caps evidence for a budgeted document that cites nothing at all', () => {
    // 两句话的套话答复：无对比文件、无权项、无法条，也没有引用段。
    const boilerplate = '申请人恳请审查员重新考虑本申请的创造性。\n\n综上所述，本申请具备创造性。'
    const budgeted = analyzeSlop(boilerplate, { charBudget: 4000 })
    expect(budgeted.score.evidence).toBe(4)
    // 声明预算的文书通篇零锚点不能靠基线 5 分过线（4 + 4 + 8 + 9 + 8 = 33 < 35）。
    expect(budgeted.score.total).toBe(33)
    expect(budgeted.score.passed).toBe(false)
    // 撰写链路（无预算）保留中性基线 + 短段落加分，权项草稿的读数不变。
    expect(analyzeSlop(boilerplate).score.evidence).toBe(6)
  })

  it('stops collecting the opening prose once enough text has been read', () => {
    // 单段长文（>400 字）：取到足够长度就停止，切片仍是 200 字。
    const long = '审查意见对该申请的创造性异议不能成立。'.repeat(20)
    expect(analyzeSlop(long).score.directness).toBe(8)
  })

  it('does not call a sentence "empty three step" when it carries an evidence anchor', () => {
    const ruleQuote = 'R2《专利审查指南》第二部分第四章第 3.2 节：创造性判断的三步法，含区别特征与实际解决的技术问题。'
    const withAnchor = '第二步：权利要求 1 与 D1 的区别特征即 F2 所载的联动控制（见 3.1 节）。'
    const withoutAnchor = '区别特征：采用新型结构。'
    const types = (line: string): string[] => analyzeSlop(line).issues.map(issue => issue.type)
    expect(types(ruleQuote)).not.toContain('empty_three_step')
    expect(types(withAnchor)).not.toContain('empty_three_step')
    expect(types(withoutAnchor)).toContain('empty_three_step')
  })

  it('does not call a passive clause "hidden subject" when the actor precedes it', () => {
    const named = '审查意见未认定该特征被公开，故其构成附加限定。'
    const hidden = '该特征被公开。'
    const types = (line: string): string[] => analyzeSlop(line).issues.map(issue => issue.type)
    expect(types(named)).not.toContain('passive_voice')
    expect(types(hidden)).toContain('passive_voice')
  })

  it('counts distinct provisions, not repeated citations, for the reason pile', () => {
    const repeated = '专利法第22条第3款 ... 专利法第22条第3款 ... 专利法第22条第3款 ... 专利法第22条第3款'
    const distinct = '专利法第22条第3款 第26条第3款 第33条 第5条'
    const types = (line: string): string[] => analyzeSlop(line).issues.map(issue => issue.type)
    // 同一法条被逐节引用十次仍是一条理由：答复正文的正常写法不是「理由堆积」。
    expect(types(repeated)).not.toContain('reason_pile')
    expect(types(distinct)).toContain('reason_pile')
  })

  it('skips heading and table-separator lines in the structure scan', () => {
    const text = ['#### 2. 第二步：区别特征与实际解决的技术问题', '', '|---|---|---|---|'].join('\n')
    expect(analyzeSlop(text).issues).toHaveLength(0)
  })

  it('checks evidence-marker flags on a feature snippet without claim refs', () => {
    const analysis = analyzeSlop('本发明的区别特征记载于 D1¶0100。')
    const feature = analysis.checklist[0]
    expect(feature?.passed).toBe(true)
    expect(feature?.detail).toContain('检查前500字')
  })
})

describe('visibleChars · 载体块不计入篇幅（conventions §10）', () => {
  it('Markdown 表格不计入字数', () => {
    const prose = '审查意见仅以单篇D1评述创造性。'
    const table = ['| 权项 | 修改前 | 修改后 |', '| --- | --- | --- |', '| 1 | 原权利要求1 | 未修改 |'].join('\n')
    expect(visibleChars(`${prose}\n\n${table}`)).toBe(visibleChars(prose))
  })

  it('HTML 表格不计入字数', () => {
    const prose = '审查意见仅以单篇D1评述创造性。'
    const table = '<table><tbody><tr><td>证据一</td><td>CN101234567A</td></tr></tbody></table>'
    expect(visibleChars(`${prose}${table}`)).toBe(visibleChars(prose))
  })

  it('Markdown「修改后的独立权利要求」整节不计入字数，同级下一节恢复计数', () => {
    const head = '## 一、总体立场\n纯争辩，不修改。\n'
    const claim = '## 2.1 修改后的独立权利要求\n权利要求 1：一种装置，包括阀体与螺旋通道。\n'
    const next = '## 三、本案事实\n本案为纯争辩。\n'
    const all = visibleChars(`${head}${claim}${next}`)
    expect(all).toBe(visibleChars(`${head}${next}`))
  })

  it('权项全文节内的更深层标题仍属该节，不恢复计数', () => {
    const head = '## 一、总体立场\n纯争辩。\n'
    const claim = '## 2.1 修改后的独立权利要求\n### 权1\n权利要求 1：一种装置。\n'
    const next = '## 三、本案事实\n本案为纯争辩。\n'
    expect(visibleChars(`${head}${claim}${next}`)).toBe(visibleChars(`${head}${next}`))
  })

  it('HTML claim-text 块不计入字数', () => {
    const prose = '本次修改涉及权利要求1。'
    const block = '<div class="claim-text"><strong>权利要求 1：</strong>一种装置。</div>'
    expect(visibleChars(`${prose}${block}`)).toBe(visibleChars(prose))
  })

  it('行内竖线是散文而不是表格行，仍计入（只是记号被剔除）', () => {
    expect(visibleChars('A|B')).toBe(2)
  })
})

describe('analyzeSlop · 预算维度按载体外的散文计', () => {
  it('表格占大半篇幅时不因表字数被判超预算', () => {
    const prose = '审查意见仅以单篇D1评述创造性，权1的螺旋通道未被公开。'.repeat(3)
    const table = ['| 证据 | 公开号 | 段落 |', '| --- | --- | --- |',
      ...Array.from({ length: 30 }, (_, i) => `| 证据${String(i)} | CN1012345${String(i)}A | ¶0${String(i)} |`)].join('\n')
    const withTable = analyzeSlop(`${prose}\n\n${table}`, { charBudget: 200 })
    expect(withTable.score.concision).toBe(8)
  })
})
