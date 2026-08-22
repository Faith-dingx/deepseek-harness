/**
 * 摘要写入 (计划 v18 §4.2.4 / T15): write the generated summary to
 * conversationsummary-latest.md — single-file overwrite, no timestamp in the
 * name. The write registers a pendingWrite entry (history-compressor source)
 * BEFORE touching the file, so the audit-pipeline watcher identifies the
 * write source immediately and applies the short-wait strategy (计划 v18
 * §5.2 步骤② pendingWrite 机制). Fail-open: a write failure resolves with
 * ok=false instead of throwing.
 *
 * @module dsh-memory-manager/history-compressor/write-summary
 */

import type { WriteSource } from '../config.ts'

/** File-system surface for the summary write; injectable for tests. */
export interface SummaryWriteFs {
  writeFile(file: string, data: string): Promise<void>
  mkdir(dir: string, options?: { recursive: boolean }): Promise<void>
}

/** Result of the summary write. */
export interface SummaryWriteResult {
  readonly ok: boolean
}

/**
 * Write the summary file with pendingWrite registration. The file is
 * overwritten in place (单文件覆盖策略, 计划 v18 §3.6 文件策略).
 */
export async function writeSummaryFile(
  summaryFile: string,
  summaryText: string,
  registerPendingWrite: (file: string, source: WriteSource) => void,
  fsImpl: SummaryWriteFs,
): Promise<SummaryWriteResult> {
  try {
    registerPendingWrite(summaryFile, 'history-compressor')
    const index = summaryFile.lastIndexOf('/')
    const dir = index <= 0 ? '.' : summaryFile.slice(0, index)
    await fsImpl.mkdir(dir, { recursive: true })
    await fsImpl.writeFile(summaryFile, summaryText)
    return { ok: true }
  } catch {
    return { ok: false }
  }
}
