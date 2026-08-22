import { describe, expect, it } from 'vitest'
import {
  CODE_CLASS_TOOLS,
  DELEGATION_TOOLS,
  DIAGNOSTIC_TOOLS,
  READONLY_TOOLS,
  WRITE_TOOLS,
  isDiagnosticTool,
  isReadonlyTool,
  parseClassifierOutput,
  resolveVerdict,
} from '../src/policy.ts'
import type { FallbackMode, ResolvedGuardConfig } from '../src/types.ts'

const config = (options: { fallback?: FallbackMode; diagnosticFallback?: FallbackMode } = {}): ResolvedGuardConfig => ({
  classifierEndpoint: 'http://classifier:9888/v1/chat/completions',
  classifierModel: 'agnes/agnes-2.5-flash',
  fallback: options.fallback ?? 'close',
  diagnosticFallback: options.diagnosticFallback ?? 'open',
  timeoutMs: 5000,
  retryCount: 1,
  cacheTtlMs: 600000,
  cacheMax: 50,
  presetId: 'main-agent',
  filePolicyPath: null,
  boundaryDocPath: null,
})

describe('guard tool classification sets', () => {
  it('WRITE_TOOLS covers the machine-gated file-writing tools', () => {
    expect(WRITE_TOOLS.has('write')).toBe(true)
    expect(WRITE_TOOLS.has('edit')).toBe(true)
    expect(WRITE_TOOLS.has('str_replace')).toBe(true)
    expect(WRITE_TOOLS.has('browser_upload_file')).toBe(true)
  })

  it('DIAGNOSTIC_TOOLS covers read-only inspection tools', () => {
    expect(DIAGNOSTIC_TOOLS.has('read')).toBe(true)
    expect(DIAGNOSTIC_TOOLS.has('grep')).toBe(true)
    expect(DIAGNOSTIC_TOOLS.has('lsp')).toBe(true)
    expect(isDiagnosticTool('read')).toBe(true)
    expect(isDiagnosticTool('bash')).toBe(false)
  })

  it('DELEGATION_TOOLS covers the sanctioned subagent dispatch channel', () => {
    expect(DELEGATION_TOOLS.has('call_code_agent')).toBe(true)
    expect(DELEGATION_TOOLS.has('call_check_agent')).toBe(true)
    expect(DELEGATION_TOOLS.has('call_plan_reviewer')).toBe(true)
    expect(DELEGATION_TOOLS.has('subagent')).toBe(true)
    expect(DELEGATION_TOOLS.has('subagent_fork')).toBe(true)
  })

  it('CODE_CLASS_TOOLS covers code-executing tools that must fail close', () => {
    expect(CODE_CLASS_TOOLS.has('bash')).toBe(true)
    expect(CODE_CLASS_TOOLS.has('terminal')).toBe(true)
  })

  it('READONLY_TOOLS covers read-only/status tools that must fail open when the classifier is down', () => {
    // Production incident 2026-08-22: with the 9888 classifier unreachable,
    // job_output/list_agents fell into the generic close fallback and the main
    // agent lost all status visibility. These tools are pure reads.
    expect(READONLY_TOOLS.has('job_output')).toBe(true)
    expect(READONLY_TOOLS.has('list_agents')).toBe(true)
    expect(READONLY_TOOLS.has('terminal_read')).toBe(true)
    expect(READONLY_TOOLS.has('calendar_list')).toBe(true)
    // Write/execute tools must NEVER be on the read-only whitelist.
    expect(READONLY_TOOLS.has('bash')).toBe(false)
    expect(READONLY_TOOLS.has('write')).toBe(false)
    expect(READONLY_TOOLS.has('edit')).toBe(false)
    // Diagnostics already have their own zero-gate / diagnosticFallback path.
    expect(READONLY_TOOLS.has('read')).toBe(false)
    // Predicate mirrors the set (true membership / false non-membership).
    expect(isReadonlyTool('job_output')).toBe(true)
    expect(isReadonlyTool('bash')).toBe(false)
  })
})

describe('parseClassifierOutput', () => {
  it('parses the object form with all fields', () => {
    const out = parseClassifierOutput(JSON.stringify({
      verdict: 'block',
      reason: 'main agent must not implement code itself',
      delegateTo: 'code-agent',
      reviewPrompt: null,
    }))
    expect(out).toEqual({
      verdict: 'block',
      reason: 'main agent must not implement code itself',
      delegateTo: 'code-agent',
      reviewPrompt: null,
    })
  })

  it('accepts missing optional fields', () => {
    const out = parseClassifierOutput(JSON.stringify({ verdict: 'allow' }))
    expect(out).toEqual({ verdict: 'allow' })
  })

  it('accepts bare text tokens allow/block (pure-text tolerance)', () => {
    expect(parseClassifierOutput('block')?.verdict).toBe('block')
    expect(parseClassifierOutput('ALLOW')?.verdict).toBe('allow')
    expect(parseClassifierOutput('  allow  ')?.verdict).toBe('allow')
  })

  it('returns null for an array form (not a valid verdict payload)', () => {
    expect(parseClassifierOutput('["a","b"]')).toBeNull()
    expect(parseClassifierOutput('[1,2,3]')).toBeNull()
  })

  it('returns null for unreadable or empty output', () => {
    expect(parseClassifierOutput('')).toBeNull()
    expect(parseClassifierOutput('garbage')).toBeNull()
    expect(parseClassifierOutput(null)).toBeNull()
  })

  it('returns null for an unknown verdict value', () => {
    expect(parseClassifierOutput(JSON.stringify({ verdict: 'maybe' }))).toBeNull()
  })

  it('rejects a nested markdown code fence with the JSON inside', () => {
    const out = parseClassifierOutput('```json\n{"verdict":"block","reason":"r"}\n```')
    expect(out).toEqual({ verdict: 'block', reason: 'r' })
  })
})

describe('resolveVerdict — classifier output path', () => {
  it('maps a block output to a block verdict with delegation', () => {
    const verdict = resolveVerdict({
      toolName: 'bash',
      output: { verdict: 'block', reason: 'code work belongs to code-agent', delegateTo: 'code-agent' },
      config: config(),
    })
    expect(verdict).toMatchObject({
      verdict: 'block',
      reason: 'code work belongs to code-agent',
      delegateTo: 'code-agent',
      reviewPrompt: null,
      classifierFailed: false,
      toolName: 'bash',
    })
  })

  it('preserves reviewPrompt on a block verdict (plan-review category)', () => {
    const verdict = resolveVerdict({
      toolName: 'bash',
      output: { verdict: 'block', delegateTo: null, reviewPrompt: 'review this plan' },
      config: config(),
    })
    expect(verdict.verdict).toBe('block')
    expect(verdict.reviewPrompt).toBe('review this plan')
    expect(verdict.delegateTo).toBeNull()
  })

  it('coerces delegateTo to null on an allow verdict', () => {
    const verdict = resolveVerdict({
      toolName: 'bash',
      output: { verdict: 'allow', delegateTo: 'code-agent' },
      config: config(),
    })
    expect(verdict.verdict).toBe('allow')
    expect(verdict.delegateTo).toBeNull()
  })

  it('defaults reason when the classifier omitted it', () => {
    const verdict = resolveVerdict({
      toolName: 'bash',
      output: { verdict: 'block' },
      config: config(),
    })
    expect(verdict.reason).toBe('classifier verdict: block')
  })
})

describe('resolveVerdict — fallback path (classifier failed)', () => {
  const failed = (toolName: string, cfg?: ResolvedGuardConfig): ReturnType<typeof resolveVerdict> =>
    resolveVerdict({ toolName, output: null, config: cfg ?? config() })

  it('code-class tools fail close regardless of the fallback setting', () => {
    for (const fallback of ['close', 'open'] as const) {
      const verdict = failed('bash', config({ fallback }))
      expect(verdict.verdict).toBe('block')
      expect(verdict.delegateTo).toBe('code-agent')
      expect(verdict.classifierFailed).toBe(true)
    }
  })

  it('diagnostic tools follow diagnosticFallback=open (allow)', () => {
    const verdict = failed('read')
    expect(verdict.verdict).toBe('allow')
    expect(verdict.reason).toContain('diagnosticFallback=open')
  })

  it('diagnostic tools follow diagnosticFallback=close (block)', () => {
    const verdict = failed('read', config({ diagnosticFallback: 'close' }))
    expect(verdict.verdict).toBe('block')
    expect(verdict.delegateTo).toBeNull()
  })

  it('other tools follow the close fallback with no delegation', () => {
    const verdict = failed('mkdir')
    expect(verdict.verdict).toBe('block')
    expect(verdict.delegateTo).toBeNull()
    expect(verdict.reason).toContain('fail-close')
  })

  it('other tools follow the open fallback', () => {
    const verdict = failed('mkdir', config({ fallback: 'open' }))
    expect(verdict.verdict).toBe('allow')
    expect(verdict.delegateTo).toBeNull()
  })

  it('always attaches toolName and classifierFailed for traceability', () => {
    const verdict = failed('bash')
    expect(verdict.toolName).toBe('bash')
    expect(verdict.classifierFailed).toBe(true)

    const ok = resolveVerdict({
      toolName: 'bash',
      output: { verdict: 'allow' },
      config: config(),
    })
    expect(ok.classifierFailed).toBe(false)
    expect(ok.toolName).toBe('bash')
  })

  it('read-only whitelist tools fail open when the classifier is down (incident regression)', () => {
    // job_output: main agent must keep reading job status while 9888 is down.
    const job = failed('job_output')
    expect(job.verdict).toBe('allow')
    expect(job.delegateTo).toBeNull()
    expect(job.classifierFailed).toBe(true)
    expect(job.reason).toContain('fail-open')
    // list_agents: subagent roster must stay readable.
    const roster = failed('list_agents')
    expect(roster.verdict).toBe('allow')
    expect(roster.delegateTo).toBeNull()
    // terminal_read: terminal output inspection stays available.
    const term = failed('terminal_read')
    expect(term.verdict).toBe('allow')
    // calendar_list: read-only schedule query stays available.
    const cal = failed('calendar_list')
    expect(cal.verdict).toBe('allow')
  })

  it('read-only whitelist fail-open is unconditional (ignores fallback and diagnosticFallback=close)', () => {
    for (const cfg of [
      config({ fallback: 'close' }),
      config({ fallback: 'close', diagnosticFallback: 'close' }),
    ]) {
      const verdict = failed('job_output', cfg)
      expect(verdict.verdict).toBe('allow')
      expect(verdict.classifierFailed).toBe(true)
    }
  })

  it('write/execute tools still fail close when the classifier is down', () => {
    for (const toolName of ['bash', 'write', 'edit', 'visit', 'mkdir']) {
      const verdict = failed(toolName)
      expect(verdict.verdict, toolName).toBe('block')
      expect(verdict.classifierFailed).toBe(true)
    }
  })
})
