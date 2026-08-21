import { afterEach, describe, expect, it, vi } from 'vitest'
import { classify, callClassifier, summarizeArgs } from '../src/classifier.ts'
import { buildSystemPrompt, buildUserMessage } from '../src/prompt.ts'
import type { ClassifierContext, ResolvedGuardConfig } from '../src/types.ts'

const config: ResolvedGuardConfig = {
  classifierEndpoint: 'http://classifier:9888/v1/chat/completions',
  classifierModel: 'agnes/agnes-2.5-flash',
  fallback: 'close',
  diagnosticFallback: 'open',
  timeoutMs: 5000,
  retryCount: 1,
  cacheTtlMs: 600000,
  cacheMax: 50,
  presetId: 'main-agent',
  filePolicyPath: null,
  boundaryDocPath: null,
}

const context: ClassifierContext = {
  sessionId: 's1',
  workspacePath: '/home/dingx/DSF-work',
  presetId: 'main-agent',
  toolName: 'bash',
  argsSummary: '{"command":"echo hi"}',
  conversation: 'user: help\nassistant: sure',
  userMessage: '帮我排查这个 bug',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function replyJson(content: string): () => Promise<Response> {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
}

/** A fetch stub that never resolves on its own but rejects when aborted. */
function abortAwareNever(): (input: string, init: RequestInit) => Promise<Response> {
  return (_input, init) => new Promise((_, reject) => {
    const abort = (): void => { reject(new DOMException('aborted', 'AbortError')) }
    // Real fetch rejects immediately when handed an already-aborted signal.
    if (init.signal?.aborted) abort()
    else init.signal?.addEventListener('abort', abort)
  })
}

describe('classifier payload', () => {
  it('posts the endpoint with model, system+user messages, temperature 0 and bounded tokens', async () => {
    const fetchMock = vi.fn(replyJson(JSON.stringify({ verdict: 'block', reason: 'r' })))
    vi.stubGlobal('fetch', fetchMock)
    await classify(config, context)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(config.classifierEndpoint)
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' })
    const body = JSON.parse(init.body as string) as {
      model: string
      messages: { role: string; content: string }[]
      temperature: number
      max_tokens: number
    }
    expect(body.model).toBe('agnes/agnes-2.5-flash')
    expect(body.temperature).toBe(0)
    expect(body.max_tokens).toBe(200)
    expect(body.messages[0]?.role).toBe('system')
    expect(body.messages[0]?.content).toContain('guard classifier')
    expect(body.messages[1]?.role).toBe('user')
    expect(body.messages[1]?.content).toContain('bash')
    expect(body.messages[1]?.content).toContain('{"command":"echo hi"}')
  })

  it('system prompt embeds the boundary rules and JSON output contract', () => {
    const system = buildSystemPrompt()
    expect(system).toContain('MAIN-AGENT BOUNDARY RULES')
    expect(system).toContain('code-agent')
    expect(system).toContain('check-agent')
    expect(system).toContain('fail-close')
    expect(system).toContain('verdict')
    expect(system).toContain('delegateTo')
  })

  it('user message contains the tool, the args summary and the conversation', () => {
    const user = buildUserMessage(context)
    expect(user).toContain('bash')
    expect(user).toContain('{"command":"echo hi"}')
    expect(user).toContain('user: help')
    expect(user).toContain('帮我排查这个 bug')
  })
})

describe('summarizeArgs', () => {
  it('stringifies and truncates to 500 chars', () => {
    const long = { payload: 'x'.repeat(600) }
    const summary = summarizeArgs(long)
    expect(summary.length).toBeLessThanOrEqual(500)
    expect(summary.startsWith('{"payload":"')).toBe(true)
  })

  it('handles short objects without truncation', () => {
    expect(summarizeArgs({ path: '/tmp/a' })).toBe('{"path":"/tmp/a"}')
  })

  it('falls back to a placeholder for non-serializable arguments', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(summarizeArgs(circular)).toBe('[unserializable]')
  })

  it('handles non-object arguments', () => {
    expect(summarizeArgs('just-a-string')).toBe('"just-a-string"')
    expect(summarizeArgs(undefined)).toBe('undefined')
  })})

describe('classify', () => {
  it('returns the parsed output on success', async () => {
    vi.stubGlobal('fetch', replyJson(JSON.stringify({ verdict: 'block', reason: 'delegate', delegateTo: 'code-agent' })))
    const result = await classify(config, context)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.output).toEqual({ verdict: 'block', reason: 'delegate', delegateTo: 'code-agent' })
    }
  })

  it('returns ok:false on a non-2xx response', async () => {
    vi.stubGlobal('fetch', async () => new Response('oops', { status: 500 }))
    const result = await classify(config, context)
    expect(result.ok).toBe(false)
  })

  it('returns ok:false on a network failure', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network down') })
    const result = await classify(config, context)
    expect(result.ok).toBe(false)
  })

  it('returns ok:false on an unreadable assistant content', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"choices":[]}', { status: 200 }))
    const result = await classify(config, context)
    expect(result.ok).toBe(false)
  })

  it('aborts on timeout and reports ok:false', async () => {
    vi.stubGlobal('fetch', abortAwareNever())
    const result = await classify({ ...config, timeoutMs: 30 }, context)
    expect(result.ok).toBe(false)
  })

  it('aborts when the caller signal aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', abortAwareNever())
    const result = await classify(config, context, controller.signal)
    expect(result.ok).toBe(false)
  })

  it('classifies well under the 1s budget (acceptance criterion 4)', async () => {
    vi.stubGlobal('fetch', replyJson(JSON.stringify({ verdict: 'allow' })))
    const started = performance.now()
    await classify(config, context)
    const elapsed = performance.now() - started
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('callClassifier', () => {
  it('returns the raw assistant content', async () => {
    vi.stubGlobal('fetch', replyJson('raw-content'))
    expect(await callClassifier(config, context)).toBe('raw-content')
  })

  it('throws on a timeout', async () => {
    vi.stubGlobal('fetch', abortAwareNever())
    const p = callClassifier({ ...config, timeoutMs: 30 }, context).then(
      () => 'resolved',
      () => 'rejected',
    )
    expect(await p).toBe('rejected')
  })
})

describe('classify retry (计划-guard误拦修复 T4)', () => {
  it('场景A: a timeout error is retried once and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('aborted', 'AbortError'))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ verdict: 'allow' }) } }] }),
        { status: 200 },
      ))
    vi.stubGlobal('fetch', fetchMock)
    const result = await classify(config, context)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.output).toEqual({ verdict: 'allow' })
  })

  it('场景B: a timeout error retried once still fails -> errorType timeout', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', fetchMock)
    const result = await classify(config, context)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorType).toBe('timeout')
  })

  it('场景C: a non-timeout error is NOT retried -> errorType fatal', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'))
    vi.stubGlobal('fetch', fetchMock)
    const result = await classify(config, context)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorType).toBe('fatal')
  })

  it('场景D: retryCount=0 disables the timeout retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'))
    vi.stubGlobal('fetch', fetchMock)
    const result = await classify({ ...config, retryCount: 0 }, context)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorType).toBe('timeout')
  })

  it('场景E: caller abort is a hard stop -> fetch never called, no retry', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn(abortAwareNever())
    vi.stubGlobal('fetch', fetchMock)
    const result = await classify(config, context, controller.signal)
    expect(fetchMock).toHaveBeenCalledTimes(0)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorType).toBe('fatal')
  })
})
