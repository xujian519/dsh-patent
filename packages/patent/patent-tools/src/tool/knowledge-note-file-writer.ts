/**
 * File-backed note writer for `knowledge_note_save`: persists each note as
 * one JSON file (`<noteDir>/<documentId>.json`) under the project knowledge
 * directory, keyed by the idempotent documentId. Existence of the file is the
 * duplicate marker, so repeated saves of the same content skip (idempotent).
 *
 * dsh-patent-knowledge has no write API (the knowledge.db personal_note layer
 * is deferred), so notes land as files in the workspace knowledge directory
 * where fs-search / grep can recall them — matching the patent preset's
 * `99-知识库/` accumulation convention.
 * @module @deepseek-ai/dsh-patent-tools/tool/knowledge-note-file-writer
 */

import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson } from '@deepseek-ai/dsh-patent-core'
import type { KnowledgeNote, KnowledgeNoteSaveDeps, WriteNoteResult } from './knowledge-note-save.ts'

/**
 * Build the `writeNote` dependency of `knowledge_note_save` as a file writer.
 * @param noteDir - directory holding the note files (created on first write).
 * @returns a writeNote implementation persisting one JSON file per note.
 */
export function createNoteFileWriter(noteDir: string): KnowledgeNoteSaveDeps['writeNote'] {
  return async (note: KnowledgeNote): Promise<WriteNoteResult> => {
    const file = join(noteDir, `${note.documentId}.json`)
    try {
      await access(file)
      return { saved: false, reason: 'duplicate' }
    } catch (error) {
      // Only a missing file means first save; any other access error fails loud.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await mkdir(noteDir, { recursive: true })
    const record = {
      documentId: note.documentId,
      title: note.title,
      content: note.content,
      ...(note.project === undefined ? {} : { project: note.project }),
      ts: Date.now(),
    }
    await atomicWriteJson(file, JSON.stringify(record, null, 2))
    return { saved: true, path: file }
  }
}
