import { afterEach, describe, expect, it, vi } from 'vitest'
import { callClassifier, classify } from '../src/classifier.ts'
import { parseFilterResult } from '../src/filter.ts'
import type { SkillRouterConfig } from '../src/types.ts'
import { buildSystemPrompt } from '../src/prompt.ts'

const CONFIG: SkillRouterConfig = {
  classifierEndpoint: 'http://classifier:9888/v1/chat/completions',
  classifierModel: 'agnes-2.5-flash',
  fallback: 'close',
  timeoutMs: 5000,
  cacheTtlMs: 300_000,
  cacheMax: 100,
}

const AVAILABLE = [
  { name: 'skill-docs', description: 'planning & docs' },
  { name: 'skill-code', description: 'code editing' },
  { name: 'skill-search', description: 'search' },
  { name: 'skill-subagent', description: 'delegation' },
]

const CONTEXT = { workspacePath: '/ws', presetId: 'full' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildSystemPrompt', () => {
  it('lists the available skills and includes the workspace/preset context', () => {
    const prompt = buildSystemPrompt('write a plan', AVAILABLE, CONTEXT)
    expect(prompt).toContain('skill-docs: planning & docs')
    expect(prompt).toContain('Workspace path: /ws')
    expect(prompt).toContain('Agent/preset: full')
    expect(prompt).toContain('write a plan')
    expect(prompt).toContain('Few-shot examples:')
  })
})

describe('callClassifier', () => {
  it('POSTs the expected payload to the configured endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '["skill-docs"]' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const raw = await callClassifier(CONFIG, 'write a plan', AVAILABLE, CONTEXT)
    expect(raw).toBe('["skill-docs"]')

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(CONFIG.classifierEndpoint)
    const body = JSON.parse(init.body as string) as unknown as {
      model: string
      messages: { role: string; content: string }[]
    }
    expect(body.model).toBe('agnes-2.5-flash')
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[0]?.content).toContain('skill-docs: planning & docs')
    expect(body.messages[1]).toEqual({ role: 'user', content: 'write a plan' })
  })

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 500 })))
    await expect(callClassifier(CONFIG, 'x', AVAILABLE, CONTEXT)).rejects.toThrow('HTTP 500')
  })

  it('throws when the response has no usable content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })))
    await expect(callClassifier(CONFIG, 'x', AVAILABLE, CONTEXT)).rejects.toThrow('no usable content')
  })
})

describe('classify', () => {
  it('returns a parsed, validated result on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"included": ["skill-code"], "reason": "code task"}' } }] }),
      { status: 200 },
    )))
    const result = await classify(CONFIG, 'refactor the module', AVAILABLE, CONTEXT)
    expect(result.included).toEqual(['skill-code'])
    expect(parseFilterResult('["skill-code"]', 'close', AVAILABLE.map(e => e.name)).included).toEqual(['skill-code'])
  })

  it('applies fail-close (empty catalog) when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const result = await classify(CONFIG, 'x', AVAILABLE, CONTEXT)
    expect(result.included).toEqual([])
    expect(result.reason).toContain('fail-close')
  })

  it('never throws even on malformed output', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'garbage' } }] }), { status: 200 })))
    const result = await classify(CONFIG, 'x', AVAILABLE, CONTEXT)
    expect(Array.isArray(result.included)).toBe(true)
  })
})
