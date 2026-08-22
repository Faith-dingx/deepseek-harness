/**
 * Skill-catalog message interception and replacement.
 *
 * The dsh-tool-skill plugin publishes a durable `skill-catalog` user message
 * inside `agent/pre-step` whose `source.entries` list the skills visible to
 * the model. This module locates that message in the step's messages, filters
 * its entries to the classifier-chosen subset, and re-renders the
 * `<available_skills>` block so the model only sees the allowed skills. If no
 * catalog message is present, an update-flavored catalog is inserted when
 * there are skills to expose.
 *
 * Filtering is view-level: the underlying skill registry/tool registrations are
 * untouched, so debugging and rollback stay trivial.
 *
 * @module @deepseek-ai/dsh-skill-router
 */

import { createUserMessage, type MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SkillCatalogEntry } from './types.ts'

/**
 * Durable provider record for one published session skill catalog, mirroring
 * dsh-tool-skill's shape so the two module augmentations stay compatible.
 */
export interface SkillCatalogSource {
  readonly kind: 'skill-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly SkillCatalogEntry[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'skill-catalog': SkillCatalogSource
  }
}

const SKILL_PLUGIN = 'skill-router'

/** Read the usable entries a catalog source carries, or undefined if unreadable. */
function catalogEntries(source: unknown): SkillCatalogEntry[] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: SkillCatalogEntry[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { name, description } = entry as { name?: unknown; description?: unknown }
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return undefined
    readable.push({ name, description })
  }
  return readable
}

/** True when the message is a usable skill-catalog message. */
function isCatalogMessage(message: UserMessage): message is UserMessage & { source: SkillCatalogSource } {
  return (message.source as { kind?: unknown }).kind === 'skill-catalog' && catalogEntries(message.source) !== undefined
}

/**
 * Escape a description for the pseudo-XML `<available_skills>` block (mirrors
 * dsh-tool-skill's escaping).
 */
function escapeCatalogText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')
}

/** Rendered `<available_skills>` block lines from the given entries. */
function renderEntryLines(entries: readonly SkillCatalogEntry[]): string[] {
  return entries.map(entry => `- \`${entry.name}\`: ${escapeCatalogText(entry.description)}`)
}

/** Build a filtered skill-catalog user message with an update frame. */
function renderFilteredCatalog(entries: readonly SkillCatalogEntry[], originalLabel: string): UserMessage {
  const availability = entries.length === 0
    ? 'No skills are currently available through the `skill` tool. Do not use names from earlier skill catalogs.'
    : 'Use only names in this filtered catalog. If the user names a listed skill, or the task clearly matches its description, call the `skill` tool with the exact name before acting.'
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `${originalLabel} The available skill catalog was filtered for this task. The following skills are available in this session:`,
        '',
        '<available_skills>',
        ...renderEntryLines(entries),
        '</available_skills>',
        '',
        availability,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: {
      kind: 'skill-catalog',
      form: 'catalog',
      update: true,
      entries,
    },
  })
}

/** Find the first usable skill-catalog message (if any). */
function findCatalog(messages: readonly UserMessage[]): UserMessage & { source: SkillCatalogSource } | undefined {
  return messages.find(isCatalogMessage)
}

/**
 * Filter the step's messages so the skill-catalog reflects only `included`
 * names. Names absent from the catalog are ignored; an empty `included` set
 * yields a catalog with no entries (unless no catalog exists at all).
 *
 * @param messages - the step's messages (produced by downstream pre-step listeners).
 * @param included - skill names to keep exposed.
 * @returns a new messages array with the catalog (if any) filtered.
 */
export function interceptCatalog(messages: readonly UserMessage[], included: readonly string[]): UserMessage[] {
  const includeSet = new Set(included)
  const existing = findCatalog(messages)
  if (existing === undefined) {
    // No catalog was published at all. Only insert one when there is
    // something to expose; otherwise leave the messages untouched.
    if (includeSet.size === 0) return [...messages]
    const entries: SkillCatalogEntry[] = []
    return [
      ...messages,
      renderFilteredCatalog(entries, 'A skill router injected this catalog.'),
    ]
  }
  const original = catalogEntries(existing.source) ?? []
  const filtered = original.filter(entry => includeSet.has(entry.name))
  const rebuilt = renderFilteredCatalog(filtered, 'A skill router filtered this catalog.')
  return messages.map(message => (message === existing ? rebuilt : message))
}

/** The source tag used when the plugin itself injects context messages. */
export const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: SKILL_PLUGIN }
