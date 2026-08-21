/**
 * Conversation context extraction from the live session log.
 *
 * `tools/pre-execute` hands the guard only the execution; the conversation
 * comes from the caller agent's session events (`agent.session.events`).
 * This module projects the last 5 rounds of user + assistant message text for
 * the classifier and one hashable "last user message" for the cache key.
 * Per-entry and total bounds keep oversized transcripts out of the prompt.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Rounds collected for the classifier (5 user + 5 assistant entries). */
const MAX_ENTRIES = 10
/** Per-message text cap for the classifier conversation. */
const MAX_PER_ENTRY = 500
/** Total conversation cap for the classifier. */
const MAX_TOTAL = 4000

/** Text projected from session events for decision-making. */
export interface SessionTexts {
  /** Text of the most recent user message (cache-key hash input). */
  readonly lastUserText: string
  /** Last ~5 rounds of user+assistant text, newest last. */
  readonly conversationText: string
}

/** Extract the recent conversation and last user text from the agent's session. */
export function sessionTexts(agent: Agent): SessionTexts {
  const events = agent.session.events
  const entries: string[] = []
  for (let i = events.length - 1; i >= 0 && entries.length < MAX_ENTRIES; i -= 1) {
    const event = events[i]
    if (event === undefined) continue
    if (event.type === 'user/message') {
      const text = textOfMessageBlocks((event.data as { content?: ContentBlock[] }).content)
      if (text !== '') entries.push(`user: ${bound(text)}`)
    } else if (event.type === 'assistant/message') {
      const message = (event.data as { message?: { content?: ContentBlock[] } }).message
      const text = textOfMessageBlocks(message?.content)
      if (text !== '') entries.push(`assistant: ${bound(text)}`)
    }
  }
  const ordered = entries.reverse()
  const conversationText = ordered.join('\n').slice(0, MAX_TOTAL)

  let lastUserText = ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'user/message') {
      const text = textOfMessageBlocks((event.data as { content?: ContentBlock[] }).content)
      if (text !== '') { lastUserText = text; break }
    }
  }
  return { lastUserText, conversationText }
}

function textOfMessageBlocks(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Bound a single entry to the per-entry cap. */
function bound(text: string): string {
  return text.length > MAX_PER_ENTRY ? `${text.slice(0, MAX_PER_ENTRY)}…(truncated)` : text
}
