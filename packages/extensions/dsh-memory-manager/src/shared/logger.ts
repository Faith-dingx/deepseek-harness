/**
 * Audit log utilities (计划 v18 §5.2 步骤⑥ / T9). Every audit-pipeline action
 * records a structured line into `.dsh-memory/audit/audit-YYYY-MM-DD.log`.
 * The write is fail-open by design: a logger failure must never break the
 * memory write it is auditing.
 *
 * @module dsh-memory-manager/shared/logger
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** File-system surface the logger needs; injectable for tests. */
export interface AuditFs {
  mkdir(dir: string, options?: { recursive: boolean }): Promise<void>
  appendFile(file: string, data: string): Promise<void>
}

const defaultFs: AuditFs = {
  async mkdir(dir, options) { await fs.mkdir(dir, options) },
  async appendFile(file, data) { await fs.appendFile(file, data, 'utf8') },
}

/** One structured audit line. */
export interface AuditLogEntry {
  readonly time: string
  readonly event: string
  readonly file?: string
  readonly detail?: string
}

/** Render an entry as one JSON line (plain-text, no newline-injection). */
export function formatAuditLine(entry: AuditLogEntry): string {
  const record: Record<string, string> = { time: entry.time, event: entry.event }
  if (entry.file !== undefined) record.file = entry.file
  if (entry.detail !== undefined) record.detail = entry.detail
  return JSON.stringify(record)
}

/** Daily audit log file name: `audit-YYYY-MM-DD.log`. */
export function auditLogFileName(now: Date): string {
  const day = now.toISOString().slice(0, 10)
  return `audit-${day}.log`
}

/**
 * Append one audit line, creating the audit directory on first use. Never
 * throws: failures are contained so the audit trail cannot break the memory
 * pipeline it protects (fail-open, 计划 v18 §5.5).
 */
export async function appendAuditLine(auditDir: string, entry: AuditLogEntry, fsImpl: AuditFs = defaultFs): Promise<void> {
  try {
    await fsImpl.mkdir(auditDir, { recursive: true })
    const file = path.join(auditDir, auditLogFileName(new Date()))
    await fsImpl.appendFile(file, `${formatAuditLine(entry)}\n`)
  } catch {
    // fail-open: audit logging must never throw into the caller.
  }
}
