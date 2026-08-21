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

import type { ClassifierContext, ClassifierOutput, ResolvedGuardConfig } from './types.ts'
import { buildSystemPrompt, buildUserMessage } from './prompt.ts'
import { parseClassifierOutput } from './policy.ts'

/** A successful parse or a contained failure. */
export type ClassifyResult =
  | { readonly ok: true; readonly output: ClassifierOutput }
  | { readonly ok: false; readonly error: string }

/**
 * High-level classification entry point: call the classifier, parse the reply,
 * and fold any failure into `{ok:false}`. Never throws.
 */
export async function classify(
  config: Pick<ResolvedGuardConfig, 'classifierEndpoint' | 'classifierModel' | 'timeoutMs'>,
  context: ClassifierContext,
  signal?: AbortSignal,
): Promise<ClassifyResult> {
  try {
    const raw = await callClassifier(config, context, signal)
    const output = parseClassifierOutput(raw)
    return output !== null
      ? { ok: true, output }
      : { ok: false, error: 'classifier output unreadable' }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
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
