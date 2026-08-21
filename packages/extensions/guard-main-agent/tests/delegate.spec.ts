import { describe, expect, it, vi } from 'vitest'
import { CallId } from '@deepseek-ai/dsh-llm'
import {
  buildDelegatePrompt,
  buildDenialNotice,
  delegate,
  type DelegateDeps,
} from '../src/delegate.ts'
import type { PolicyVerdict } from '../src/types.ts'

const signal = new AbortController().signal

type ExecuteFn = (input: unknown) => Promise<unknown>

function stubTools(execute: ExecuteFn): NonNullable<DelegateDeps['tools']> {
  return { execute }
}

const verifier = (overrides: Partial<PolicyVerdict> = {}): PolicyVerdict => ({
  verdict: 'block',
  reason: 'main agent must not implement code itself',
  delegateTo: 'code-agent',
  reviewPrompt: null,
  classifierFailed: false,
  toolName: 'bash',
  ...overrides,
})

const deps = (tools: DelegateDeps['tools']): DelegateDeps => ({
  agent: { id: CallId('agent-1') } as never,
  tools,
  signal,
})

interface StubCall {
  name: string
  arguments: { description: string; prompt: string }
  agent: unknown
  signal: AbortSignal
}

/** Extract the sole execute() input from a stubbed tools registry. */
function callOf(execute: ReturnType<typeof vi.fn>): StubCall {
  const first = execute.mock.calls[0]?.[0] as unknown
  return first as StubCall
}

/** Extract summary text from a successful delegate outcome. */
function summaryOf(outcome: { dispatched: true; ok: true }): string {
  return (outcome as unknown as { summary: string }).summary
}

describe('delegate target mapping', () => {
  it('maps code-agent to the call_code_agent tool', async () => {
    const execute = vi.fn(async () => ({
      isError: false,
      content: [{ type: 'text', text: 'done' }],
    }))
    const outcome = await delegate(deps(stubTools(execute)), verifier(), 'let me write the module')
    expect(outcome).toMatchObject({ dispatched: true, ok: true })
    const call = callOf(execute)
    expect(call.name).toBe('call_code_agent')
    expect(call.arguments.prompt).toContain('let me write the module')
    expect(call.agent).toBeDefined()
    expect(call.signal).toBe(signal)
  })

  it('maps check-agent to the call_check_agent tool', async () => {
    const execute = vi.fn(async () => ({
      isError: false,
      content: [{ type: 'text', text: 'report' }],
    }))
    const outcome = await delegate(
      deps(stubTools(execute)),
      verifier({ delegateTo: 'check-agent' }),
      'verify this',
    )
    expect(outcome).toMatchObject({ dispatched: true, ok: true })
    expect(callOf(execute).name).toBe('call_check_agent')
  })

  it('does nothing for a null delegation target', async () => {
    const execute = vi.fn()
    const outcome = await delegate(deps(stubTools(execute)), verifier({ delegateTo: null }), 'x')
    expect(outcome).toMatchObject({ dispatched: false })
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('delegate outcome handling', () => {
  it('extracts the subagent text result into the summary', async () => {
    const execute = vi.fn(async () => ({
      isError: false,
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    }))
    const outcome = await delegate(deps(stubTools(execute)), verifier(), 'task')
    expect(outcome).toMatchObject({ dispatched: true, ok: true })
    const summary = summaryOf(outcome as { dispatched: true; ok: true })
    expect(summary).toContain('line one')
    expect(summary).toContain('line two')
  })

  it('reports an error result from the subagent tool without throwing', async () => {
    const execute = vi.fn(async () => ({
      isError: true,
      error: { name: 'X', message: 'boom' },
      content: [],
    }))
    const outcome = await delegate(deps(stubTools(execute)), verifier(), 'task')
    expect(outcome).toMatchObject({ dispatched: true, ok: false })
  })

  it('contains a thrown dispatch failure', async () => {
    const execute = vi.fn(async () => { throw new Error('call_code_agent unavailable') })
    const outcome = await delegate(deps(stubTools(execute)), verifier(), 'task')
    expect(outcome).toMatchObject({ dispatched: true, ok: false })
    if (!outcome.ok) expect(outcome.error).toContain('unavailable')
  })

  it('handles a missing tools service', async () => {
    const outcome = await delegate({ ...deps(stubTools(vi.fn())), tools: undefined }, verifier(), 'task')
    expect(outcome).toMatchObject({ dispatched: false, ok: false })
  })
})

describe('buildDelegatePrompt', () => {
  it('carries the tool, the reason and the user intent', () => {
    const prompt = buildDelegatePrompt('bash', '{"command":"ls"}', 'blocked reason', 'user intent text')
    expect(prompt).toContain('bash')
    expect(prompt).toContain('{"command":"ls"}')
    expect(prompt).toContain('blocked reason')
    expect(prompt).toContain('user intent text')
  })
})

describe('buildDenialNotice', () => {
  it('explains the block, delegation and review prompt for the main agent', () => {
    const notice = buildDenialNotice(
      verifier({ delegateTo: 'check-agent', reviewPrompt: '请评审此方案' }),
      '用户要求',
    )
    expect(notice.text).toContain('已拦截越界的工具调用')
    expect(notice.text).toContain('check-agent')
    expect(notice.text).toContain('请评审此方案')
    expect(notice.text).toContain('call_plan_reviewer')
    expect(notice.text).toContain('用户要求')
    // One-line summary is bounded.
    expect(notice.summary.length).toBeLessThanOrEqual(200)
  })

  it('omits delegation and review lines when absent', () => {
    const notice = buildDenialNotice(verifier({ delegateTo: null, reviewPrompt: null }), 'u')
    expect(notice.text).not.toContain('已自动派发')
    expect(notice.text).not.toContain('call_plan_reviewer')
  })
})
