/**
 * 摘要生成 (计划 v18 §4.2.4 / T15): SELF-IMPLEMENTED LLM summarization over
 * the 9888 gateway (the plan explicitly forbids reusing compaction-basic's
 * non-exported helper). Input is limited to the STILL-USEFUL segments after
 * classification. Output follows the §3.6 structure (5 sections, provenance
 * header, ≤50 lines). LLM failure falls back to a local structured summary
 * built from the useful segments (fail-open — the summary is still produced,
 * compaction-basic stays untouched as the pressure backstop).
 *
 * @module dsh-memory-manager/history-compressor/summarize
 */

/** Summarizer settings from plugin config. */
export interface SummarizeConfig {
  readonly endpoint: string
  readonly model: string
  readonly timeoutMs?: number
  readonly maxSummaryLines?: number
}

/** One still-useful segment handed to the summarizer. */
export interface UsefulSegment {
  readonly turnId: string
  readonly content: string
  readonly isUser: boolean
}

const DEFAULT_TIMEOUT_MS = 10000

/** The five required summary sections (计划 v18 §3.6 校验规则). */
export const SUMMARY_SECTIONS = ['Primary Request', 'Key Concepts', 'Files', 'Errors', 'Pending Jobs'] as const

/** `YYYY-MM-DD HH:MM` from an ISO timestamp for the provenance header. */
function humanTime(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

/**
 * Local structured summary (fallback, fail-open): the five §3.6 sections with
 * one trimmed line per still-useful segment, provenance header, and the
 * "已归档" compression-strategy note. Kept within the line budget.
 */
export function fallbackSummary(
  usefulSegments: readonly UsefulSegment[],
  currentTaskContext: string,
  now: Date,
  maxSummaryLines = 50,
): string {
  const lines: string[] = ['# 对话历史摘要', '']
  lines.push(`> 生成时间：${humanTime(now.toISOString())}`)
  lines.push('> 覆盖范围：第 3-8 轮（保留最近 2 轮原文）')
  lines.push('> 压缩策略：基于内容甄别的结构化摘要（已过时/无用内容已归档）')
  lines.push('')
  for (const section of SUMMARY_SECTIONS) {
    lines.push(`## ${section}`)
    if (section === 'Primary Request') {
      // Primary Request: user-side asks only.
      const asks = usefulSegments.filter(s => s.isUser).slice(0, 5)
      if (asks.length === 0) lines.push('-（暂无仍有用内容）')
      for (const ask of asks) lines.push(`- ${trimTo(ask.content, 80)}`)
    } else if (section === 'Key Concepts' && currentTaskContext.trim().length > 0) {
      lines.push(`- ${trimTo(currentTaskContext, 80)}`)
      for (const seg of usefulSegments.slice(0, 4)) lines.push(`- ${trimTo(seg.content, 60)}`)
    } else {
      for (const seg of usefulSegments.slice(0, 4)) lines.push(`- ${trimTo(seg.content, 60)}`)
    }
    lines.push('')
  }
  // Enforce the line budget (摘要 ≤ maxSummaryLines).
  if (lines.length > maxSummaryLines) return lines.slice(0, maxSummaryLines).join('\n')
  return lines.join('\n')
}

/** First `max` characters of a content line, single-line safe. */
function trimTo(content: string, max: number): string {
  const single = content.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

/** One batched model call; null on any failure (fail-open). */
async function callSummarizer(
  usefulSegments: readonly UsefulSegment[],
  currentTaskContext: string,
  config: SummarizeConfig,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const body = {
      model: config.model,
      messages: [
        {
          role: 'system',
          content: '你是对话摘要生成器。基于输入片段生成结构化摘要，必须包含 5 节：## Primary Request / ## Key Concepts / ## Files / ## Errors / ## Pending Jobs。每节不超过 10 条。只输出 Markdown，不要额外说明。',
        },
        {
          role: 'user',
          content: `当前任务上下文：\n${currentTaskContext}\n\n仍有用历史片段：\n${usefulSegments.map(s => `[${s.turnId}] ${s.content}`).join('\n')}`,
        },
      ],
      temperature: 0,
      max_tokens: 600,
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
    return typeof content === 'string' && content.trim().length > 0 ? content : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Generate the conversation summary for the still-useful segments. On any
 * LLM failure, falls back to the local {@link fallbackSummary} so a summary
 * is ALWAYS produced (fail-open).
 */
export async function generateSummary(
  usefulSegments: readonly UsefulSegment[],
  currentTaskContext: string,
  config: SummarizeConfig,
  _coverageRange: string,
  generatedAtIso: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const modelText = await callSummarizer(usefulSegments, currentTaskContext, config, fetchImpl)
  if (modelText !== null) return modelText
  return fallbackSummary(usefulSegments, currentTaskContext, new Date(generatedAtIso), config.maxSummaryLines ?? 50)
}
