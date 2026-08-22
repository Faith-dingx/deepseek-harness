/**
 * dsh-skill-router: classify the user task and filter which skills appear in
 * the model-facing session skill catalog.
 *
 * The plugin registers an `agent/pre-step` listener AFTER dsh-tool-skill (see
 * the preset mount), so the waterfall hands it the finished decision that
 * already contains the tool-skill catalog message. On a new user message it
 * asks a small auxiliary model (plain HTTP Chat Completions) which skills
 * should stay visible, caches the decision per
 * (sessionId, messageHash, workspacePath, presetId), and rewrites the
 * skill-catalog entries so only allowed skills reach the model. When the
 * classifier fails, a configurable fallback policy applies (default: fail-close
 * -> an empty catalog) so isolation is never broken by an unavailable model.
 *
 * @module @deepseek-ai/dsh-skill-router
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { SkillRouterConfig, FallbackMode, SkillCatalogEntry } from './types.ts'
import { classify } from './classifier.ts'
import { interceptCatalog } from './injector.ts'
import { TTLMap, cacheKeyString } from './cache.ts'

export const name = 'skill-router'
export const inject = ['agents']

const DEFAULT_ENDPOINT = 'http://10.10.10.2:9888/v1/chat/completions'
const DEFAULT_MODEL = 'agnes-2.5-flash'
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_CACHE_MAX = 100

/** Plugin configuration, validated by the schemastery schema. */
export interface Config {
  /** Auxiliary classifier Chat Completions endpoint. */
  classifierEndpoint?: string
  /** Auxiliary classifier model id. */
  classifierModel?: string
  /** Fallback policy when classification fails: 'close' | 'open' | 'minimal'. */
  fallback?: FallbackMode
  /** Classifier request timeout, milliseconds. */
  timeoutMs?: number
  /** Cache TTL, milliseconds. */
  cacheTtlMs?: number
  /** LRU cache cap. */
  cacheMax?: number
  /** Agent/preset id used in the classification cache key (optional). */
  presetId?: string
}

export const Config: z<Config> = z.object({
  classifierEndpoint: z.string().default(DEFAULT_ENDPOINT),
  classifierModel: z.string().default(DEFAULT_MODEL),
  fallback: z.union(['close', 'open', 'minimal'] as const).default('close'),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  cacheTtlMs: z.number().default(DEFAULT_CACHE_TTL_MS),
  cacheMax: z.number().default(DEFAULT_CACHE_MAX),
  presetId: z.string().default('default'),
})

/** Read resolved plugin config from the validated defaults. */
export function resolveConfig(raw: Config): SkillRouterConfig {
  return {
    classifierEndpoint: raw.classifierEndpoint ?? DEFAULT_ENDPOINT,
    classifierModel: raw.classifierModel ?? DEFAULT_MODEL,
    fallback: raw.fallback ?? 'close',
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: raw.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    cacheMax: raw.cacheMax ?? DEFAULT_CACHE_MAX,
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const presetId = config.presetId ?? 'default'
  const cache = new TTLMap<string, readonly string[]>(resolved.cacheMax, resolved.cacheTtlMs)

  ctx.on('agent/pre-step', async (
    { agent, messages, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision

    // The catalog message comes from the inner (tool-skill) listener; without
    // one there is nothing to filter, so pass through unchanged.
    const catalog = findCatalogEntries(decision.messages)
    if (catalog === undefined) return decision

    const userText = lastUserText(messages)
    const messageHash = hashText(userText)
    const key = cacheKeyString({
      sessionId: String(agent.id),
      messageHash,
      workspacePath: workspacePath(agent),
      presetId,
    })

    let included: readonly string[]
    const cached = cache.get(key)
    if (cached !== undefined) {
      included = cached
    } else {
      const userMessage = userText.length > 0 ? userText.slice(0, 2000) : '(no message text)'
      const result = await classify(resolved, userMessage, catalog, {
        workspacePath: workspacePath(agent),
        presetId,
      }, signal)
      included = result.included
      cache.set(key, included)
    }

    const filtered = interceptCatalog(decision.messages, included)
    return {
      kind: 'enter',
      messages: filtered,
    }
  })
}

/** The step's messages' catalog entries, or undefined when none is usable. */
function findCatalogEntries(messages: readonly UserMessage[]): SkillCatalogEntry[] | undefined {
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== 'skill-catalog') continue
    const source = message.source as { entries?: unknown }
    if (!Array.isArray(source.entries)) continue
    const entries: SkillCatalogEntry[] = []
    let valid = true
    for (const entry of source.entries as readonly unknown[]) {
      if (typeof entry !== 'object' || entry === null) { valid = false; break }
      const { name, description } = entry as { name?: unknown; description?: unknown }
      if (typeof name !== 'string' || name === '' || typeof description !== 'string') { valid = false; break }
      entries.push({ name, description })
    }
    if (valid) return entries
  }
  return undefined
}

/** Concatenated text of the last claimed user message (used for the cache key). */
function lastUserText(messages: readonly UserMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message === undefined) continue
    if ((message.source as { kind?: unknown }).kind !== 'user') continue
    return message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  return ''
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function workspacePath(agent: Agent): string {
  return agent.session.header.cwd ?? '(none)'
}
