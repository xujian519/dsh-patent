/**
 * nuo-patent data-engine mapping: parses the JSON-string fields (inventors,
 * assignees, classifications, citations) that nuo-patent inherits from its
 * Python origin into the structured arrays the tool layer consumes.
 * @module @deepseek-ai/dsh-patent-data/mapper
 */

import type { Citation, PatentData } from '@deepseek-ai/nuo-patent'
import type { StructuredPatentData } from './types.ts'

/**
 * Leniently parse a JSON-array string; empty or invalid input yields [].
 * @param raw - the JSON-array string to parse.
 * @returns the parsed array, or [] on empty or invalid input.
 */
export function parseJsonArray<T>(raw: string): T[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/**
 * Extract one string field from a [{"<key>": "..."}] JSON-array string. The
 * engine's JSON is a wire boundary: an array may hold `null` entries, which
 * would otherwise throw on property access and fail the whole call.
 */
function extractNames(raw: string, key: 'inventor_name' | 'assignee_name'): string[] {
  return parseJsonArray<unknown>(raw)
    .map(item => (item !== null && typeof item === 'object'
      ? (item as Record<string, unknown>)[key]
      : undefined))
    .filter((value): value is string => typeof value === 'string' && value !== '')
}

/**
 * Map one nuo PatentData (JSON-string fields) into structured metadata.
 * @param data - the nuo patent record with JSON-string array fields.
 * @param patent - the normalized patent number to stamp.
 * @param url - the detail-page URL to stamp.
 * @returns the structured record with arrays parsed and citations merged.
 */
export function mapPatentData(data: PatentData, patent: string, url: string): StructuredPatentData {
  const backwardCites = [
    ...parseJsonArray<Citation>(data.backward_cite_no_family),
    ...parseJsonArray<Citation>(data.backward_cite_yes_family),
  ]
  const forwardCites = [
    ...parseJsonArray<Citation>(data.forward_cite_no_family),
    ...parseJsonArray<Citation>(data.forward_cite_yes_family),
  ]

  return {
    patent,
    url,
    title: data.title,
    applicationNumber: data.application_number,
    inventors: extractNames(data.inventor_name, 'inventor_name'),
    assigneesOriginal: extractNames(data.assignee_name_orig, 'assignee_name'),
    assigneesCurrent: extractNames(data.assignee_name_current, 'assignee_name'),
    pubDate: data.pub_date,
    filingDate: data.filing_date,
    priorityDate: data.priority_date,
    grantDate: data.grant_date,
    expirationDate: data.expiration_date,
    legalStatus: data.legal_status,
    ifiStatus: data.ifi_status,
    estimatedExpiration: data.estimated_expiration,
    pdfUrl: data.pdf_url,
    classifications: parseJsonArray<unknown>(data.classifications)
      .filter((value): value is string => typeof value === 'string'),
    backwardCites,
    forwardCites,
    abstractText: data.abstract_text,
  }
}
