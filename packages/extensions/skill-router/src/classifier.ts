/**
 * Auxiliary classifier invocation.
 *
 * Classification runs on a small auxiliary model reached over a plain HTTP
 * Chat Completions call (the preset layer has no unified `ctx.llm`, so we do
 * not route through it). The call is bounded by a configurable timeout and
 * throws on any failure (network error, non-2xx, timeout, abort) — the caller
 * applies the configured fallback policy rather than ever letting a broken
 * classifier leak something unsafe into the catalog.
 *
 * @module @deepseek-ai/dsh-skill-router
 */

import type { SkillRouterConfig } from './types.ts'
import { buildSystemPrompt } from './prompt.ts'
import type { SkillCatalogEntry } from './types.ts'
import type { SkillFilterResult } from './types.ts'
import { parseFilterResult } from './filter.ts'

/** The raw HTTP client primitive. Kept separate for isolated unit testing. */
export async function callClassifier(
  config: Pick<SkillRouterConfig, 'classifierEndpoint' | 'classifierModel' | 'timeoutMs'>,
  userMessage: string,
  available: readonly SkillCatalogEntry[],
  context: { workspacePath: string; presetId: string },
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, config.timeoutMs)
  const onAbort = (): void => { controller.abort() }
  signal?.addEventListener('abort', onAbort)
  const system = buildSystemPrompt(userMessage, available, context)
  try {
    const response = await fetch(config.classifierEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.classifierModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMessage },
        ],
        temperature: 0,
        max_tokens: 200,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`classifier HTTP ${response.status}`)
    const data: unknown = await response.json()
    const content = extractContent(data)
    if (content === undefined) throw new Error('classifier response had no usable content')
    return content
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * High-level classification entry point: call the classifier, parse the reply,
 * and apply the fallback policy on any failure. Never throws.
 */
export async function classify(
  config: SkillRouterConfig,
  userMessage: string,
  available: readonly SkillCatalogEntry[],
  context: { workspacePath: string; presetId: string },
  signal?: AbortSignal,
): Promise<SkillFilterResult> {
  try {
    const raw = await callClassifier(config, userMessage, available, context, signal)
    return parseFilterResult(raw, config.fallback, available.map(entry => entry.name))
  } catch {
    return parseFilterResult('', config.fallback, available.map(entry => entry.name))
  }
}

/** Pull the assistant message text out of an OpenAI-style Chat Completions payload. */
function extractContent(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const choices = (data as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first: unknown = choices[0]
  if (typeof first !== 'object' || first === null) return undefined
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  return undefined
}
