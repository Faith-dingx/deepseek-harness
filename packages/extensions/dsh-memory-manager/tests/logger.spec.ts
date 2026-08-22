import { describe, expect, it, vi } from 'vitest'
import {
  appendAuditLine,
  auditLogFileName,
  formatAuditLine,
  type AuditFs,
} from '../src/shared/logger.ts'

describe('formatAuditLine (计划 v18 §5.2 步骤⑥ / T9)', () => {
  it('renders a full entry with all fields', () => {
    const line = formatAuditLine({ time: '2026-08-22T10:00:00Z', event: 'audit', file: '/ws/x.md', detail: 'ok' })
    expect(line).toContain('2026-08-22T10:00:00Z')
    expect(line).toContain('"event":"audit"')
    expect(line).toContain('"file":"/ws/x.md"')
    expect(line).toContain('"detail":"ok"')
  })

  it('renders a minimal entry without optional fields', () => {
    const line = formatAuditLine({ time: 't', event: 'start' })
    expect(line).toContain('"event":"start"')
    expect(line).not.toContain('"file"')
  })
})

describe('auditLogFileName (T9: 日志保留 30 天自动归档)', () => {
  it('names the log by day', () => {
    expect(auditLogFileName(new Date('2026-08-22T12:00:00'))).toBe('audit-2026-08-22.log')
  })
})

describe('appendAuditLine', () => {
  function memoryFs(): AuditFs & { lines: string[] } {
    const lines: string[] = []
    return {
      lines,
      async mkdir() {},
      async appendFile(_dir, line) { lines.push(line) },
    }
  }

  it('appends a formatted line through the injected fs (mkdir then append)', async () => {
    const fs = memoryFs()
    await appendAuditLine('/audit', { time: 't', event: 'ok' }, fs)
    expect(fs.lines).toEqual([`${formatAuditLine({ time: 't', event: 'ok' })}\n`])
  })

  it('fails open: an fs error is swallowed, the caller never sees a rejection', async () => {
    const failing: AuditFs = {
      async mkdir() { throw new Error('EACCES') },
      async appendFile() {},
    }
    const spy = vi.fn(async () => { throw new Error('EACCES') })
    failing.mkdir = spy
    await expect(appendAuditLine('/audit', { time: 't', event: 'x' }, failing)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
