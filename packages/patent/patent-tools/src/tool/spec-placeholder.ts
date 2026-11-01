/**
 * Draft-completeness checks: template guide markers and empty specification
 * sections. A guide marker means the section was never written; reporting it as
 * an error keeps an unfinished draft from passing the workflow gate.
 */

import { locateMatch } from '@deepseek-ai/dsh-patent-core'
import type { SpecViolation } from './spec-types.ts'

/** Markers the drafting templates leave in place of written content. */
const PLACEHOLDER_MARKERS = ['【撰写指引】', '待补充', 'TODO', 'TBD'] as const

/** The headings whose bodies the completeness checks inspect. */
const SECTION_NAMES = ['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式'] as const

/** One recognized section and the body under its heading. */
type SpecSectionBody = {
  /** Section name as printed in the heading. */
  name: string
  /** 1-based line of the heading. */
  line: number
  /** Text between this heading and the next heading. */
  body: string
}

/**
 * Split the specification into recognized section bodies.
 * @param text - the specification text.
 * @returns each recognized section with its heading line and body.
 */
export function sectionBodies(text: string): SpecSectionBody[] {
  const lines = text.split('\n')
  const sections: SpecSectionBody[] = []
  for (let index = 0; index < lines.length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is within the array bounds.
    const heading = /^#{1,6}\s*(\S.*)$/.exec(lines[index]!)
    if (heading === null) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the heading pattern always captures the title.
    const name = heading[1]!.trim()
    const recognized = SECTION_NAMES.find(candidate => name === candidate)
    if (recognized === undefined) continue
    const body: string[] = []
    let cursor = index + 1
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the loop condition bounds cursor.
    while (cursor < lines.length && !/^#{1,6}\s*\S/.test(lines[cursor]!)) {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- the loop condition bounds cursor.
      body.push(lines[cursor]!)
      cursor += 1
    }
    sections.push({ name: recognized, line: index + 1, body: body.join('\n') })
    index = cursor - 1
  }
  return sections
}

/**
 * Report every distinct template guide marker with its location.
 * @param text - the specification text.
 * @returns one error per marker found, in marker order.
 */
export function checkPlaceholderContent(text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  for (const marker of PLACEHOLDER_MARKERS) {
    if (!text.includes(marker)) continue
    // oxlint-disable-next-line typescript/no-non-null-assertion -- the marker is a substring of text, so a location exists
    const location = locateMatch(text, [marker])!
    violations.push({
      rule: 'placeholder_content',
      family: 'structure',
      severity: 'error',
      message: `说明书仍含模板占位标记「${marker}」，该部分尚未撰写（《专利法实施细则》第二十条要求说明书完整记载发明）`,
      suggestion: `删除「${marker}」，按该节要求写入实际技术内容后再交付`,
      line: location.line,
      matchedSentence: location.matchedSentence,
    })
  }
  return violations
}

/**
 * Report recognized sections whose body is empty.
 * @param text - the specification text.
 * @returns one error per empty section.
 */
export function checkEmptySections(text: string): SpecViolation[] {
  return sectionBodies(text)
    .filter(section => section.body.trim().length === 0)
    .map(section => ({
      rule: 'section_empty',
      family: 'structure' as const,
      severity: 'error' as const,
      section: section.name,
      message: `「${section.name}」标题下没有正文（《专利法实施细则》第二十条要求各部分记载相应内容）`,
      suggestion: `在「${section.name}」标题下补充实际内容`,
      line: section.line,
      matchedSentence: section.name,
    }))
}
