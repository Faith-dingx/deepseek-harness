/**
 * Memory-file layering: classify injected sections/contexts into the
 * short-term (managed, kept) or long-term (unmanaged, dropped) layer.
 *
 * 计划 v12 决策2/T3/T5.c: classification is hardcoded BY NAME — no timestamps,
 * no content inspection, no second truncation. The memory plugins
 * (dsh-persona-memory, @a9i5k4/dsh-auto-memory) inject exactly the six known
 * short-term names today; a future/renamed memory injection (still inside the
 * `memory:` / `dsh:` namespace) classifies long-term and is dropped so only
 * sanctioned short-term memory reaches the model. Everything outside that
 * namespace is not the manager's business and passes through untouched — the
 * persona, harness identity, tool guidance, and agent instructions must keep
 * flowing (fail-open and zero-regression guarantees).
 *
 * Calendar content is NOT handled separately: it lives inside the
 * `dsh:auto-memory` context text, which is a known short-term name and passes
 * through as-is (计划 v12 T3 note).
 *
 * @module dsh-injection-manager/memory-layer
 */

import type { AssembledContext, AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import { SHORT_TERM_MEMORY_NAMES } from './config.ts'

/** Which memory layer an injected name belongs to. */
export type MemoryLayer = 'short-term' | 'long-term'

const SHORT_TERM = new Set<string>(SHORT_TERM_MEMORY_NAMES)

/** The memory plugins' injection namespace: `memory:*` sections and `dsh:*` context/sections. */
const MEMORY_NAMESPACE_PREFIXES = ['memory:', 'dsh:']

function isMemoryInjection(name: string): boolean {
  return MEMORY_NAMESPACE_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * Classify a section/context name into its memory layer.
 * Known short-term names -> 'short-term'; everything else -> 'long-term'.
 */
export function classifyMemoryLayer(name: string): MemoryLayer {
  return SHORT_TERM.has(name) ? 'short-term' : 'long-term'
}

/**
 * Filter a section/context pair by memory layer.
 *
 * Semantic (documented against the plan's ambiguous "不管理 long-term（丢弃）"):
 * - known short-term names are kept;
 * - unknown names INSIDE the memory-plugin namespace are long-term and dropped
 *   (future/renamed memory injections never enter the prompt);
 * - names outside the namespace (persona, tool guidance, agent instructions…)
 *   are untouched, so an aggressive whole-assembly drop can never gut the
 *   system prompt.
 *
 * @returns the filtered arrays; surviving entries keep their exact name/text.
 */
export function filterMemoryLayers(
  sections: readonly AssembledSection[],
  contexts: readonly AssembledContext[],
): { sections: AssembledSection[]; contexts: AssembledContext[] } {
  const keep = (entry: { name: string }): boolean =>
    !isMemoryInjection(entry.name) || classifyMemoryLayer(entry.name) === 'short-term'
  return {
    sections: sections.filter(keep),
    contexts: contexts.filter(keep),
  }
}
