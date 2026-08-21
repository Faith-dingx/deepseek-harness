/**
 * Subagent delegation after a block.
 *
 * When the guard blocks a tool call it can auto-dispatch the work through the
 * EXISTING subagent tools (`call_code_agent` / `call_check_agent`) via the
 * tools registry's programmatic dispatch (`ctx.tools.execute`, verified API).
 * The plan forbids unverified `agent.steer`/`agent.inject` for delegation; the
 * explanation reaches the conversation through `agent.inject` (public API),
 * and the subagent result text is included there so the main agent can
 * continue from the outcome. `call_plan_reviewer` is NEVER auto-dispatched —
 * the classifier's review prompt is handed to the main agent instead.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import { CallId, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { PolicyVerdict } from './types.ts'

/** The tool name each delegation target maps to (existing verified subagents). */
const TARGET_TOOL: Record<string, string> = {
  'code-agent': 'call_code_agent',
  'check-agent': 'call_check_agent',
}

/** Runtime dependencies for one delegation (test-friendly seam). Type allows
 * undefined so a missing tools service degrades cleanly instead of throwing. */
export interface DelegateDeps {
  /** The calling agent; becomes the delegation's parent and identity carrier. */
  readonly agent: Agent
  /** The tools registry; dispatch happens through `tools.execute`. */
  readonly tools: { execute(input: unknown): Promise<unknown> } | undefined
  /** Caller-owned cancellation signal. */
  readonly signal: AbortSignal
}

/** Result of one delegation attempt. */
export type DelegateOutcome =
  | { readonly dispatched: true; readonly ok: true; readonly summary: string }
  | { readonly dispatched: true; readonly ok: false; readonly error: string }
  | { readonly dispatched: false; readonly ok: false; readonly error?: string }

/**
 * Build the standalone prompt for the delegated subagent: what the main agent
 * was doing, why the guard blocked it, and the user's original intent.
 */
export function buildDelegatePrompt(toolName: string, argsSummary: string, reason: string, userMessage: string): string {
  return [
    'The main agent attempted a task that its role boundary forbids; the guard ' +
      'blocked the call and delegated the work to you (a focused subagent with the ' +
      'proper toolset). Complete the task instead.',
    '',
    `Original tool call: ${toolName}`,
    `Arguments summary: ${argsSummary}`,
    `Blocked because: ${reason}`,
    `User intent: ${userMessage}`,
  ].join('\n')
}

/**
 * Dispatch the delegated subagent tool and return its outcome. Never throws:
 * a broken delegation channel degrades to a contained failure so the caller
 * can still block safely (plan risk table: dispatch failure -> warn + proceed
 * with the denial).
 * @param argsSummary - the original tool arguments summary (for the child prompt).
 */
export async function delegate(
  deps: DelegateDeps,
  verdict: PolicyVerdict,
  userMessage: string,
  argsSummary = '<arguments omitted>',
): Promise<DelegateOutcome> {
  const target = verdict.delegateTo
  if (target === null) return { dispatched: false, ok: false }
  const tool = TARGET_TOOL[target]
  if (tool === undefined) return { dispatched: false, ok: false, error: `unknown delegation target: ${target}` }
  if (deps.tools === undefined) {
    return { dispatched: false, ok: false, error: 'tools service unavailable; delegation skipped' }
  }

  try {
    const result = await deps.tools.execute({
      callId: CallId(`guard:${crypto.randomUUID()}`),
      name: tool,
      arguments: {
        description: `guard 自动派发：${target}`,
        prompt: buildDelegatePrompt(verdict.toolName, argsSummary, verdict.reason, userMessage),
      },
      agent: deps.agent,
      signal: deps.signal,
    })
    const outcome = result as { isError?: boolean; content?: unknown; error?: { message?: string } }
    if (outcome.isError === true) {
      return { dispatched: true, ok: false, error: outcome.error?.message ?? 'subagent tool returned an error' }
    }
    const content = Array.isArray(outcome.content) ? outcome.content as ContentBlock[] : []
    const text = content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    return { dispatched: true, ok: true, summary: text.length > 0 ? text : '(subagent completed with no text)' }
  } catch (error) {
    return { dispatched: true, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The one-line account of a guard decision, shown in the injected notice.
 * Bounded by the plugin-notice summary limit.
 */
export function decisionSummary(verdict: PolicyVerdict): string {
  const action = verdict.verdict === 'block' ? 'blocked' : 'allowed'
  const delegation = verdict.delegateTo !== null ? `; delegated to ${verdict.delegateTo}` : ''
  return boundContextSummary(`guard: ${verdict.toolName} ${action} (${verdict.reason})${delegation}`)
}

/** The full injected explanation plus its one-line summary. */
export interface DenialNotice {
  readonly text: string
  readonly summary: string
}

/**
 * Build the notice injected into the conversation after a block: which tool
 * was intercepted, why, what happened next, and the plan-review prompt when
 * the classifier flagged one (the main agent decides whether to call
 * `call_plan_reviewer`).
 */
export function buildDenialNotice(verdict: PolicyVerdict, userMessage: string): DenialNotice {
  const lines = [
    'guard-main-agent：已拦截越界的工具调用。',
    `- 工具: ${verdict.toolName}`,
    `- 原因: ${verdict.reason}`,
    `- 动作: ${verdict.verdict === 'block' ? '已拒绝该调用' : '已放行'}`,
  ]
  if (verdict.delegateTo !== null) {
    lines.push(`- 已自动派发: ${verdict.delegateTo}（现有 subagent 工具代为执行）`)
  }
  if (verdict.reviewPrompt !== null && verdict.reviewPrompt !== '') {
    lines.push(`- 方案评审提示（是否调用 call_plan_reviewer 由主 agent 决定）: ${verdict.reviewPrompt}`)
  }
  lines.push(`- 当前用户任务: ${userMessage}`)
  return { text: lines.join('\n'), summary: decisionSummary(verdict) }
}
