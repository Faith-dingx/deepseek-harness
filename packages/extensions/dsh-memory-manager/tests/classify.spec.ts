import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifySegments,
  parseClassifications,
  ruleClassify,
  type ClassifyConfig,
  type HistorySegment,
} from '../src/history-compressor/classify.ts'

const config: ClassifyConfig = {
  endpoint: 'http://x:9888/v1/chat/completions',
  model: 'agnes/agnes-2.5-flash',
  confidenceThreshold: 0.6,
  timeoutMs: 5000,
}

function segment(id: string, content: string, daysAgo = 0, isUser = true): HistorySegment {
  return { turnId: id, content, timestamp: new Date(Date.now() - daysAgo * 86400000), isUser }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function replyJson(payload: unknown): () => Promise<Response> {
  return async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }), { status: 200 })
}

describe('ruleClassify (计划 v18 §4.2.2 规则兜底, T13)', () => {
  it('classifies pure chitchat as useless (寒暄检测)', () => {
    const r = ruleClassify(segment('t1', '好的，谢谢！'), [])
    expect(r?.category).toBe('useless')
    expect(r?.confidence).toBe(1)
  })

  it('classifies temporary information as useless (临时信息)', () => {
    const r = ruleClassify(segment('t1', '临时路径 /tmp/test-xxx 已写入'), [])
    expect(r?.category).toBe('useless')
  })

  it('classifies completed markers without follow-up as stale (已完成标记)', () => {
    const r = ruleClassify(segment('t1', '【已完成】guard 误拦修复'), [])
    expect(r?.category).toBe('stale')
  })

  it('keeps a completed marker when a later turn still references it', () => {
    const followUp = segment('t2', 'guard 误拦修复 讨论继续', 0)
    expect(ruleClassify(segment('t1', '【已完成】guard 误拦修复', 0), [followUp])).toBeNull()
  })

  it('classifies 7-day-old content without follow-up as stale (时间阈值)', () => {
    const r = ruleClassify(segment('t1', '旧决策：方案 A', 8), [])
    expect(r?.category).toBe('stale')
  })

  it('detects latin-token follow-up (English keywords reference old content)', () => {
    const followUp = segment('t2', 'the timeout fix continues', 0)
    expect(ruleClassify(segment('t1', 'fix the timeout bug', 8), [followUp])).toBeNull()
  })

  it('keeps old content that a later turn references', () => {
    const followUp = segment('t2', '方案 A 继续', 0)
    expect(ruleClassify(segment('t1', '旧决策：方案 A', 8), [followUp])).toBeNull()
  })

  it('classifies exact duplicates of a recent turn as useless (重复内容)', () => {
    const dup = segment('t3', '帮我看看这个报错')
    const r = ruleClassify(segment('t1', '帮我看看这个报错'), [segment('t2', 'x'), dup])
    expect(r?.category).toBe('useless')
  })

  it('returns null for content no rule matches (交给 LLM)', () => {
    expect(ruleClassify(segment('t1', '需要分析 9888 网关的超时配置'), [])).toBeNull()
  })
})

describe('parseClassifications (T13 LLM 输出解析)', () => {
  it('parses a bare JSON array payload', () => {
    const parsed = parseClassifications(JSON.stringify([{ segmentId: 't1', category: 'useful', confidence: 0.9 }]))
    expect(parsed?.get('t1')?.category).toBe('useful')
  })

  it('parses fenced json', () => {
    const parsed = parseClassifications('```json\n[{"segmentId":"t1","category":"stale","confidence":0.8}]\n```')
    expect(parsed?.get('t1')?.category).toBe('stale')
  })

  it('returns null for garbage output', () => {
    expect(parseClassifications('not json at all')).toBeNull()
  })

  it('returns null for valid JSON that is not an array', () => {
    expect(parseClassifications(JSON.stringify({ segmentId: 't1' }))).toBeNull()
  })

  it('skips non-object entries and entries without a segmentId', () => {
    const parsed = parseClassifications(JSON.stringify([
      42,
      null,
      'string entry',
      { category: 'useful', confidence: 0.9 }, // 缺 segmentId
      { segmentId: 't1', category: 'useful', confidence: 0.9 },
    ]))
    expect(parsed?.size).toBe(1)
    expect(parsed?.get('t1')?.category).toBe('useful')
  })

  it('defaults missing category/confidence fields (LLM 输出缺字段 → 保守值)', () => {
    const parsed = parseClassifications(JSON.stringify([
      { segmentId: 't1' }, // 缺 category 和 confidence
      { segmentId: 't2', category: 42, confidence: 'high' },
    ]))
    expect(parsed?.get('t1')?.category).toBe('useful')
    expect(parsed?.get('t1')?.confidence).toBe(0.5)
    expect(parsed?.get('t2')?.category).toBe('useful')
    expect(parsed?.get('t2')?.confidence).toBe(0.5)
  })

  it('covers parseClassifications via a fenced non-array payload', () => {
    expect(parseClassifications('```json\n{"a":1}\n```')).toBeNull()
  })
})

describe('classifySegments (计划 v18 §4.2.2 LLM 轻量分类 + 规则兜底, T13)', () => {
  it('returns [] for no segments', async () => {
    expect(await classifySegments([], 'ctx', config)).toEqual([])
  })

  it('never calls the LLM when every segment is rule-classified', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const results = await classifySegments([segment('t1', '好的，谢谢！')], 'ctx', config)
    expect(results[0]?.category).toBe('useless')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps LLM classifications onto the input segments (高置信度保留)', async () => {
    vi.stubGlobal('fetch', replyJson([{ segmentId: 't1', category: 'stale', confidence: 0.9, reasoning: 'done' }]))
    const results = await classifySegments([segment('t1', '旧内容')], 'ctx', config)
    expect(results).toEqual([{ segmentId: 't1', category: 'stale', confidence: 0.9, reasoning: 'done' }])
  })

  it('degrades low-confidence classifications to useful (保留原文, 低置信度处理)', async () => {
    vi.stubGlobal('fetch', replyJson([{ segmentId: 't1', category: 'stale', confidence: 0.3 }]))
    const results = await classifySegments([segment('t1', '旧内容')], 'ctx', config)
    expect(results[0]?.category).toBe('useful')
  })

  it('treats unknown categories conservatively as useful', async () => {
    vi.stubGlobal('fetch', replyJson([{ segmentId: 't1', category: 'mystery', confidence: 0.9 }]))
    const results = await classifySegments([segment('t1', 'x')], 'ctx', config)
    expect(results[0]?.category).toBe('useful')
  })

  it('fills segments missing from the LLM reply as useful (fail-open 保留原文)', async () => {
    vi.stubGlobal('fetch', replyJson([{ segmentId: 't2', category: 'useful', confidence: 0.9 }]))
    const results = await classifySegments([segment('t1', 'a'), segment('t2', 'b')], 'ctx', config)
    expect(results.find(r => r.segmentId === 't1')?.category).toBe('useful')
    expect(results.find(r => r.segmentId === 't2')?.category).toBe('useful')
  })

  it('fails open to useful for every segment when the LLM call fails', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network down') })
    const results = await classifySegments([segment('t1', 'a'), segment('t2', 'b')], 'ctx', config)
    expect(results.every(r => r.category === 'useful')).toBe(true)
  })

  it('fails open when the LLM reply is not parseable', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 'oops' } }] }), { status: 200 }))
    const results = await classifySegments([segment('t1', 'a')], 'ctx', config)
    expect(results[0]?.category).toBe('useful')
  })

  it('merges rule results with LLM results for the rest', async () => {
    vi.stubGlobal('fetch', replyJson([{ segmentId: 't2', category: 'useful', confidence: 0.9 }]))
    const results = await classifySegments(
      [segment('t1', '好的，谢谢！'), segment('t2', '请分析超时配置')],
      'ctx',
      config,
    )
    expect(results.find(r => r.segmentId === 't1')?.category).toBe('useless')
    expect(results.find(r => r.segmentId === 't2')?.category).toBe('useful')
  })

  it('extracts the current task context into the LLM prompt', async () => {
    const fetchMock = vi.fn(replyJson([]))
    vi.stubGlobal('fetch', fetchMock)
    await classifySegments([segment('t1', 'a')], '当前任务：修 timeout bug', config)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(config.endpoint)
    const rawBody = init?.body
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '') as { model: string; messages: { role: string; content: string }[] }
    expect(body.messages[1]?.content).toContain('当前任务：修 timeout bug')
    expect(body.model).toBe(config.model)
  })

  it('fails open on a non-2xx classifier response', async () => {
    vi.stubGlobal('fetch', async () => new Response('err', { status: 500 }))
    const results = await classifySegments([segment('t1', 'a')], 'ctx', config)
    expect(results[0]?.category).toBe('useful')
  })

  it('fails open when the classifier content is not a string', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: 42 } }] }), { status: 200 }))
    const results = await classifySegments([segment('t1', 'a')], 'ctx', config)
    expect(results[0]?.category).toBe('useful')
  })

  it('uses the default timeout when none is configured', async () => {
    vi.stubGlobal('fetch', replyJson([{ segmentId: 't1', category: 'useful', confidence: 0.9 }]))
    const results = await classifySegments([segment('t1', 'a')], 'ctx', {
      endpoint: config.endpoint,
      model: config.model,
      confidenceThreshold: config.confidenceThreshold,
    })
    expect(results[0]?.category).toBe('useful')
  })

  it('rules out follow-up for a token-less completed marker (hasFollowUp empty-token branch)', () => {
    // 内容只有 emoji, 无 CJK 词组也无 latin 词 → tokens 为空 → 无后续引用 → 过时
    const r = ruleClassify(segment('t1', '✅ '), [])
    expect(r?.category).toBe('stale')
  })
})

describe('classify timeout abort (计划 v18 §4.2.2 超时 fail-open)', () => {
  it('aborts the LLM call on timeout and fails open to useful', async () => {
    const neverSettle = (_url: string, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('Aborted')) })
    })
    vi.stubGlobal('fetch', neverSettle)
    const results = await classifySegments([segment('t1', '旧内容')], 'ctx', { ...config, timeoutMs: 30 })
    expect(results[0]?.category).toBe('useful')
  })
})
