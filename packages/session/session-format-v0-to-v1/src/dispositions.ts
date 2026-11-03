/** Exact top-level payload disposition frozen for every released-v0 event type. */
export interface ReleasedV0PayloadDisposition {
  readonly required: readonly string[]
  readonly optional: readonly string[]
  /** JSON members whose nested representation is intentionally owner-opaque. */
  readonly opaque: readonly string[]
}

/**
 * Freeze one exact released payload-member disposition for adjacent format validators.
 * @param required - members that must be present.
 * @param optional - additional admitted members.
 * @param opaque - members retained as lossless JSON without nested semantic inspection.
 * @returns the detached frozen disposition.
 */
export function defineReleasedPayloadDisposition(
  required: readonly string[],
  optional: readonly string[] = [],
  opaque: readonly string[] = [],
): ReleasedV0PayloadDisposition {
  return Object.freeze({
    required: Object.freeze([...required]),
    optional: Object.freeze([...optional]),
    opaque: Object.freeze([...opaque]),
  })
}

const disposition = defineReleasedPayloadDisposition

/**
 * Frozen released-v0 event and payload-member inventory.
 * Every listed member is preserved by the identity edge. Members in `opaque`
 * remain lossless JSON without nested Session-sequence interpretation. Nested
 * merge-extensible discriminants validate known variants and preserve
 * unknown variants as owner-opaque JSON.
 */
export const RELEASED_V0_EVENT_DISPOSITIONS: Readonly<Record<string, ReleasedV0PayloadDisposition>> = Object.freeze({
  'agent-preset/selected': disposition(['agentPreset']),
  'agent/inbox/spliced': disposition(
    ['target', 'start', 'inserted'],
    ['removedCount', 'outcome'],
  ),
  'approval/asked': disposition(['id', 'toolName'], ['callId', 'reason']),
  'approval/decided': disposition(['id', 'outcome']),
  'approval/policy': disposition(['policy'], ['source']),
  'assistant/chunk': disposition(['turn', 'step', 'chunk']),
  'assistant/message': disposition(
    ['turn', 'step', 'message'],
    ['usage', 'interrupted'],
  ),
  'command/done': disposition(['commandId', 'kind'], ['text', 'sourceEventSeq']),
  'command/run': disposition(['commandId', 'name', 'source'], ['args']),
  'compaction/end': disposition(['compactionId', 'turn'], ['sourceCommandId', 'error']),
  'compaction/prune': disposition(['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount']),
  'compaction/start': disposition(['compactionId', 'turn'], ['sourceCommandId']),
  'compaction/summary': disposition(
    ['compactionId', 'summary', 'shadowedRange', 'shadowedSeqs', 'shadowedTokenCount', 'provider', 'model'],
    ['sourceCommandId', 'maxTokens', 'usage', 'rawOutput', 'llmStreamCall'],
  ),
  'feedback/record': disposition(['text']),
  'goal/change': disposition(
    ['kind', 'version', 'operation'],
    ['goal', 'roundsStarted', 'createdAt', 'updatedAt', 'cleared', 'clearedAt'],
  ),
  'hook/invoked': disposition(['turn', 'point', 'dialect', 'handlerId'], ['matcher']),
  'hook/result': disposition(
    ['turn', 'point', 'handlerId', 'decision', 'durationMs'],
    ['exitCode', 'stderrSummary'],
  ),
  'llm/retry': disposition(
    ['retryId', 'turn', 'step', 'provider', 'mode', 'policyKey', 'retry', 'delayMs', 'failure'],
    ['maxRetries'],
  ),
  'llm/retry-started': disposition(['retryId', 'turn', 'step', 'retry']),
  'model/selection': disposition(['provider', 'model'], ['reasoningEffort']),
  'patent-teams/member-added': disposition(['teamId', 'memberId', 'name'], ['role']),
  'patent-teams/member-removed': disposition(['teamId', 'memberId']),
  'patent-teams/message-sent': disposition(['teamId', 'messageId', 'from', 'to', 'content', 'ts']),
  'patent-teams/task-created': disposition(
    ['teamId', 'taskId', 'subject', 'dependencies'],
    ['assignee', 'worker'],
  ),
  'patent-teams/task-gated': disposition(['teamId', 'taskId', 'score', 'failures', 'feedback']),
  'patent-teams/task-updated': disposition(
    ['teamId', 'taskId', 'status'],
    ['assignee', 'output', 'attempt', 'attemptId'],
  ),
  'patent-teams/task-validated': disposition(
    ['teamId', 'taskId', 'worker', 'valid', 'missingHardFields', 'degraded'],
  ),
  'patent-teams/team-created': disposition(['teamId', 'captainSessionId', 'name'], ['description']),
  'permission/preset': disposition(['preset'], ['origin']),
  'plan/mode': disposition(['active']),
  'request/context': disposition(['provider', 'model'], ['contextWindow']),
  'request/header': disposition(['header', 'reason'], ['startsSeries']),
  'sandbox/mode': disposition(['mode'], ['source']),
  'schedule/change': disposition(['version', 'operation'], ['schedule', 'id', 'acceptedAt']),
  'self-evolve/reflection': disposition(['turn', 'step', 'patternId', 'confidence', 'suggestion']),
  'session-log-deepseek/delivery-accepted': disposition(
    ['sessionId', 'throughSeq'],
  ),
  'session/end-seed': disposition([]),
  'session/title': disposition(['title', 'messageSeqs', 'source']),
  'session/title-llm-request': disposition(
    ['titleProvider', 'messageSeqs', 'route', 'system', 'messages', 'maxTokens'],
  ),
  'step/end': disposition(['turn', 'step']),
  'step/start': disposition(['turn', 'step']),
  'subagent/descriptor': disposition(
    ['version', 'provider'],
    ['mode', 'label', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona', 'toolFilter'],
  ),
  'subagent/model-selection-policy': disposition(['allowedModels']),
  'team/member': disposition(['version', 'teamId', 'member']),
  'team/message/delivered': disposition(['version', 'teamId', 'messageId', 'targetId']),
  'team/message/queued': disposition(['version', 'teamId', 'message']),
  'team/task': disposition(['version', 'teamId', 'task']),
  'todo/write': disposition(['todos']),
  'tool-workflow/agent-end': disposition(['runId', 'seq', 'outcome']),
  'tool-workflow/agent-start': disposition(['runId', 'seq', 'label', 'childId'], ['phase']),
  'tool-workflow/run-end': disposition(['runId', 'stopReason']),
  'tool-workflow/run-start': disposition(['runId', 'name']),
  'tool/call': disposition(['turn', 'step', 'callId', 'name', 'arguments']),
  'tool/code-dispatch': disposition(
    ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments', 'isError', 'content'],
    [],
    ['arguments'],
  ),
  'tool/code-dispatch-start': disposition(
    ['rootCallId', 'parentCallId', 'subCallId', 'name', 'arguments'],
    [],
    ['arguments'],
  ),
  'tool/result': disposition(
    ['turn', 'step', 'message'],
    ['error', 'meta'],
    ['meta'],
  ),
  'turn/end': disposition(['turn', 'reason']),
  'turn/start': disposition(['turn']),
  'user/message': disposition(['role', 'id', 'content', 'source']),
  'web/deepseek-search-llm-request': disposition(['endpoint', 'apiVersion', 'body']),
})

/** Stable sorted released-v0 event inventory. */
export const RELEASED_V0_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.keys(RELEASED_V0_EVENT_DISPOSITIONS).sort((left, right) => left.localeCompare(right, 'en')),
)
