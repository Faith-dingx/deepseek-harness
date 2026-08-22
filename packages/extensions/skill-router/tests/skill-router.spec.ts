import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import * as skillRouter from '../src/index.ts'
import type { SkillCatalogSource } from '../src/injector.ts'

const ALL = [
  { name: 'skill-docs', description: 'planning & docs' },
  { name: 'skill-code', description: 'code editing' },
  { name: 'skill-search', description: 'search' },
  { name: 'skill-subagent', description: 'delegation' },
]

function catalogMessage(entries: typeof ALL): UserMessage {
  const source: SkillCatalogSource = { kind: 'skill-catalog', form: 'catalog', entries }
  return createUserMessage({
    content: [{ type: 'text', text: '<system-reminder>\n<available_skills>\n</available_skills>\n</system-reminder>' }],
    source,
  })
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Minimal agent whose session header carries the cwd + id used by the plugin. */
function agentFor(cwd: string, id = 'skill-router-agent'): Agent {
  const session = Session.create(SessionId(id), [], { version: 0, id: SessionId(id), createdAt: 0, cwd })
  return {
    id: SessionId(id),
    options: {},
    session,
    inbox: {} as never,
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('unused') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

async function dispatchPreStep(
  ctx: Context,
  agent: Agent,
  claimedMessages: UserMessage[],
  catalogEntries: typeof ALL,
): Promise<UserMessage[]> {
  const signal = new AbortController().signal
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: claimedMessages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [catalogMessage(catalogEntries)] }),
  )
  if (decision.kind === 'reject') return []
  return decision.messages
}

function catalogEntriesOf(messages: UserMessage[]): string[] | undefined {
  const msg = messages.find(m => (m.source as { kind?: unknown }).kind === 'skill-catalog')
  const entries = (msg?.source as { entries?: { name: string }[] } | undefined)?.entries
  return entries?.map(e => e.name)
}

async function setup(fetchImpl: () => Promise<Response>): Promise<Context> {
  vi.stubGlobal('fetch', fetchImpl)
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(skillRouter, {
    classifierEndpoint: 'http://classifier:9888/v1/chat/completions',
    classifierModel: 'agnes-2.5-flash',
    fallback: 'close',
    timeoutMs: 5000,
    presetId: 'full',
  })
  return ctx
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function replyJson(content: string): () => Promise<Response> {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

describe('dsh-skill-router pre-step integration', () => {
  it('filters code skills out of the catalog for a planning/docs task', async () => {
    const ctx = await setup(replyJson('{"included": ["skill-docs", "skill-search"]}'))
    const agent = agentFor('/ws')
    const out = await dispatchPreStep(ctx, agent, [userMessage('write a project plan and milestone doc')], ALL)
    const names = catalogEntriesOf(out)
    expect(names).not.toContain('skill-code')
    expect(names).not.toContain('skill-subagent')
    expect(names).toContain('skill-docs')
  })

  it('keeps code skills available for a code task', async () => {
    const ctx = await setup(replyJson('["skill-docs","skill-code","skill-search","skill-subagent"]'))
    const agent = agentFor('/ws')
    const out = await dispatchPreStep(ctx, agent, [userMessage('refactor the module and add tests')], ALL)
    const names = catalogEntriesOf(out)
    expect(names).toContain('skill-code')
    expect(names).toContain('skill-subagent')
  })

  it('reuses the cached classification for the same user message', async () => {
    const fetchMock = vi.fn(replyJson('["skill-docs"]'))
    const ctx = await setup(fetchMock)
    const agent = agentFor('/ws')
    const claimed = [userMessage('same message')]
    await dispatchPreStep(ctx, agent, claimed, ALL)
    await dispatchPreStep(ctx, agent, claimed, ALL)
    // fetch invoked exactly once thanks to the cache.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('applies fail-close (empty catalog) when the classifier is unavailable', async () => {
    const ctx = await setup(async () => { throw new Error('network down') })
    const agent = agentFor('/ws')
    const out = await dispatchPreStep(ctx, agent, [userMessage('anything')], ALL)
    expect(catalogEntriesOf(out)).toEqual([])
  })
})
