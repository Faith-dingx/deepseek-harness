/**
 * Out-of-bounds decision policy for the main agent.
 *
 * Turns the auxiliary classifier output (or its failure) into one structured
 * {@link PolicyVerdict}. Fail-close is the default posture: when the
 * classifier is unavailable the code-class tools are blocked outright, the
 * diagnostic/read-only tools follow `diagnosticFallback` (default open), and
 * every other tool follows `fallback` (default close). Also hosts the tool
 * classification sets used by the pre-execute listener.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import type { ClassifierOutput, PolicyVerdict, ResolvedGuardConfig } from './types.ts'

/**
 * File-writing tools gated by the machine whitelist (file policy) BEFORE any
 * classifier involvement. `write`/`edit` come from dsh-tool-fs, `str_replace`
 * from tool-str-replace-editor, `browser_upload_file` from the browser plugin.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'str_replace',
  'browser_upload_file',
])

/**
 * Read-only / zero-gate tools the main agent may use autonomously (简单诊断、
 * 收尾记录). These never reach the classifier: inspection and record-keeping
 * are the main agent's own role (主agent职责边界 决策表: 简单诊断零闸自主,
 * 收尾记录零闸).
 */
export const DIAGNOSTIC_TOOLS: ReadonlySet<string> = new Set([
  // filesystem inspection
  'read', 'read_image', 'grep', 'lsp', 'glob',
  // session/event query
  'session_search', 'session_event_search', 'session_event_read', 'session_event_trace', 'session_trace',
  // web search (orchestration support)
  'web_search', 'advanced_search', 'platform_search', 'free_search_test',
  // browser observation
  'browser_snapshot', 'browser_tab_list', 'browser_navigate', 'browser_console_messages',
  // skill catalog read
  'skill',
  // memory read (the sanctioned record interface, not raw fs)
  'memory_search', 'memory_recall', 'memory_read', 'memory_status', 'memory_external',
  // job/terminal observation
  'job_list', 'terminal_list',
  // vision read-only
  'vision_bootstrap', 'vision_describe', 'vision_ocr', 'vision_long_screenshot_ocr',
  'vision_detect', 'vision_ground', 'vision_colors', 'vision_pixel_diff', 'vision_crop',
  'vision_screenshot', 'vision_trace', 'vision_extract_foreground', 'vision_materialize',
  'vision_html_screenshot', 'vision_present',
])

/**
 * Sanctioned delegation channel. These tools are how the main agent (or the
 * guard itself) delegates work; the guard never classifies or blocks them, so
 * programmatic dispatch from the guard cannot recurse into itself.
 */
export const DELEGATION_TOOLS: ReadonlySet<string> = new Set([
  'subagent',
  'subagent_fork',
  'send_message',
  'call_code_agent',
  'call_check_agent',
  'call_plan_reviewer',
  'call_project_planner',
])

/**
 * Code-executing tools: on classifier failure these ALWAYS fail close even
 * when `fallback: open` is configured (主agent职责边界: 主agent不亲自实施代码).
 */
export const CODE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'terminal',
  'tool-cordis',
])

/** Whether a tool name is in the diagnostic/read-only set. */
export function isDiagnosticTool(toolName: string): boolean {
  return DIAGNOSTIC_TOOLS.has(toolName)
}

/**
 * Tolerant parse of the classifier reply into a {@link ClassifierOutput}.
 *
 * Accepted forms:
 * - `{"verdict":"block|allow","reason":"…","delegateTo":"…","reviewPrompt":"…"}`
 * - bare text token `block` / `allow` (case/whitespace tolerant)
 * - JSON inside a ```json fence
 *
 * Returns null when the output cannot be trusted (array form, unknown
 * verdict, garbage, empty) — the caller then applies the fallback policy.
 */
export function parseClassifierOutput(raw: string | null | undefined): ClassifierOutput | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '') return null

  // Bare-text tolerance: a lone block/allow token is accepted.
  const bare = trimmed.toLocaleLowerCase()
  if (bare === 'block' || bare === 'allow') return { verdict: bare }

  const jsonText = stripFence(trimmed)
  let value: unknown
  try {
    value = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null

  const { verdict, reason, delegateTo, reviewPrompt } = value as {
    verdict?: unknown
    reason?: unknown
    delegateTo?: unknown
    reviewPrompt?: unknown
  }
  if (verdict !== 'block' && verdict !== 'allow') return null
  const hasReason = typeof reason === 'string'
  const hasDelegate = delegateTo === 'code-agent' || delegateTo === 'check-agent' || delegateTo === null
  const hasReview = reviewPrompt === null || typeof reviewPrompt === 'string'
  return {
    verdict,
    ...(hasReason ? { reason } : {}),
    ...(hasDelegate ? { delegateTo } : {}),
    ...(hasReview ? { reviewPrompt } : {}),
  }
}

/** Strip a ```json … ``` fenced block, returning its inner text. */
function stripFence(text: string): string {
  const match = /^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text)
  return match?.[1] ?? text
}

/** One tool call evaluation decision. */
export interface VerdictInput {
  readonly toolName: string
  /** Parsed classifier output; null when the classifier failed or was unreadable. */
  readonly output: ClassifierOutput | null
  readonly config: Pick<ResolvedGuardConfig, 'fallback' | 'diagnosticFallback'>
}

/**
 * Resolve the final verdict for one tool call.
 * - classifier output readable -> use it (allow coerces delegation off)
 * - classifier failed -> tool-class based fallback:
 *   code-class always close; diagnostic follows `diagnosticFallback`;
 *   everything else follows `fallback` (default close).
 */
export function resolveVerdict(input: VerdictInput): PolicyVerdict {
  const { toolName, output, config } = input
  if (output !== null && output.verdict !== undefined) {
    const allow = output.verdict === 'allow'
    return {
      verdict: output.verdict,
      reason: output.reason ?? `classifier verdict: ${output.verdict}`,
      // An allow never auto-dispatches.
      delegateTo: allow ? null : (output.delegateTo ?? null),
      reviewPrompt: allow ? null : (output.reviewPrompt ?? null),
      classifierFailed: false,
      toolName,
    }
  }

  // Classifier unavailable/unreadable -> fail-close by tool class.
  if (isDiagnosticTool(toolName)) {
    const mode = config.diagnosticFallback
    return {
      verdict: mode === 'open' ? 'allow' : 'block',
      reason: `classifier unavailable; diagnosticFallback=${mode}`,
      delegateTo: null,
      reviewPrompt: null,
      classifierFailed: true,
      toolName,
    }
  }
  if (CODE_CLASS_TOOLS.has(toolName)) {
    return {
      verdict: 'block',
      reason: 'classifier unavailable; code-class tool fails close',
      delegateTo: 'code-agent',
      reviewPrompt: null,
      classifierFailed: true,
      toolName,
    }
  }
  const mode = config.fallback
  return {
    verdict: mode === 'open' ? 'allow' : 'block',
    reason: mode === 'open'
      ? 'classifier unavailable; fail-open'
      : 'classifier unavailable; fail-close',
    delegateTo: null,
    reviewPrompt: null,
    classifierFailed: true,
    toolName,
  }
}
