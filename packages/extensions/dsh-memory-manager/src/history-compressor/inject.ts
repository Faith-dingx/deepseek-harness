/**
 * 注入协同 (计划 v18 §4.2.5 / T15): the `dsh:conversation-summary` injection
 * segment. This module only EXPORTS the segment-name contract — the actual
 * whitelist wiring lives in dsh-injection-manager's SHORT_TERM_MEMORY_NAMES
 * (config.ts), where `dsh:conversation-summary` must be added so the summary
 * context is not dropped as long-term memory. It is a necessary inter-plugin
 * coordination, NOT a bypass of the injection manager.
 *
 * @module dsh-memory-manager/history-compressor/inject
 */

/** The injection context name of the conversation summary (§4.2.5). */
export const CONVERSATION_SUMMARY_CONTEXT = 'dsh:conversation-summary'

/** One assembled injection context (name + rendered text). */
export interface SummaryInjection {
  readonly name: string
  readonly text: string
}

/** Build the injection context from the summary file text. */
export function buildSummaryInjection(summaryText: string): SummaryInjection {
  return { name: CONVERSATION_SUMMARY_CONTEXT, text: summaryText }
}

/** Whether a context/section name is the conversation summary segment. */
export function isConversationSummaryName(name: string): boolean {
  return name === CONVERSATION_SUMMARY_CONTEXT
}
