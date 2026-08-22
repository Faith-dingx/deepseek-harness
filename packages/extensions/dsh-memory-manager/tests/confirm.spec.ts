import { describe, expect, it } from 'vitest'
import {
  PendingWriteRegistry,
  confirmWriteComplete,
  sleep,
  type ConfirmFs,
} from '../src/audit-pipeline/confirm.ts'

describe('PendingWriteRegistry (计划 v18 §5.2 步骤② pendingWrite map, T3)', () => {
  it('registers a write before it happens and consumes it once with the source', () => {
    const reg = new PendingWriteRegistry()
    reg.register('/ws/.dsh-memory/conversationsummary-latest.md', 'history-compressor', 1000)
    expect(reg.size()).toBe(1)
    expect(reg.consume('/ws/.dsh-memory/conversationsummary-latest.md', 1500)).toBe('history-compressor')
    expect(reg.size()).toBe(0)
    // 消费过即清除: 第二次查不到
    expect(reg.consume('/ws/.dsh-memory/conversationsummary-latest.md', 1600)).toBeNull()
  })

  it('expires entries older than the 5s TTL (写后清除, 超时自动清理)', () => {
    const reg = new PendingWriteRegistry(5000)
    reg.register('/x.md', 'model-explicit', 1000)
    expect(reg.consume('/x.md', 6000)).toBeNull()
    expect(reg.size()).toBe(0)
  })

  it('supports multiple pending writes and per-file consumption', () => {
    const reg = new PendingWriteRegistry()
    reg.register('/a.md', 'turn-stopping', 0)
    reg.register('/b.md', 'history-compressor', 0)
    expect(reg.consume('/b.md', 100)).toBe('history-compressor')
    expect(reg.size()).toBe(1)
  })

  it('an unknown file yields null without side effects', () => {
    const reg = new PendingWriteRegistry()
    expect(reg.consume('/nope.md', 100)).toBeNull()
  })
})

describe('confirmWriteComplete (计划 v18 §5.2 步骤② 防半截读取, T3)', () => {
  function stableFs(sizes: Record<string, number>): ConfirmFs {
    return { async stat(file) { return { size: sizes[file] ?? -1 } } }
  }

  it('confirms when the size is stable across two reads, carrying the detected source', async () => {
    const fs = stableFs({ '/a.md': 10 })
    const result = await confirmWriteComplete('/a.md', fs, {
      waitMs: 0,
      stableReads: 1,
      detectSource: () => 'history-compressor',
    })
    expect(result.complete).toBe(true)
    expect(result.size).toBe(10)
    expect(result.source).toBe('history-compressor')
    expect(result.timeout).toBe(false)
  })

  it('times out to complete+timeout when the size never stabilizes within budget', async () => {
    let size = 1
    const growing: ConfirmFs = { async stat() { size += 1; return { size } } }
    const result = await confirmWriteComplete('/grow.md', growing, {
      waitMs: 250,
      stableReads: 1,
      detectSource: () => 'unknown',
      sleepImpl: async () => {},
      now: (() => { let t = 0; return () => (t += 200) })(),
    })
    expect(result.complete).toBe(true)
    expect(result.timeout).toBe(true)
    expect(result.size).toBeGreaterThan(1)
  })

  it('uses the default clock and sleep when now/sleepImpl are omitted', async () => {
    const fs = stableFs({ '/a.md': 3 })
    const result = await confirmWriteComplete('/a.md', fs, {
      waitMs: 0,
      extraWaitMs: 1,
      detectSource: () => 'model-explicit',
    })
    // 预算 1ms → 超时降级仍返回 complete
    expect(result.complete).toBe(true)
    expect(result.timeout).toBe(true)
  })

  it('uses the default source wait window when waitMs is omitted (default branch)', async () => {
    const fs = stableFs({ '/a.md': 7 })
    const slept: number[] = []
    const result = await confirmWriteComplete('/a.md', fs, {
      extraWaitMs: 0,
      stableReads: 1,
      detectSource: () => 'unknown',
      sleepImpl: async (ms) => { slept.push(ms) },
      now: (() => { let t = 0; return () => (t += 1) })(),
    })
    // 默认 waitMs=500 (source window)
    expect(slept[0]).toBe(500)
    expect(result.complete).toBe(true)
  })

  it('fails open: a stat error resolves to complete+timeout instead of throwing', async () => {
    const broken: ConfirmFs = { async stat() { throw new Error('EIO') } }
    const result = await confirmWriteComplete('/gone.md', broken, {
      waitMs: 0,
      stableReads: 1,
      detectSource: () => 'unknown',
    })
    expect(result.complete).toBe(true)
    expect(result.timeout).toBe(true)
  })

  it('uses the default source detection when detectSource is omitted', async () => {
    const fs = stableFs({ '/a.md': 4 })
    const result = await confirmWriteComplete('/a.md', fs, {
      waitMs: 0,
      extraWaitMs: 0,
      sleepImpl: async () => {},
      now: (() => { let t = 0; return () => (t += 1) })(),
    })
    expect(result.complete).toBe(true)
    expect(result.source).toBe('unknown')
  })

  it('waits out the source-specific wait window before stability reads (resolveWriteWaitMs)', async () => {
    const fs = stableFs({ '/a.md': 10 })
    const sleeps: number[] = []
    const result = await confirmWriteComplete('/a.md', fs, {
      waitMs: 50,
      extraWaitMs: 0,
      stableReads: 1,
      detectSource: () => 'history-compressor',
      sleepImpl: async (ms) => { sleeps.push(ms) },
      now: (() => { let t = 0; return () => (t += 1) })(),
    })
    // 先等 source 窗口, 再进入稳定循环
    expect(sleeps[0]).toBe(50)
    expect(result.complete).toBe(true)
  })

  it('requires stableReads consecutive equal sizes before completing', async () => {
    const calls: number[] = []
    const fs2: ConfirmFs = { async stat() { calls.push(1); return { size: 10 } } }
    const result = await confirmWriteComplete('/s.md', fs2, {
      waitMs: 0,
      extraWaitMs: 50,
      stableReads: 2,
      detectSource: () => 'unknown',
      sleepImpl: async () => {},
      now: (() => { let t = 0; return () => (t += 1) })(),
    })
    expect(result.complete).toBe(true)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('confirmWriteComplete default fs (真实路径)', () => {
  it('confirms a real file through the default node fs (no fsImpl injected)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const dir = mkdtempSync('/home/dingx/DSF-work/.temp/dshmm-confirm-')
    try {
      writeFileSync(`${dir}/a.md`, 'hello')
      const result = await confirmWriteComplete(`${dir}/a.md`, undefined, {
        waitMs: 0,
        extraWaitMs: 100,
        detectSource: () => 'model-explicit',
      })
      expect(result.complete).toBe(true)
      expect(result.size).toBe(5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sleep', () => {
  it('resolves after the given milliseconds', async () => {
    const start = Date.now()
    await sleep(5)
    expect(Date.now() - start).toBeGreaterThanOrEqual(4)
  })
})
