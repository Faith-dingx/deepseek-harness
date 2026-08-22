/**
 * 内容分类 (计划 v18 §4.2.2 / T13): LLM 轻量分类 + 规则兜底.
 *
 * Every history segment is judged against the four categories (过时/无用/
 * 仍有用/有价值但非当前). Obvious cases never reach the LLM (chitchat,
 * temp paths, completed markers, >7-day old content without follow-up,
 * exact duplicates) — those are ruled with confidence 1.0. Everything else
 * goes to the cheap model (agnes via 9888) in ONE batched call. The LLM
 * verdict counts only when it is a known category with confidence >= the
 * threshold (0.6); otherwise the segment degrades to `useful` — the raw text
 * stays available (fail-open, 保留原文). Any LLM failure degrades every
 * remaining segment to `useful` as well.
 *
 * @module dsh-memory-manager/history-compressor/classify
 */

/** The four history categories (计划 v18 §4.2.2). */
export type HistoryCategory = 'stale' | 'useless' | 'useful' | 'valuable-but-not-current'

const VALID_CATEGORIES: ReadonlySet<string> = new Set(['stale', 'useless', 'useful', 'valuable-but-not-current'])

/** One history segment handed to the classifier. */
export interface HistorySegment {
  readonly turnId: string
  readonly content: string
  readonly timestamp: Date
  readonly isUser: boolean
}

/** One classified segment (segmentId ↔ turnId). */
export interface ClassifiedResult {
  readonly segmentId: string
  readonly category: HistoryCategory
  readonly confidence: number
  readonly reasoning?: string
}

/** Classifier settings (endpoint/model/threshold from config). */
export interface ClassifyConfig {
  readonly endpoint: string
  readonly model: string
  readonly confidenceThreshold: number
  readonly timeoutMs?: number
}

/** A rule-verdict or null (no rule matched → ask the LLM). */
export interface RuleVerdict {
  readonly category: HistoryCategory
  readonly confidence: number
  readonly reasoning: string
}

const CHITCHAT_RE = /^(好的|好|谢谢|感谢|再见|你好|辛苦了|收到|没问题|嗯|ok|okay|了解了)+$/i

/** Extract meaningful tokens (CJK runs >=2 chars, latin words >=3 letters). */
function tokensOf(content: string): string[] {
  const cjk = content.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  const latin = content.match(/[a-zA-Z]{3,}/g) ?? []
  return [...cjk, ...latin].map(t => t.toLowerCase())
}

/** Whether a later segment references this one (any shared token). */
function hasFollowUp(segment: HistorySegment, all: readonly HistorySegment[]): boolean {
  const tokens = tokensOf(segment.content)
  if (tokens.length === 0) return false
  return all.some(other => other.turnId !== segment.turnId && tokens.some(token => other.content.toLowerCase().includes(token)))
}

/**
 * Rule-based fallback classification (免 LLM). Returns a verdict when a rule
 * clearly applies, null otherwise. Rules follow 计划 v18 §4.2.2 兜底条件表.
 */
export function ruleClassify(segment: HistorySegment, all: readonly HistorySegment[]): RuleVerdict | null {
  const content = segment.content.trim()
  // 寒暄检测: 仅包含寒暄关键词 → 无用
  const punctuationFree = content.replace(/[，。！!？?、,.~～\s]/g, '')
  if (punctuationFree.length > 0 && CHITCHAT_RE.test(punctuationFree)) {
    return { category: 'useless', confidence: 1, reasoning: 'chitchat' }
  }
  // 临时信息: /tmp/、临时路径、一次性 → 无用
  if (/\/tmp\/|临时路径|一次性/.test(content)) {
    return { category: 'useless', confidence: 1, reasoning: 'temporary-info' }
  }
  // 已完成标记: 且无后续相关轮次 → 过时
  if (/【已完成】|\[已完成\]|\[done\]|✅|已解决/.test(content)) {
    if (!hasFollowUp(segment, all)) return { category: 'stale', confidence: 0.95, reasoning: 'completed-marker' }
    return null
  }
  // 时间阈值: 超过 7 天且无后续引用 → 过时
  const ageDays = (Date.now() - segment.timestamp.getTime()) / 86400000
  if (ageDays > 7 && !hasFollowUp(segment, all)) {
    return { category: 'stale', confidence: 0.9, reasoning: 'older-than-7-days' }
  }
  // 重复内容: 与其它轮完全相同 → 无用
  if (all.some(other => other.turnId !== segment.turnId && other.content.trim() === content)) {
    return { category: 'useless', confidence: 0.9, reasoning: 'duplicate' }
  }
  return null
}

/** Parsed LLM classification map (segmentId → verdict fields). */
export type ParsedClassification = Map<string, { category: string; confidence: number; reasoning?: string }>

/**
 * Parse the model output into a segmentId map. Accepts a bare JSON array or a
 * fenced ` ```json ... ``` ` block; returns null for unreadable output.
 */
export function parseClassifications(text: string): ParsedClassification | null {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = match?.[1] ?? text
  let data: unknown
  try {
    data = JSON.parse(candidate)
  } catch {
    return null
  }
  if (!Array.isArray(data)) return null
  const map: ParsedClassification = new Map()
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.segmentId !== 'string') continue
    const reasoning = typeof record.reasoning === 'string' ? { reasoning: record.reasoning } : {}
    map.set(record.segmentId, {
      category: typeof record.category === 'string' ? record.category : 'useful',
      confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
      ...reasoning,
    })
  }
  return map
}

/** The 9888 client: one batched POST, never throws, null on any failure. */
async function callClassifier(
  segments: readonly HistorySegment[],
  currentTaskContext: string,
  config: ClassifyConfig,
  fetchImpl: typeof fetch,
): Promise<ParsedClassification | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, config.timeoutMs ?? 10000)
  try {
    const body = {
      model: config.model,
      messages: [
        {
          role: 'system',
          content: '你是历史对话内容分类器。把每段历史判定为四类之一：stale(过时)/useless(无用)/useful(仍有用)/valuable-but-not-current(有价值但非当前)。只输出 JSON 数组：[{"segmentId":"...","category":"...","confidence":0-1,"reasoning":"..."}]',
        },
        {
          role: 'user',
          content: `当前任务上下文：\n${currentTaskContext}\n\n历史片段：\n${segments.map(s => `[${s.turnId}] ${s.content}`).join('\n')}`,
        },
      ],
      temperature: 0,
      max_tokens: 400,
    }
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) return null
    const data: unknown = await response.json()
    const content = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content
    if (typeof content !== 'string') return null
    return parseClassifications(content)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Classify every segment, keeping input order. Rules win where applicable;
 * the LLM fills the rest; anything uncertain degrades to `useful`
 * (fail-open, 保留原文).
 */
export async function classifySegments(
  segments: readonly HistorySegment[],
  currentTaskContext: string,
  config: ClassifyConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ClassifiedResult[]> {
  if (segments.length === 0) return []
  const byId = new Map<string, ClassifiedResult>()
  const pending: HistorySegment[] = []

  for (const segment of segments) {
    const rule = ruleClassify(segment, segments)
    if (rule !== null) {
      byId.set(segment.turnId, {
        segmentId: segment.turnId,
        category: rule.category,
        confidence: rule.confidence,
        reasoning: rule.reasoning,
      })
    } else {
      pending.push(segment)
    }
  }

  if (pending.length > 0) {
    const llm = await callClassifier(pending, currentTaskContext, config, fetchImpl)
    for (const segment of pending) {
      const verdict = llm?.get(segment.turnId)
      // usable countermands the `verdict !== undefined` re-check: narrow by
      // inlining the undefined test instead of re-testing after `usable`.
      if (verdict === undefined
        || !VALID_CATEGORIES.has(verdict.category)
        || verdict.confidence < config.confidenceThreshold) {
        // 低置信度 / 未知类别 / 缺失 / LLM 失败 → 保守保留原文
        byId.set(segment.turnId, { segmentId: segment.turnId, category: 'useful', confidence: 0.5, reasoning: 'fallback-keep' })
        continue
      }
      const reasoning = verdict.reasoning === undefined ? {} : { reasoning: verdict.reasoning }
      byId.set(segment.turnId, {
        segmentId: segment.turnId,
        category: verdict.category as HistoryCategory,
        confidence: verdict.confidence,
        ...reasoning,
      })
    }
  }

  const results: ClassifiedResult[] = []
  for (const segment of segments) {
    // every segment was classified above (rule or LLM/fallback path), so the
    // lookup is total: avoid the non-null assertion by seeding the missing id.
    /* v8 ignore next -- unreachable: every segment gets a byId entry above. */
    const verdict = byId.get(segment.turnId) ?? {
      segmentId: segment.turnId,
      category: 'useful' as HistoryCategory,
      confidence: 0.5,
      reasoning: 'fallback-keep',
    }
    results.push(verdict)
  }
  return results
}
