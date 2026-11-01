/**
 * Shared task identity projection for the status and archive payloads.
 *
 * Both views expose the same stable row prefix; only the view-specific fields
 * (attempt capability vs. recorded output) differ.
 * @module dsh-patent-teams/task-view
 */

import type { TaskStatus, TeamTask } from './types.ts'

/** The task fields every read-only projection exposes. */
interface TaskBaseView {
  id: string
  subject: string
  status: TaskStatus
  assignee: string
  dependencies: string[]
}

/**
 * Project one task's identity fields.
 * @param task - the durable task record.
 * @returns the shared row fields.
 */
export function taskBase(task: TeamTask): TaskBaseView {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    assignee: task.assignee ?? '',
    dependencies: task.dependencies,
  }
}
