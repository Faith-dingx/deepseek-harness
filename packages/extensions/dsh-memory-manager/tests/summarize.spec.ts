import { afterEach, describe, expect, it, vi } from 'vitest'
import { fallbackSummary, generateSummary, type SummarizeConfig } from '../src/history-compressor/summarize.ts'

const config: SummarizeConfig = {
  endpoint: 'http://x:9888/v1/chat/completions',
  model: 'agnes/agnes-2.5-flash',
  timeoutMs: 5000,
  maxSummaryLines: 50,
}

function useful(turnId: string, content: string, isUser = true): { turnId: string; content: string; isUser: boolean } {
  return { turnId, content, isUser }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function replyMarkdown(text: string): () => Promise<Response> {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 })
}

describe('trimTo / line budget', () => {
  it('truncates a fallback summary to the maxSummaryLines budget', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ turnId: `u${i}`, content: `要点${i}`, isUser: true }))
    const text = fallbackSummary(many, 'ctx', new Date('2026-08-22T10:30:00Z'), 20)
    expect(text.split('\n').length).toBeLessThanOrEqual(20)
    // 双空格被压成单空格
    expect(text).not.toContain('  ')
  })
})

describe('fallbackSummary (计划 v18 §4.2.4 摘要结构, fail-open 兜底)', () => {
  it('builds a five-section summary with provenance and within the line budget', () => {
    const text = fallbackSummary(
      [useful('t3', '用户要求修复 guard 误拦问题'), useful('t4', '关键概念：9888 网关 timeout 配置')],
      '当前任务：修复 timeout',
      new Date('2026-08-22T10:30:00Z'),
      50,
    )
    expect(text).toContain('# 对话历史摘要')
    expect(text).toContain('> 生成时间：2026-08-22 10:30')
    expect(text).toContain('> 压缩策略：基于内容甄别的结构化摘要（已过时/无用内容已归档）')
    for (const section of ['Primary Request', 'Key Concepts', 'Files', 'Errors', 'Pending Jobs']) {
      expect(text).toContain(`## ${section}`)
    }
    expect(text.split('\n').length).toBeLessThanOrEqual(50)
    // 只含"仍有用"段的内容
    expect(text).toContain('修复 guard 误拦问题')
    expect(text).not.toContain('过时内容')
  })

  it('handles empty useful segments with an empty-styled summary', () => {
    const text = fallbackSummary([], 'ctx', new Date('2026-08-22T10:30:00Z'), 50)
    expect(text).toContain('## Primary Request')
    expect(text).toContain('-（暂无仍有用内容）')
  })
})

describe('generateSummary (T15 自行实现 LLM 摘要, 不经 compaction-basic)', () => {
  it('returns the model summary on success', async () => {
    vi.stubGlobal('fetch', replyMarkdown('# 对话历史摘要\n## Primary Request\n- x\n'))
    const text = await generateSummary(
      [useful('t3', '内容')],
      'ctx',
      config,
      '第 3-8 轮（保留最近 2 轮原文）',
      '2026-08-22T10:30:00Z',
    )
    expect(text).toContain('## Primary Request')
    expect(text).toContain('- x')
  })

  it('falls back to the local summary when the LLM call fails (fail-open)', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down') })
    const text = await generateSummary(
      [useful('t3', '核心要点 A')],
      'ctx',
      config,
      '第 3-8 轮（保留最近 2 轮原文）',
      '2026-08-22T10:30:00Z',
    )
    expect(text).toContain('## Primary Request')
    expect(text).toContain('核心要点 A')
  })

  it('falls back when the response carries no usable content', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    const text = await generateSummary([useful('t3', '要点 B')], 'ctx', config, 'r', '2026-08-22T10:00:00Z')
    expect(text).toContain('要点 B')
  })

  it('sends only the still-useful segments plus task context to the model', async () => {
    const fetchMock = vi.fn(replyMarkdown('# 对话历史摘要\n## Primary Request\n- x\n'))
    vi.stubGlobal('fetch', fetchMock)
    await generateSummary(
      [useful('t3', '仍有用内容'), useful('t4', '另一个要点')],
      '当前任务上下文',
      config,
      '第 3-8 轮（保留最近 2 轮原文）',
      '2026-08-22T10:30:00Z',
    )
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(config.endpoint)
    const body = JSON.parse(init.body as string) as { model: string; messages: { role: string; content: string }[] }
    expect(body.model).toBe(config.model)
    expect(body.messages[0]?.content).toContain('Primary Request')
    expect(body.messages[1]?.content).toContain('当前任务上下文')
    expect(body.messages[1]?.content).toContain('仍有用内容')
  })

  it('falls back on a non-2xx summarizer response', async () => {
    vi.stubGlobal('fetch', async () => new Response('err', { status: 503 }))
    const text = await generateSummary([useful('t3', '要点 C')], 'ctx', config, 'r', '2026-08-22T10:00:00Z')
    expect(text).toContain('要点 C')
  })

  it('uses the default timeout when none is configured', async () => {
    vi.stubGlobal('fetch', replyMarkdown('# 对话历史摘要\n## Primary Request\n- ok\n'))
    const text = await generateSummary([useful('t3', 'x')], 'ctx', {
      endpoint: config.endpoint,
      model: config.model,
    }, 'r', 't')
    expect(text).toContain('## Primary Request')
  })

  it('aborts on timeout and falls back to the local summary', async () => {
    const neverSettle = (_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('Aborted')) })
    })
    vi.stubGlobal('fetch', neverSettle)
    const text = await generateSummary([useful('t3', '要点 D')], 'ctx', { ...config, timeoutMs: 30 }, 'r', '2026-08-22T10:00:00Z')
    expect(text).toContain('要点 D')
  })

  it('truncates very long lines in the fallback summary (trimTo 截断分支)', () => {
    const long = 'x'.repeat(200)
    const text = fallbackSummary([useful('t3', long)], 'ctx', new Date('2026-08-22T10:00:00Z'), 50)
    // Primary Request 用 80 截断 → `- `(2) + 79 + `…`(1) = 82
    expect(text).toContain('…')
    const maxLine = Math.max(...text.split('\n').map(line => line.length))
    expect(maxLine).toBeLessThanOrEqual(82)
  })

  it('uses the default line budget when maxSummaryLines is omitted (fallback path)', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down') })
    const text = await generateSummary(
      [useful('t3', '核心要点 E')],
      'ctx',
      { endpoint: config.endpoint, model: config.model }, // 无 maxSummaryLines
      'r',
      '2026-08-22T10:00:00Z',
    )
    expect(text).toContain('核心要点 E')
    expect(text.split('\n').length).toBeLessThanOrEqual(50)
  })
})

describe('generateSummary batch cap + segment truncation (9888 网关大窗口防护)', () => {
  function requestPrompt(fetchMock: ReturnType<typeof vi.fn>): string {
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init?.body as string) as { messages: { role: string; content: string }[] }
    return body.messages[1]?.content ?? ''
  }

  it('sends only the newest summarizeMaxSegments useful segments when over the cap', async () => {
    const fetchMock = vi.fn(replyMarkdown('# 对话历史摘要\n## Primary Request\n- ok\n'))
    vi.stubGlobal('fetch', fetchMock)
    const segments = Array.from({ length: 8 }, (_, i) => useful(`s${i + 1}`, `要点 ${i + 1}`))
    await generateSummary(segments, 'ctx', { ...config, summarizeMaxSegments: 3 }, '第 3-8 轮（保留最近 2 轮原文）', '2026-08-22T10:00:00Z')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const prompt = requestPrompt(fetchMock)
    expect(prompt.match(/\[s\d+\]/g) ?? []).toHaveLength(3)
    expect(prompt).toContain('[s6]')
    expect(prompt).toContain('[s8]')
    expect(prompt).not.toContain('[s1]')
    expect(prompt).not.toContain('[s5]')
  })

  it('truncates useful segment content to llmSegmentChars in the request', async () => {
    const fetchMock = vi.fn(replyMarkdown('# 对话历史摘要\n## Primary Request\n- ok\n'))
    vi.stubGlobal('fetch', fetchMock)
    const long = 'x'.repeat(500)
    await generateSummary([useful('s1', long)], 'ctx', { ...config, llmSegmentChars: 100 }, 'r', '2026-08-22T10:00:00Z')
    const prompt = requestPrompt(fetchMock)
    expect(prompt).toContain(`${'x'.repeat(100)}…`)
    expect(prompt).not.toContain('x'.repeat(101))
  })

  it('writes the real coverage range into the fallback summary (非硬编码 第 3-8 轮)', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down') })
    const text = await generateSummary(
      [useful('t3', '要点 F')],
      'ctx',
      config,
      '第 3-130 轮（保留最近 2 轮原文）',
      '2026-08-22T10:00:00Z',
    )
    expect(text).toContain('> 覆盖范围：第 3-130 轮（保留最近 2 轮原文）')
    expect(text).not.toContain('> 覆盖范围：第 3-8 轮')
  })

  it('fallbackSummary accepts an explicit coverage range (直接调用传入值生效)', () => {
    const text = fallbackSummary(
      [useful('t3', '要点 G')],
      'ctx',
      new Date('2026-08-22T10:00:00Z'),
      50,
      '第 3-9 轮（保留最近 2 轮原文）',
    )
    expect(text).toContain('> 覆盖范围：第 3-9 轮（保留最近 2 轮原文）')
  })
})
