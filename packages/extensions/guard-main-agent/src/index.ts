/**
 * dsh-guard-main-agent: machine-gate the main orchestration agent's tool calls.
 *
 * The plugin registers a `tools/pre-execute` listener that runs BEFORE any
 * tool executes (plan decision 1):
 * - sanctioned delegation tools pass through untouched (no self-recursion);
 * - diagnostic/read-only tools pass through (简单诊断零闸自主);
 * - file-writing tools are judged by the machine whitelist first
 *   (docs/主agent可改写文件清单.yaml, pure whitelist + fail-close, symlink
 *   realpath defense, temporaryOverrides with expiry);
 * - everything else is classified by a small auxiliary model (9888),
 *   cached per (sessionId, messageHash, workspacePath, presetId) with a TTL
 *   and refreshed when the user message hash changes.
 *
 * A block denies the call, injects an explanatory notice into the
 * conversation (`agent.inject`), and auto-dispatches the existing subagent
 * tools (`call_code_agent` / `call_check_agent`). `call_plan_reviewer` is
 * never auto-dispatched: the classifier's review prompt is handed to the main
 * agent. Classifier failures fail close for code-class tools, follow
 * `diagnosticFallback` for diagnostics, and `fallback` otherwise.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ClassifierOutput, GuardPluginConfig, PolicyVerdict, ResolvedGuardConfig } from './types.ts'
import { classify, summarizeArgs } from './classifier.ts'
import { DELEGATION_TOOLS, DIAGNOSTIC_TOOLS, WRITE_TOOLS, resolveVerdict } from './policy.ts'
import { createFilePolicy, parsePolicy, type FileDecision, type FilePolicy } from './filePolicy.ts'
import { buildDenialNotice, delegate, type DelegateDeps, type DelegateOutcome } from './delegate.ts'
import { TTLMap, cacheKeyString, hashText } from './cache.ts'
import { sessionTexts } from './messages.ts'

export const name = 'guard-main-agent'
export const inject = ['agents', 'tools']

const DEFAULT_ENDPOINT = 'http://10.10.10.2:9888/v1/chat/completions'
const DEFAULT_MODEL = 'agnes/agnes-2.5-flash'
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_CACHE_MAX = 50

/** Plugin configuration, validated by the schemastery schema. */
export interface Config {
  classifierEndpoint?: string
  classifierModel?: string
  fallback?: 'close' | 'open'
  diagnosticFallback?: 'close' | 'open'
  timeoutMs?: number
  cacheTtlMs?: number
  cacheMax?: number
  presetId?: string
  filePolicyPath?: string
  boundaryDocPath?: string
}

export const Config: z<Config> = z.object({
  classifierEndpoint: z.string().default(DEFAULT_ENDPOINT),
  classifierModel: z.string().default(DEFAULT_MODEL),
  fallback: z.union(['close', 'open'] as const).default('close'),
  diagnosticFallback: z.union(['close', 'open'] as const).default('open'),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  cacheTtlMs: z.number().default(DEFAULT_CACHE_TTL_MS),
  cacheMax: z.number().default(DEFAULT_CACHE_MAX),
  presetId: z.string().default('main-agent'),
  // Preserve omission (Schemastery convention): optional string paths.
  filePolicyPath: z.string().default(undefined as unknown as string),
  boundaryDocPath: z.string().default(undefined as unknown as string),
})

/** Read resolved plugin config from the validated defaults. */
export function resolveConfig(raw: GuardPluginConfig): ResolvedGuardConfig {
  return {
    classifierEndpoint: raw.classifierEndpoint ?? DEFAULT_ENDPOINT,
    classifierModel: raw.classifierModel ?? DEFAULT_MODEL,
    fallback: raw.fallback ?? 'close',
    diagnosticFallback: raw.diagnosticFallback ?? 'open',
    timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    cacheTtlMs: raw.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
    cacheMax: raw.cacheMax ?? DEFAULT_CACHE_MAX,
    presetId: raw.presetId ?? 'main-agent',
    filePolicyPath: raw.filePolicyPath ?? null,
    boundaryDocPath: raw.boundaryDocPath ?? null,
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const cache = new TTLMap<string, ClassifierOutput>(resolved.cacheMax, resolved.cacheTtlMs)

  // File policy per workspace, loaded lazily on first write-tool call and
  // RE-READ on every evaluation so manual whitelist edits hot-reload (v2.1 §5.1).
  const policyByCwd = new Map<string, FilePolicy>()

  const policyFor = async (cwd: string): Promise<FilePolicy> => {
    const cached = policyByCwd.get(cwd)
    if (cached !== undefined) return cached
    let policy: FilePolicy
    if (resolved.filePolicyPath === null) {
      // No policy configured: fail closed (deny all) rather than guess.
      ctx.logger.warn('[guard-main-agent] filePolicyPath not configured; all file writes denied (fail-close)')
      policy = denyAllFilePolicy(cwd)
    } else {
      try {
        const yamlPath = path.resolve(cwd, resolved.filePolicyPath)
        const text = await fs.readFile(yamlPath, 'utf8')
        policy = createFilePolicy(parsePolicy(text), { cwd })
        ctx.logger.info(`[guard-main-agent] file policy loaded from ${yamlPath}`)
      } catch (error) {
        ctx.logger.warn(`[guard-main-agent] file policy load failed (${error instanceof Error ? error.message : String(error)}); fail-close`)
        policy = denyAllFilePolicy(cwd)
      }
    }
    policyByCwd.set(cwd, policy)
    return policy
  }

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const started = Date.now()
    const toolName = exec.name
    const agent = exec.agent

    // Sanctioned delegation channel: never classify or block — the guard must
    // not recurse into its own programmatic dispatches.
    if (DELEGATION_TOOLS.has(toolName)) {
      logDecision(ctx, decisionRecord(toolName, 'allow', 'sanctioned delegation tool', null), started, 'delegation-pass')
      return next()
    }
    // Simple diagnostics: the main agent's own role (零闸自主).
    if (DIAGNOSTIC_TOOLS.has(toolName)) {
      logDecision(ctx, decisionRecord(toolName, 'allow', 'diagnostic/read-only tool, zero-gate', null), started, 'diagnostic-pass')
      return next()
    }
    // File-writing tools: machine whitelist first (deterministic, no classifier).
    if (WRITE_TOOLS.has(toolName)) {
      const filePath = extractWritePath(toolName, exec.arguments)
      if (filePath === null || filePath === '') {
        ctx.logger.warn(`[guard-main-agent] write tool ${toolName} without a resolvable path; allowing the tool to fail on its own`)
        return next()
      }
      const policy = await policyFor(workspacePath(agent))
      const decision = await policy.canWrite(filePath)
      const verdict = filePolicyVerdict(toolName, decision)
      logDecision(ctx, decisionRecord(toolName, verdict.verdict, verdict.reason, verdict.delegateTo), started, decision.allowed ? 'file-allow' : 'file-deny')
      if (decision.allowed) return next()
      return blockAndDeny(ctx, exec, verdict)
    }
    return classifyAndDecide(ctx, exec, cache, resolved, next, started)
  })
}

/** Evaluate a non-write, non-diagnostic tool call through the classifier. */
async function classifyAndDecide(
  ctx: Context,
  exec: ToolExecution,
  cache: TTLMap<string, ClassifierOutput>,
  resolved: ResolvedGuardConfig,
  next: () => Promise<PreToolDecision>,
  started: number,
): Promise<PreToolDecision> {
  const toolName = exec.name
  const agent = exec.agent
  const cwd = workspacePath(agent)
  const texts = agent !== undefined ? sessionTexts(agent) : { lastUserText: '', conversationText: '' }
  const messageHash = hashText(texts.lastUserText)
  const key = cacheKeyString({
    sessionId: agent !== undefined ? String(agent.id) : 'unknown',
    messageHash,
    workspacePath: cwd,
    presetId: resolved.presetId,
  })

  // Cache hit -> reuse the classification for this task; a new user message
  // changes the hash and forces reclassification (plan decision 4).
  let output: ClassifierOutput | null = null
  let cacheHit = false
  const cached = cache.get(key)
  if (cached !== undefined) {
    output = cached
    cacheHit = true
  } else {
    const result = await classify(resolved, {
      sessionId: agent !== undefined ? String(agent.id) : 'unknown',
      workspacePath: cwd,
      presetId: resolved.presetId,
      toolName,
      argsSummary: summarizeArgs(exec.arguments),
      conversation: texts.conversationText,
      userMessage: texts.lastUserText.length > 0 ? texts.lastUserText : '(no message text)',
    }, exec.signal)
    if (result.ok) {
      output = result.output
      cache.set(key, output)
    } else {
      ctx.logger.warn(`[guard-main-agent] classifier failed: ${result.error}`)
    }
  }

  const verdict = resolveVerdict({ toolName, output, config: resolved })
  logDecision(ctx, decisionRecord(toolName, verdict.verdict, verdict.reason, verdict.delegateTo), started, cacheHit ? 'classifier-cache-hit' : 'classifier-decision')
  if (verdict.verdict === 'block') return blockAndDeny(ctx, exec, verdict)
  return next()
}

/** Deny the tool call: explain to the conversation and auto-delegate. */
async function blockAndDeny(
  ctx: Context,
  exec: ToolExecution,
  verdict: PolicyVerdict,
): Promise<{ kind: 'deny'; reason: string }> {
  const agent = exec.agent
  const texts = agent !== undefined ? sessionTexts(agent) : { lastUserText: '', conversationText: '' }
  const userMessage = texts.lastUserText.length > 0 ? texts.lastUserText : '(无用户消息)'

  // ① explain through the conversation (public agent.inject API).
  if (agent !== undefined) {
    const notice = buildDenialNotice(verdict, userMessage)
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: notice.text }],
      source: { kind: 'plugin', plugin: name, form: 'notice', summary: notice.summary },
    }))
  }

  // ② auto-dispatch through the EXISTING subagent tools. `agent` is defined
  // here (guarded above); it is captured into the deprecated outbound path.
  if (verdict.delegateTo !== null && agent !== undefined) {
    const deps: DelegateDeps = {
      agent,
      tools: ctx.tools,
      signal: exec.signal,
    }
    const outcome: DelegateOutcome = await delegate(deps, verdict, userMessage, summarizeArgs(exec.arguments))
    if (!outcome.dispatched || !outcome.ok) {
      ctx.logger.warn(`[guard-main-agent] delegation to ${verdict.delegateTo} failed: ${outcome.error ?? 'skipped'}`)
    } else {
      ctx.logger.info(`[guard-main-agent] delegated to ${verdict.delegateTo}; result head: ${outcome.summary.slice(0, 200)}`)
      agent.inject(createUserMessage({
        content: [{ type: 'text', text: `[guard-main-agent] ${verdict.delegateTo} 已代为执行，结果摘要：\n${outcome.summary.slice(0, 2000)}` }],
        source: { kind: 'plugin', plugin: name, form: 'notice', summary: `delegated to ${verdict.delegateTo}` },
      }))
    }
  }

  return { kind: 'deny', reason: `guard-main-agent: ${verdict.reason}` }
}

/** Turn one file-policy decision into a policy verdict (code work -> code-agent). */
function filePolicyVerdict(toolName: string, decision: FileDecision): PolicyVerdict {
  const delegateTo: 'code-agent' | null = decision.allowed ? null : 'code-agent'
  return {
    verdict: decision.allowed ? 'allow' : 'block',
    reason: decision.allowed ? decision.reason : `文件权限拦截: ${decision.reason} (resolvedPath=${decision.resolvedPath})`,
    delegateTo,
    reviewPrompt: null,
    classifierFailed: false,
    toolName,
  }
}

/** Compact verdict shape for the structured decision log. */
function decisionRecord(
  toolName: string,
  verdict: PolicyVerdict['verdict'],
  reason: string,
  delegateTo: PolicyVerdict['delegateTo'],
): Omit<PolicyVerdict, 'reviewPrompt' | 'classifierFailed'> {
  return { toolName, verdict, reason, delegateTo }
}

/** Structured, traceable decision log (acceptance criterion 6). */
function logDecision(
  ctx: Context,
  verdict: { toolName: string; verdict: string; reason: string; delegateTo: string | null },
  started: number,
  source: string,
): void {
  ctx.logger.info(
    `[guard-main-agent] decision source=${source} tool=${verdict.toolName} verdict=${verdict.verdict} ` +
      `reason="${verdict.reason}" delegateTo=${verdict.delegateTo ?? 'null'} ms=${Date.now() - started}`,
  )
}

/** Extract the target path from a write tool call's arguments. */
function extractWritePath(toolName: string, args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const a = args as { file_path?: unknown; path?: unknown; files?: unknown }
  if (typeof a.file_path === 'string' && a.file_path.trim() !== '') return a.file_path
  if (typeof a.path === 'string' && a.path.trim() !== '') return a.path
  if (toolName === 'browser_upload_file' && Array.isArray(a.files)) {
    const first = a.files.find((f): f is string => typeof f === 'string' && f !== '')
    return first ?? null
  }
  return null
}

/** The workspace root for the cache key and policy resolution. */
function workspacePath(agent: Agent | undefined): string {
  return agent?.session.header.cwd ?? '(none)'
}

/** Fail-close fallback policy: whitelist empty, everything denied. */
function denyAllFilePolicy(cwd: string): FilePolicy {
  return createFilePolicy(
    { defaultPolicy: 'deny', symlinkResolve: true, whitelist: [], temporaryOverrides: [] },
    { cwd },
  )
}
