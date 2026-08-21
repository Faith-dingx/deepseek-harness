/**
 * Minimal dedup for assembled prompt sections/contexts.
 *
 * 计划 v12 决策3/T4: walk each collection in order and keep only the FIRST
 * occurrence of every name. No hashing, no content merging, no priority
 * picking. Sections and contexts are deduped independently — they render into
 * different places (system prompt vs. runtime-context snapshot), so a section
 * and a context sharing a name are NOT duplicates.
 *
 * @module dsh-injection-manager/dedup
 */

import type { AssembledContext, AssembledSection } from '@deepseek-ai/dsh-system-prompt'

function firstByName<T extends { name: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const entry of entries) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    result.push(entry)
  }
  return result
}

/**
 * Keep only the first occurrence of each section name.
 * @param sections - the assembled sections in prompt order.
 * @returns a new list; the first occurrence wins, relative order is preserved.
 */
export function dedupSections(sections: readonly AssembledSection[]): AssembledSection[] {
  return firstByName(sections)
}

/**
 * Keep only the first occurrence of each context name.
 * @param contexts - the assembled contexts in snapshot order.
 * @returns a new list; the first occurrence wins, relative order is preserved.
 */
export function dedupContexts(contexts: readonly AssembledContext[]): AssembledContext[] {
  return firstByName(contexts)
}

/**
 * Dedup both sides of an assembly.
 * @param sections - the assembled sections.
 * @param contexts - the assembled contexts.
 * @returns `{ sections, contexts }`, each deduped independently.
 */
export function dedup(
  sections: readonly AssembledSection[],
  contexts: readonly AssembledContext[],
): { sections: AssembledSection[]; contexts: AssembledContext[] } {
  return { sections: dedupSections(sections), contexts: dedupContexts(contexts) }
}
