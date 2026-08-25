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

/**
 * Read-only whitelist applied when the auxiliary classifier is unavailable.
 *
 * Production incident 2026-08-22: with the 9888 classifier unreachable, the
 * diagnostic tools (DIAGNOSTIC_TOOLS) kept their zero-gate, but pure status
 * reads like `job_output` / `list_agents` fell into the generic close
 * fallback — the main agent lost ALL task visibility and was locked out of
 * its own work. These tools are pure reads, so classifier failure must fail
 * open for them unconditionally (write/execute tools keep failing close).
 */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  // job/terminal status reads (never write, never execute)
  'job_output',
  'terminal_read',
  // agent roster read (subagent management visibility)
  'list_agents',
  // read-only schedule query
  'calendar_list',
])

/** Whether a tool name is on the classifier-failure read-only whitelist. */
export function isReadonlyTool(toolName: string): boolean {
  return READONLY_TOOLS.has(toolName)
}

/** Whether a tool name is in the diagnostic/read-only set. */
export function isDiagnosticTool(toolName: string): boolean {
  return DIAGNOSTIC_TOOLS.has(toolName)
}

/**
 * Deterministic `rm` invocation detector for shell command text.
 *
 * Machine-gated rule (用户指令 2026-08-25): the main agent is FORBIDDEN from
 * executing `rm` commands. A symlink `rm -rf <link>/` trailing-slash incident
 * followed the link and wiped a node_modules tree, so even a plain `rm` stays
 * hard-blocked. Matches a standalone `rm` word at any command boundary (start,
 * after `; && || | (` newline, or whitespace) with optional `sudo` / `command`
 * / `env [flags]` prefixes and bare env assignments. The word must END at
 * whitespace/end-of-text, so flags like docker's `--rm` and names like
 * `rmdir` / `rm-folder` never match. `git rm` / `docker rm` subcommands are
 * deliberately covered — they are also destructive deletion commands.
 */
export function isRmCommand(command: string): boolean {
  return RM_COMMAND_RE.test(command)
}

const RM_COMMAND_RE =
  /(^|[\s;&|(])(?:(?:sudo|command|env(?:\s+-[A-Za-z0-9_]+)?)\s+)*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*\\?rm(?=\s|$)/m

/**
 * Shell tools eligible for the readonly fail-open branch. Subset of
 * CODE_CLASS_TOOLS; pwsh and tool-cordis are intentionally absent.
 */
const READONLY_SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'terminal'])

/**
 * Deterministic readonly-shell judgment for the classifier-down fail-open
 * branch (P2 主 agent 工具面收敛 Task 2, 评审 H1/H2/M2/M3/L1/L2/L3).
 *
 * Sub-command/flag-level, never first-word only: `git push` must NOT be
 * mistaken for readonly just because the first word is `git`, and `curl -X
 * POST` must NOT pass because `curl` is a network probe. Anything ambiguous,
 * composed, or unknown fails closed (returns false), so the only commands
 * opened here are deterministically read-only diagnostics.
 */
export function isReadonlyShellCommand(command: string): boolean {
  if (command.trim() === '') return false
  // Shell metacharacters compose pipelines, command substitution, separators,
  // or redirection; they defeat sub-command-level judgment (评审 M3), so the
  // whole command is treated as NOT readonly. Note `>>` is covered by `>`, and
  // `<(` (process substitution) is matched literally while a plain `< file`
  // input redirect stays untouched (input redirect is itself read-only).
  if (/[|;`]|&&|\|\||\$\(|>>|>|<\(/.test(command)) return false

  // Strip leading sudo / command / env [flags] prefixes (first word only).
  let rest = command.trim()
  for (;;) {
    const stripped = rest.replace(/^(?:sudo|command|env(?:\s+-[A-Za-z0-9_]+)?)\s+/, '')
    if (stripped === rest) break
    rest = stripped
  }
  const words = rest.split(/\s+/).filter(word => word !== '')
  const first = words[0]
  if (first === undefined) return false

  if (first === 'git') {
    // git <sub>: only the read-only subcommands qualify (评审 H1).
    const sub = words[1]
    return sub !== undefined && READONLY_GIT_SUBCOMMANDS.has(sub)
  }
  if (first === 'curl') {
    // Write/data/upload/download flags disqualify the whole call (评审 H1/M2).
    if (/--data|--form|--upload-file|--output|--create-dirs|(?:^|\s)-[dFToO](?=\s|$)/.test(rest)) return false
    // -X/--request with a method other than GET/HEAD also disqualifies.
    const method = /(?:-X|--request)\s*([A-Za-z]+)/.exec(rest)
    if (method?.[1] !== undefined && !['GET', 'HEAD'].includes(method[1].toUpperCase())) return false
    return true
  }
  if (first === 'wget') {
    if (/--post-data|--post-file|--method/.test(rest)) return false
    // Only --spider, or explicit stdout //dev/null output, stay readonly; the
    // default wget download writes a file (评审 M2).
    if (/\s--spider\b/.test(rest)) return true
    const output = /(?:^|\s)-O\s+(\S+)/.exec(rest)
    if (output?.[1] !== undefined && (output[1] === '-' || output[1] === '/dev/null')) return true
    return false
  }
  return READONLY_SINGLE_COMMANDS.has(first)
}

/** git subcommands that only read repository state. */
const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'cat-file', 'blame',
  'branch', 'tag', 'remote', 'fetch', 'ls-files', 'ls-tree',
])

/** Deterministic single commands with read-only output. */
const READONLY_SINGLE_COMMANDS: ReadonlySet<string> = new Set([
  'ls', 'find', 'stat', 'file', 'wc', 'head', 'tail', 'cat', 'ps', 'top',
  'df', 'free', 'uname', 'which', 'type', 'echo', 'env', 'printenv',
])

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
  /** Shell command text for code-class shell tools (null for non-shell tools). */
  readonly shellCommand?: string | null
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

  // Classifier unavailable/unreadable -> fail-close by tool class. The
  // read-only whitelist fails OPEN unconditionally so the main agent keeps
  // task/status visibility even while the classifier is down (2026-08-22
  // incident); this check runs BEFORE diagnosticFallback so a `close`
  // diagnostic config can never re-lock the read-only status tools.
  if (isReadonlyTool(toolName)) {
    return {
      verdict: 'allow',
      reason: 'classifier unavailable; read-only whitelist fail-open',
      delegateTo: null,
      reviewPrompt: null,
      classifierFailed: true,
      toolName,
    }
  }
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
  // Readonly shell fail-open (评审 H1/H2/L1): when the classifier is down, a
  // deterministically-readonly shell command (git status / ls / curl -I ...)
  // keeps the main agent's simple diagnostics alive instead of closing the
  // entire code-class family. The check is sub-command/flag-level only; rm was
  // already hard-blocked upstream and anything ambiguous still fails close.
  // Restricted to the explicit bash/terminal pair: pwsh is excluded (different
  // shell grammar, interactive by default) and tool-cordis is excluded (it
  // never carries a shell command; its read-only inspect tools already ride
  // the READONLY/DIAGNOSTIC paths) — documented boundaries.
  if (
    READONLY_SHELL_TOOLS.has(toolName)
    && typeof input.shellCommand === 'string'
    && input.shellCommand.trim() !== ''
    && isReadonlyShellCommand(input.shellCommand)
  ) {
    return {
      verdict: 'allow',
      reason: 'classifier unavailable; readonly shell command fail-open',
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
