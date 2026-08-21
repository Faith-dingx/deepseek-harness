/**
 * Auxiliary classifier invocation (HTTP POST to the 9888 router).
 *
 * Classification runs on a small auxiliary model over a plain HTTP Chat
 * Completions call (the preset layer has no unified `ctx.llm` for this, the
 * same constraint skill-router works under). The call is bounded by a
 * configurable timeout with an AbortController and never throws: failures
 * (network, non-2xx, timeout, unreadable output) come back as
 * `{ok: false}` so the caller applies the configured fallback policy —
 * fail-close for the guard's isolation target.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import type { ClassifyErrorType, ClassifierContext, ClassifierOutput, ResolvedGuardConfig } from './types.ts'
import { buildSystemPrompt, buildUserMessage } from './prompt.ts'
import { parseClassifierOutput } from './policy.ts'

/** A successful parse or a contained failure (with its failure class). */
export type ClassifyResult =
  | { readonly ok: true; readonly output: ClassifierOutput }
  | { readonly ok: false; readonly error: string; readonly errorType: ClassifyErrorType }

/**
 * High-level classification entry point: call the classifier, parse the reply,
 * and fold any failure into `{ok:false}`. Never throws.
 *
 * Failure contract (plan 计划-guard误拦修复 v2 决策 2):
 * - transient timeout           -> retried `config.retryCount` times (default 1)
 * - caller abort (hard stop)    -> returned immediately, never retried
 * - HTTP/network/unreadable     -> `fatal`, never retried (fail-close below)
 */
export async function classify(
  config: Pick<ResolvedGuardConfig, 'classifierEndpoint' | 'classifierModel' | 'timeoutMs' | 'retryCount'>,
  context: ClassifierContext,
  signal?: AbortSignal,
): Promise<ClassifyResult> {
  // Caller aborted before we even start: hard stop, no fetch, no retry.
  if (signal?.aborted) return { ok: false, error: 'caller aborted', errorType: 'fatal' }
  const maxAttempts = 1 + config.retryCount
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // The caller may abort between retries; respect it before any new fetch.
    if (signal?.aborted) return { ok: false, error: 'caller aborted', errorType: 'fatal' }
    try {
      const raw = await callClassifier(config, context, signal)
      const output = parseClassifierOutput(raw)
      // Unreadable output is a real model anomaly: fail-close, never retry.
      return output !== null
        ? { ok: true, output }
        : { ok: false, error: 'classifier output unreadable', errorType: 'fatal' }
    } catch (error) {
      // Caller aborted mid-flight: hard stop, never retry against their intent.
      if (signal?.aborted) return { ok: false, error: 'caller aborted', errorType: 'fatal' }
      const timeout = isTimeoutError(error)
      // Only a timeout (transient jitter) is retried; 4xx/5xx/network are fatal.
      if (timeout && attempt < maxAttempts - 1) continue
      return { ok: false, error: errorMessage(error), errorType: timeout ? 'timeout' : 'fatal' }
    }
  }
  // Unreachable in practice (the loop always returns); kept for type exhaustiveness.
  return { ok: false, error: 'classifier failed', errorType: 'fatal' }
}

/**
 * Whether a thrown value represents a timeout worth retrying. The internal
 * AbortController (config.timeoutMs) surfaces as `DOMException` with name
 * `AbortError`; some runtimes instead throw a plain Error whose message
 * mentions the abort/timed-out condition (plan R5).
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'AbortError'
  if (error instanceof Error) {
    const message = error.message.toLocaleLowerCase()
    return message.includes('abort') || message.includes('timed out')
  }
  return false
}

/** The raw HTTP client primitive. Kept separate for isolated unit testing. */
export async function callClassifier(
  config: Pick<ResolvedGuardConfig, 'classifierEndpoint' | 'classifierModel' | 'timeoutMs'>,
  context: ClassifierContext,
  signal?: AbortSignal,
): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, config.timeoutMs)
  const onAbort = (): void => { controller.abort() }
  // An already-aborted caller signal never fires a later listener event, so
  // abort the internal controller immediately and skip the listener wiring.
  if (signal?.aborted) {
    controller.abort()
  } else {
    signal?.addEventListener('abort', onAbort)
  }
  const system = buildSystemPrompt()
  const user = buildUserMessage(context)
  try {
    const response = await fetch(config.classifierEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.classifierModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
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

/** Truncation suffix appended to oversized argument summaries. */
const TRUNCATION_SUFFIX = '…(truncated)'

/**
 * Lossless-JSON stringify of tool arguments, truncated to 500 chars
 * (plan decision 3 risk: oversized tool calls must not flood the classifier).
 */
export function summarizeArgs(args: unknown): string {
  if (args === undefined) return 'undefined'
  // Tool arguments always cross a lossless-JSON boundary, so JSON.stringify is
  // total here; the try/catch stays defensive for non-serializable inputs.
  let text: string
  try {
    text = JSON.stringify(args)
  } catch {
    text = '[unserializable]'
  }
  return text.length > 500
    ? `${text.slice(0, 500 - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
    : text
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
  if (typeof content === 'string' && content.length > 0) return content
  return undefined
}

/** Safe human-readable error text from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}
