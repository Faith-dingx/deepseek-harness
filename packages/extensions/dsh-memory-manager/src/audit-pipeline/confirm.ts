/**
 * 步骤② 确认写入完毕 (计划 v18 §5.2). Two mechanisms:
 *
 * - {@link PendingWriteRegistry}: the pendingWrite map. The history
 *   compressor registers {filePath, source, timestamp} BEFORE writing a
 *   summary/suggestion file; the confirm stage consumes the entry (5s TTL) so
 *   the write source is known without guessing (写前注册 → 命中识别 → 写后清除).
 * - {@link confirmWriteComplete}: waits out the source-specific wait window,
 *   then treats the file as complete once its size stabilizes (防半截读取).
 *   Bounded by the wait budget; on budget exhaustion or stat failure it
 *   resolves `{complete:true, timeout:true}` — never throws (fail-open).
 *
 * Output shape (T5): `{complete, size, source, timeout}`, serializable.
 *
 * @module dsh-memory-manager/audit-pipeline/confirm
 */

import { promises as fs } from 'node:fs'
import type { WriteSource } from '../config.ts'

/** The stat surface the confirm stage needs; injectable for tests. */
export interface ConfirmFs {
  stat(file: string): Promise<{ size: number }>
}

const defaultFs: ConfirmFs = {
  async stat(file) { const s = await fs.stat(file); return { size: s.size } },
}

/** Sleep helper (exported for reuse/tests). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * pendingWrite map: register before writing, consume after the watcher
 * detects the change, TTL-expire stale entries (计划 v18 §5.2, default 5s).
 * Registration may carry `skipAudit` (用户授意入口通道: 插件自写目标记忆文件,
 * 内容已由三层防线验证 → 审核管线识别后跳过 normalize/archive)。
 */
export class PendingWriteRegistry {
  private readonly map = new Map<string, { source: WriteSource; timestamp: number; skipAudit: boolean }>()

  constructor(private readonly ttlMs = 5000) {}

  /**
   * Record an upcoming write so the confirm stage can identify its source.
   * `skipAudit` (default false) marks plugin-validated writes whose content
   * must not re-enter the normalize/archive gate.
   */
  register(file: string, source: WriteSource, now = Date.now(), skipAudit = false): void {
    this.map.set(file, { source, timestamp: now, skipAudit })
  }

  /**
   * Consume one pending entry. Returns `{source, skipAudit}` when present and
   * fresh, otherwise null (unknown-source fallback path in the caller).
   */
  consume(file: string, now = Date.now()): ConsumedPendingWrite | null {
    const pending = this.map.get(file)
    if (pending === undefined) return null
    this.map.delete(file)
    if (now - pending.timestamp >= this.ttlMs) return null
    return { source: pending.source, skipAudit: pending.skipAudit }
  }

  /** Number of currently registered (unconsumed) entries. */
  size(): number {
    return this.map.size
  }
}

/** One consumed pendingWrite: the write source + whether audit should skip. */
export interface ConsumedPendingWrite {
  readonly source: WriteSource
  readonly skipAudit: boolean
}

/** Result of the write-complete confirmation (serializable, T5). */
export interface ConfirmResult {
  readonly complete: boolean
  readonly size: number
  readonly source: WriteSource
  readonly timeout: boolean
}

/** The stat surface + timing knobs of confirmWriteComplete. */
export interface ConfirmOptions {
  /** Source-specific wait window before stability reads (default via resolveWriteWaitMs). */
  readonly waitMs?: number
  /** Extra wait budget for the stability loop (default 2000ms). */
  readonly extraWaitMs?: number
  /** Reads with equal size treat the write as complete. */
  readonly stableReads?: number
  /** Resolves the write source (pendingWrite consumption by default). */
  readonly detectSource?: () => WriteSource
  /** Injectable clock. */
  readonly now?: () => number
  /** Injectable sleep (tests avoid real timers). */
  readonly sleepImpl?: (ms: number) => Promise<void>
}

/**
 * Confirm the write to `file` is complete before the pipeline reads it.
 * Never throws: any failure resolves to `{complete:true, timeout:true}` so
 * the pipeline continues with the fallback unknown source (fail-open).
 */
export async function confirmWriteComplete(
  file: string,
  fsImpl: ConfirmFs = defaultFs,
  options: ConfirmOptions = {},
): Promise<ConfirmResult> {
  const detectSource = options.detectSource ?? (() => 'unknown')
  const now = options.now ?? Date.now
  const doSleep = options.sleepImpl ?? sleep
  const stableReads = options.stableReads ?? 1
  const waitWindow = options.waitMs ?? 500
  const budget = options.extraWaitMs ?? 2000
  const source = detectSource()
  // Wait out the source-specific window so appendText-style writers finish.
  if (waitWindow > 0) await doSleep(waitWindow)

  const started = now()
  let lastSize = -1
  let stable = 0
  let size = -1
  while (now() - started < budget) {
    let stat: { size: number }
    try {
      stat = await fsImpl.stat(file)
    } catch {
      break
    }
    size = stat.size
    if (size === lastSize) {
      stable += 1
      if (stable >= stableReads) return { complete: true, size, source, timeout: false }
    } else {
      stable = 0
      lastSize = size
    }
    await doSleep(100)
  }
  return { complete: true, size, source, timeout: true }
}
