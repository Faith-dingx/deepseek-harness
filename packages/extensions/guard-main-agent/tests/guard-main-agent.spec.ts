/**
 * End-to-end integration for the guard-main-agent pre-execute pipeline (0.2.2).
 *
 * Assembles a real cordis Context (SystemPrompt + ToolRuntime + AgentRegistry +
 * SessionProjectionRegistry) with the plugin, a real fixture workspace (dirs +
 * symlink + whitelist YAML generated at runtime), stub delegation tools, a
 * native-style tool executor, and a stubbed classifier. Scenarios follow
 * 计划-guard-main-agent T8 and 计划-主agent可改写文件清单 T6.
 *
 * 0.2.2 changes vs 0.1.5:
 * - `defineContentToolFixture` moved to `@deepseek-ai/dsh-tool-testkit`
 * - `Session.create` header now uses version 4 SessionHeader object
 * - `Agent` interface gained required `model` and `inbox` fields
 * - `tools.execute` requires a registered executor (`ctx.tools.setExecutor`)
 *   — delegate.ts's auto-dispatch routes through `deps.tools.execute(...)`,
 *   so we register a minimal executor that routes to the stub tool definitions.
 * - `MessageSourceMap` no longer has catch-all `kind:'plugin'`; guard uses
 *   its own `kind:'guard-main-agent'` + `form:'notice'` module augmentation
 * - `continuation.ts` was deleted upstream; no test depends on it here.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutor, type ToolBatchInput, type ToolBatchResult, type ToolCallResult, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentRegistry, { type Agent, type Model, type Inbox } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ToolExecution, PreToolDecision, ToolRunContext } from '@deepseek-ai/dsh-tools'
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

/** Minimal stub for the required `model` field on 0.2.2 Agent. */
function stubModel(): Model {
  return {
    current: () => undefined,
    select: () => {},
  } as Model
}

/** Minimal stub for the required `inbox` field on 0.2.2 Agent. */
function stubInbox(): Inbox {
  return {
    nextTurn: [],
    nextStep: [],
    clear: () => {},
    append: () => {},
    prepend: () => {},
    replace: () => false,
    remove: () => false,
    splice: () => [],
  } as Inbox
}

/** Fake agent with inject capture and a scriptable session. */
function agentFor(cwd: string, id = 'guard-agent'): { agent: Agent; injected: UserMessage[]; session: Session } {
  const sessionId = SessionId(id)
  const session = Session.create(sessionId, [], {
    version: 4,
    isSeeded: false,
    id: sessionId,
    createdAt: 0,
    cwd,
  } as SessionHeader)
  const injected: UserMessage[] = []
  const agent: Agent = {
    id: sessionId,
    options: {},
    session,
    model: stubModel(),
    inbox: stubInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: (message: UserMessage) => { injected.push(message) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as Agent
  return { agent, injected, session }
}

/**
 * Minimal tool executor that routes calls to registered tool definitions.
 * delegate.ts calls `deps.tools.execute(...)` with a single-call shape
 * ({callId, name, arguments, agent, signal}), which `ToolsService.execute`
 * hands to the registered executor. The executor accepts both the batch
 * shape ({calls}) and that single-call shape, looks up the tool by name in
 * the ctx.tools registry, and invokes its execute body directly.
 *
 * A caller-aborted signal yields canonical ABORTED_BEFORE_DISPATCH results
 * without running any tool body (mirrors the native executor's pipeline
 * cancellation handling, 场景H).
 */
function createStubExecutor(ctx: Context): ToolExecutor {
  /**
   * One stub tool result: the body's canonical value is its content array;
   * present it as a content-bearing success. Content-tool fixtures
   * (defineContentToolFixture) already yield a JSON content array.
   */
  const unknownResult = (name: string): ToolExecutionResult => ({
    isError: true,
    content: [{ type: 'text' as const, text: `unknown tool: ${name}` }],
    error: { name: 'UNKNOWN_TOOL', message: `unknown tool: ${name}` },
  }) as ToolExecutionResult
  const abortedResult = (): ToolExecutionResult => ({
    isError: true,
    content: [{ type: 'text' as const, text: 'Error: tool call aborted before dispatch' }],
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
    },
  }) as ToolExecutionResult

  return {
    describe: () => ({ schemas: [], knownNames: [] }),
    async execute(input: ToolBatchInput & { callId?: unknown; name?: string; arguments?: unknown }): Promise<ToolBatchResult> {
      // Single-call shape from guard delegation (delegate.ts): honor caller
      // cancellation without dispatching (native-executor semantics, 场景H).
      if (!Array.isArray(input.calls)) {
        const results = input.signal.aborted
          ? [{ callId: input.callId as ToolCallResult['callId'], result: abortedResult() }]
          : []
        if (results.length === 0) {
          const tool = ctx.tools.executable(input.name as string, input.agent)
          const runBody = async (): Promise<unknown> => {
            if (tool === undefined) throw new Error(`unknown tool: ${input.name}`)
            const parsed = typeof input.arguments === 'string' ? JSON.parse(input.arguments) : input.arguments
            const exec = {
              token: Symbol('exec'),
              callId: input.callId,
              rootCallId: input.callId,
              name: input.name,
              arguments: parsed,
              agent: input.agent,
              signal: input.signal,
              deferContext: () => {},
              concludeTurn: () => {},
            } as unknown as ToolRunContext
            const raw = await tool.execute(parsed, exec)
            // The tool body's canonical value IS its content array; wrap it
            // into a settled ToolExecutionResult for the batch contract.
            return {
              isError: false,
              value: raw,
              content: (Array.isArray(raw) ? raw : [raw]) as ToolExecutionResult['content'],
            }
          }
          results.push({
            callId: input.callId as ToolCallResult['callId'],
            result: (await runBody()) as ToolExecutionResult,
          })
        }
        return { results, additionalContexts: [], concluded: false }
      }
      // Batch shape.
      const results: ToolCallResult[] = []
      for (const call of input.calls) {
        if (input.signal.aborted) {
          results.push({ callId: call.id, result: abortedResult() })
          continue
        }
        const tool = ctx.tools.executable(call.name, input.agent)
        if (tool === undefined) {
          results.push({ callId: call.id, result: unknownResult(call.name) })
          continue
        }
        const parsed = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
        const exec = {
          token: Symbol('exec'),
          callId: call.id,
          rootCallId: call.id,
          name: call.name,
          arguments: parsed,
          agent: input.agent,
          signal: input.signal,
          deferContext: () => {},
          concludeTurn: () => {},
        } as unknown as ToolRunContext
        const raw = await tool.execute(parsed, exec)
        results.push({
          callId: call.id,
          result: {
            isError: false,
            value: raw,
            content: (Array.isArray(raw) ? raw : [raw]) as ToolExecutionResult['content'],
          } as ToolExecutionResult,
        })
      }
      return { results, additionalContexts: [], concluded: false }
    },
  }
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
  await ctx.plugin(SessionProjectionRegistry)
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
  // 0.2.2: delegate.ts's tools.execute requires a registered executor.
  // Route to the stub tool definitions above.
  ctx.tools.setExecutor(createStubExecutor(ctx))
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
    callId: ToolCallId('integration-call'),
    rootCallId: ToolCallId('integration-call'),
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

  it('场景3: classifier failure -> readonly shell fail-open, write shell still fails close', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    // 简单只读诊断命令: 分类器挂时 fail-open, 不派发 (P2 Task 2).
    const status = await preExecute(ctx, agent, 'bash', { command: 'git status' })
    expect(status.decision.kind).toBe('allow')
    expect(status.nextCalls).toBe(1)
    // 写 shell 命令: 仍 fail-close + 派发 code-agent.
    const push = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' })
    expect(push.decision.kind).toBe('deny')
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

  it('场景3b: read-only whitelist tools (job_output/list_agents) fail open while bash still fails close', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    // Status reads must survive the classifier outage (2026-08-22 incident).
    const job = await preExecute(ctx, agent, 'job_output', { job_id: 'bash-1' })
    expect(job.decision.kind).toBe('allow')
    expect(job.nextCalls).toBe(1)
    const roster = await preExecute(ctx, agent, 'list_agents', {})
    expect(roster.decision.kind).toBe('allow')
    expect(roster.nextCalls).toBe(1)
    // Execute-class tools still fail close: no silent write/run path.
    const bash = await preExecute(ctx, agent, 'bash', { command: 'rm -rf /tmp/x' })
    expect(bash.decision.kind).toBe('deny')
    expect(bash.nextCalls).toBe(0)
    // Only the blocked bash delegated; read-only calls did not.
    expect(track.code).toBe(1)
  })

  it('场景S1: shell hard-block — bash rm denies deterministically, classifier never consulted', async () => {
    let classifierCalls = 0
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => {
      classifierCalls += 1
      // Even an ALLOW verdict must not rescue an rm call (machine-gated rule).
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'allow', reason: 'classifier says ok' }) } }] }), { status: 200 })
    }, track)
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'bash', { command: 'rm -rf /home/dingx/.temp/node_modules/' })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('rm 命令')
    expect(nextCalls).toBe(0)
    expect(classifierCalls).toBe(0) // bypasses the classifier entirely
    expect(track.code).toBe(1) // auto-dispatched to the proper toolset (code-agent)
  })

  it('场景S2: shell hard-block — terminal_send text containing rm is also blocked', async () => {
    let classifierCalls = 0
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => {
      classifierCalls += 1
      return new Response('', { status: 200 })
    }, track)
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'terminal_send', { sessionId: 's1', text: 'cd /x && rm -rf build' })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('rm 命令')
    expect(nextCalls).toBe(0)
    expect(classifierCalls).toBe(0)
    expect(track.code).toBe(1)
  })

  it('场景S2b: rm confined to the workspace is allowed (2026-10-30 用户授权)', async () => {
    let classifierCalls = 0
    const ctx = await setup(async () => {
      classifierCalls += 1
      return new Response('', { status: 200 })
    })
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'bash', { command: 'rm -rf build/cache' })
    expect(decision.kind).toBe('allow')
    expect(nextCalls).toBe(1)
    expect(classifierCalls).toBe(0) // still bypasses the classifier
  })

  it('场景S3: non-rm shell commands still flow through the classifier path', async () => {
    let classifierCalls = 0
    const ctx = await setup(async () => {
      classifierCalls += 1
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'allow', reason: 'ok' }) } }] }), { status: 200 })
    })
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'bash', { command: 'ls -la' })
    expect(classifierCalls).toBe(1)
    expect(decision.kind).toBe('allow')
    expect(nextCalls).toBe(1)
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

describe('readonly shell fail-open integration (P2 Task 2, classifier down)', () => {
  it('场景R1: bash git status is allowed without delegation when the classifier throws', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'bash', { command: 'git status' })
    expect(decision.kind).toBe('allow')
    expect(nextCalls).toBe(1)
    expect(track.code).toBeUndefined()
  })

  it('场景R2: bash git push origin main is denied and dispatches code-agent', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' })
    expect(decision.kind).toBe('deny')
    expect(nextCalls).toBe(0)
    expect(track.code).toBe(1)
  })

  it('场景R3: rm hard-block still wins over the fail-open path (classifier down)', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    const { decision, nextCalls } = await preExecute(ctx, agent, 'bash', { command: 'rm -rf /tmp/x' })
    expect(decision.kind).toBe('deny')
    if (decision.kind === 'deny') expect(decision.reason).toContain('rm')
    expect(nextCalls).toBe(0)
    expect(track.code).toBe(1)
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

  it('场景F: a real network failure opens for a readonly shell command, closes for a write command', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    // Readonly shell command fail-opens (P2 Task 2): no delegation, tool runs.
    const status = await preExecute(ctx, agent, 'bash', { command: 'git status' })
    expect(status.decision.kind).toBe('allow')
    expect(status.nextCalls).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1) // fatal -> no retry
    // A write shell command still fails close on the same outage.
    const push = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' })
    expect(push.decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(track.code).toBe(1) // only the write command delegates to code-agent
  })

  it('场景G: HTTP 500 fails close without retry (write shell command)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(track.code).toBe(1)
  })

  it('场景G+: HTTP 429 fails close without retry (write shell command)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('too many requests', { status: 429 }))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(track.code).toBe(1)
  })

  it('场景G+: HTTP 400 fails close without retry (write shell command)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' })
    expect(decision.kind).toBe('deny')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(track.code).toBe(1)
  })

  it('场景H: a caller abort is a hard stop -> fetch never called, write shell fails close', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(fetchMock, track)
    const { agent } = agentFor(ws)
    const { decision } = await preExecute(ctx, agent, 'bash', { command: 'git push origin main' }, controller.signal)
    expect(fetchMock).toHaveBeenCalledTimes(0) // abort detected at the classify() entry
    expect(decision.kind).toBe('deny') // caller abort is fatal -> fail-close
    // The caller cancelled the turn, so the delegation channel is cancelled too
    // (tools.execute refuses an already-aborted signal): no subagent dispatch.
    expect(track.code).toBeUndefined()
  })

  it('验收11: 清单变更可热重载 —— 编辑 YAML 后下次 pre-execute 即生效', async () => {
    const track: { code?: number; check?: number } = {}
    const ctx = await setup(async () => { throw new Error('network down') }, track)
    const { agent } = agentFor(ws)
    const target = path.join(ws, 'docs/report.md')

    // 初次判定：v1 白名单 docs/ 允许 *.md → 放行
    const before = await preExecute(ctx, agent, 'write', { file_path: target })
    expect(before.decision.kind).toBe('allow')
    expect(before.nextCalls).toBe(1)

    // 收紧白名单：docs/ 仅允许 *.txt → 同一路径应转为拒绝
    const tightened = `
defaultPolicy: deny
symlinkResolve: true
whitelist:
  - type: prefix
    value: "${ws}/docs/"
    allowedExtensions: [".txt"]
    reason: "收紧后仅允许 txt"
temporaryOverrides: []
`
    await fs.writeFile(whitelistPath, tightened, 'utf8')

    // 下次 pre-execute 必须读到新清单（验收11 热重载）→ 拒绝且不派发
    const after = await preExecute(ctx, agent, 'write', { file_path: target })
    expect(after.decision.kind).toBe('deny')
    expect(after.nextCalls).toBe(0)
  })
})
