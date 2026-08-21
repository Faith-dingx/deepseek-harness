/**
 * End-to-end integration for the guard-main-agent pre-execute pipeline.
 *
 * Assembles a real cordis Context (SystemPrompt + ToolRuntime + AgentRegistry)
 * with the plugin, a real fixture workspace (dirs + symlink + whitelist YAML
 * generated at runtime), stub delegation tools, and a stubbed classifier.
 * Scenarios follow 计划-guard-main-agent T8 and 计划-主agent可改写文件清单 T6.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools'
import * as guardMainAgent from '../src/index.ts'

const fixtureRoot = fileURLToPath(new URL('.fixtures/', import.meta.url))
const ws = path.join(fixtureRoot, 'ws')
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const symlinkTarget = path.join(repoRoot, 'package.json') // real file outside the whitelist

/** The whitelist YAML generated for the fixture workspace. */
function whitelistYaml(): string {
  return `
defaultPolicy: deny
symlinkResolve: true
whitelist:
  - type: prefix
    value: "${ws}/docs/"
    allowedExtensions: [".md"]
    reason: "项目文档（仅markdown）"
  - type: prefix
    value: "${ws}/.temp/"
    allowedExtensions: [".md", ".txt", ".log", ".json"]
    reason: "临时文件区（仅文本/日志/JSON）"
temporaryOverrides:
  - filePath: "${ws}/AGENTS.md"
    userMessage: "帮我改一下AGENTS.md"
    timestamp: "2026-08-21T10:00:00Z"
    expiresAt: "2099-08-22T10:00:00Z"
    by: "user-direct-request"
  - filePath: "${ws}/EXPIRED.md"
    userMessage: "暂存"
    timestamp: "2026-08-21T10:00:00Z"
    expiresAt: "2020-08-20T10:00:00Z"
    by: "user-direct-request"
`
}

const whitelistPath = path.join(fixtureRoot, 'whitelist.yaml')

beforeAll(async () => {
  await fs.mkdir(path.join(ws, 'docs'), { recursive: true })
  await fs.mkdir(path.join(ws, '.temp'), { recursive: true })
  await fs.writeFile(path.join(ws, 'AGENTS.md'), '# agents\n', 'utf8')
  await fs.writeFile(whitelistPath, whitelistYaml(), 'utf8')
  // Real symlink inside the whitelisted area pointing OUTSIDE the whitelist.
  await fs.symlink(symlinkTarget, path.join(ws, 'hijack.md'))
})

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Fake agent with inject capture and a scriptable session. */
function agentFor(cwd: string, id = 'guard-agent'): { agent: Agent; injected: UserMessage[]; session: Session } {
  const session = Session.create(SessionId(id), [], { version: 0, id: SessionId(id), createdAt: 0, cwd })
  const injected: UserMessage[] = []
  const agent: Agent = {
    id: SessionId(id),
    options: {},
    session,
    inbox: {} as never,
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: (message) => { injected.push(message) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, injected, session }
}

async function setup(
  fetchImpl: () => Promise<Response> | undefined,
  track: { code?: number; check?: number } = {},
  timeoutMs = 2000,
): Promise<Context> {
  vi.stubGlobal('fetch', fetchImpl ?? (async () => new Response('', { status: 200 })))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(guardMainAgent, {
    classifierEndpoint: 'http://classifier:9888/v1/chat/completions',
    classifierModel: 'agnes/agnes-2.5-flash',
    fallback: 'close',
    diagnosticFallback: 'open',
    timeoutMs,
    cacheTtlMs: 600000,
    cacheMax: 50,
    presetId: 'main-agent',
    filePolicyPath: whitelistPath,
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'call_code_agent',
    description: 'stub',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute() {
      track.code = (track.code ?? 0) + 1
      return [{ type: 'text', text: 'delegated-code-ok' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'call_check_agent',
    description: 'stub',
    parameters: {},
    isConcurrencySafe: () => true,
    async execute() {
      track.check = (track.check ?? 0) + 1
      return [{ type: 'text', text: 'delegated-check-ok' }]
    },
  }))
  return ctx
}

/** Dispatch one pre-execute pass and return decision + next-call count. */
async function preExecute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<{ decision: PreToolDecision; nextCalls: number }> {
  const execSignal = signal ?? new AbortController().signal
  const exec = {
    token: Symbol('exec'),
    callId: CallId('integration-call'),
    rootCallId: CallId('integration-call'),
    name,
    arguments: args,
    ...agent !== undefined ? { agent } : {},
    signal: execSignal,
  } as unknown as ToolExecution
  let nextCalls = 0
  const decision = await ctx.waterfall(
    ctx as never,
    'tools/pre-execute',
    exec,
    () => { nextCalls += 1; return Promise.resolve({ kind: 'allow' as const }) },
  )
  return { decision, nextCalls }
}

function blockJson(): () => Promise<Response> {
  return async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ verdict: 'block', reason: 'code work belongs to code-agent', delegateTo: 'code-agent' }) } }],
  }), { status: 200 })
}

describe('guard-main-agent integration (tools/pre-execute)', () => {
  it('场景1: a code-file write is denied and auto-dispatches call_code_agent', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(blockJson(), track)
    const { agent, injected } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'src/main.ts') })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('文件权限拦截')
    expect(nextCalls).toBe(0)
    expect(track.code).toBe(1)
    // The explanation + the delegated result both reached the conversation.
    const texts = injected.map(m => (m.content as { type: 'text'; text: string }[]).map(b => b.text).join(''))
    expect(texts.some(t => t.includes('文件权限拦截'))).toBe(true)
    expect(texts.some(t => t.includes('delegated-code-ok'))).toBe(true)
  })

  it('场景2: simple diagnostics (read) pass through untouched', async () => {
    const ctx = await setup(blockJson())
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'read', { file_path: path.join(ws, 'docs/a.md') })
    expect(decision).toEqual({ kind: 'allow' })
    expect(nextCalls).toBe(1)
  })

  it('场景3: classifier failure -> code-class bash fails close, writes stay whitelisted', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    const bash = await preExecute(ctx, agent, 'bash', { command: 'pwd' })
    expect(bash.decision.kind).toBe('deny')
    expect(track.code).toBe(1)
    // A whitelisted doc write still passes even though the classifier is down
    // (the file gate is deterministic and runs first).
    const write = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'docs/report.md') })
    expect(write.decision.kind).toBe('allow')
    expect(write.nextCalls).toBe(1)
    // Diagnostics keep working with the classifier down.
    const lsp = await preExecute(ctx, agent, 'lsp', {})
    expect(lsp.decision.kind).toBe('allow')
  })

  it('场景4: task-switch (user message hash change) refreshes the classification cache', async () => {
    let fetches = 0
    const ctx = await setup(async () => {
      fetches += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'block', delegateTo: 'code-agent' }) } }] }), { status: 200 })
    })
    const { agent, session } = agentFor(ws)

    await preExecute(ctx, agent, 'bash', { command: 'a' })
    expect(fetches).toBe(1)
    // Same task + same message -> cache hit, no second classifier call.
    await preExecute(ctx, agent, 'bash', { command: 'a' })
    expect(fetches).toBe(1)

    // A new user message changes the messageHash -> cache refresh.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '换个任务：查一下 bug' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await preExecute(ctx, agent, 'bash', { command: 'a' })
    expect(fetches).toBe(2)
  })

  it('delegation tools are never classified (no self-recursion)', async () => {
    let classifierCalls = 0
    const ctx = await setup(async () => {
      classifierCalls += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: 'allow' } }] }), { status: 200 })
    })
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'call_check_agent', { description: 'd', prompt: 'p' })
    expect(decision.kind).toBe('allow')
    expect(nextCalls).toBe(1)
    expect(classifierCalls).toBe(0)
  })
})

describe('guard-main-agent file policy integration (v2.1 whitelist + fail-close)', () => {
  it('场景5: ~/.dsh/settings.yaml (outside whitelist) is denied', async () => {
    const ctx = await setup(blockJson())
    const { agent, injected } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'write', { file_path: '/home/user/.dsh/settings.yaml' })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('文件权限拦截')
    expect(injected.length).toBeGreaterThan(0)
  })

  it('场景6: docs/新文档.md is allowed (whitelist + type ok)', async () => {
    const ctx = await setup(blockJson())
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'docs/新文档.md') })
    expect(decision.kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })

  it('场景7: docs/配置.yaml is denied (type not allowed)', async () => {
    const ctx = await setup(blockJson())
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'docs/配置.yaml') })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('.yaml')
  })

  it('场景8: .temp/test.txt is allowed; 场景9: .temp/test.ts is denied', async () => {
    const ctx = await setup(blockJson())
    const { agent } = agentFor(ws)
    expect((await preExecute(ctx, agent, 'write', { file_path: path.join(ws, '.temp/test.txt') })).decision.kind).toBe('allow')
    expect((await preExecute(ctx, agent, 'write', { file_path: path.join(ws, '.temp/test.ts') })).decision.kind).toBe('deny')
  })

  it('场景10: symlink inside the whitelist escaping to a banned target is denied', async () => {
    const ctx = await setup(blockJson())
    const { agent, injected } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'hijack.md') })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') {
      expect(decision.reason).toContain('文件权限拦截')
      expect(decision.reason).toContain('resolvedPath')
    }
    const texts = injected.map(m => (m.content as { type: 'text'; text: string }[]).map(b => b.text).join(''))
    expect(texts.some(t => t.includes('resolvedPath'))).toBe(true)
  })

  it('场景11: a live temporaryOverride allows a whitelist-excluded file', async () => {
    const ctx = await setup(blockJson())
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'AGENTS.md') })
    expect(decision.kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })

  it('场景12: an expired temporaryOverride is denied', async () => {
    const ctx = await setup(blockJson())
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'write', { file_path: path.join(ws, 'EXPIRED.md') })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('过期')
  })

  it('no agent (plugin-level exec) still enforces the file policy', async () => {
    const ctx = await setup(blockJson())
    const { decision } = await preExecute(ctx, undefined, 'write', { file_path: path.join(ws, '.temp/test.ts') })
    expect(decision.kind).toBe('deny')
  })
})

describe('classifier timeout jitter regression (计划-guard误拦修复 T5)', () => {
  /** Fetch stub that never settles on its own but rejects when its signal aborts. */
  function abortAwareNever(): (input: string, init: RequestInit) => Promise<Response> {
    return (_input, init) => new Promise<Response>((_, reject) => {
      const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
      if (init.signal?.aborted) abort()
      else init.signal?.addEventListener('abort', abort)
    })
  }

  function allowJson(): () => Promise<Response> {
    return async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdict: 'allow' }) } }],
    }), { status: 200 })
  }

  it('场景E: a >5s jitter (timeout on attempt 1) is retried and allowed instead of mis-blocked', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(abortAwareNever()) // first attempt hangs until the 6s timeout aborts it
      .mockImplementationOnce(allowJson()) // retry returns promptly
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track, 6000)
    const { agent } = agentFor(ws)
    vi.useFakeTimers()
    try {
      const pending = preExecute(ctx, agent, 'bash', { command: 'pwd' })
      // Advance past the per-attempt timeout: attempt 1 aborts, retry succeeds.
      vi.advanceTimersByTime(6000)
      const { decision } = await pending
      expect(decision.kind).toBe('allow')
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(track.code).toBeUndefined() // allowed -> no delegation
    } finally {
      vi.useRealTimers()
    }
  })

  it('场景F: a real failure (network error) still fails close, no delegation of intent', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'pwd' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1) // fatal -> no retry
    expect(track.code).toBe(1) // fail-close delegates to code-agent
  })

  it('场景G: HTTP 500 fails close without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'pwd' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(track.code).toBe(1)
  })

  it('场景G+: HTTP 429 fails close without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('too many requests', { status: 429 }))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'pwd' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(track.code).toBe(1)
  })

  it('场景G+: HTTP 400 fails close without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'pwd' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(track.code).toBe(1)
  })

  it('场景H: a caller abort is a hard stop -> fetch never called, bash fails close', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'pwd' }, controller.signal)
    expect(fetchMock).toHaveBeenCalledTimes(0) // abort detected at the classify() entry
    expect(decision.kind).toBe('deny') // caller abort is fatal -> fail-close
    // The caller cancelled the turn, so the delegation channel is cancelled too
    // (tools.execute refuses an already-aborted signal): no subagent dispatch.
    expect(track.code).toBeUndefined()
  })
})
