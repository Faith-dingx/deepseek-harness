import { describe, expect, it, vi } from 'vitest'
import { TurnTrigger, turnCompressionRange, type TurnTriggerHandler } from '../src/history-compressor/trigger.ts'

describe('turnCompressionRange (计划 v18 §4.2.4 压缩范围)', () => {
  it('compress turns 3..(turn - retain) when history is long enough', () => {
    expect(turnCompressionRange(8, 2)).toEqual({ from: 3, to: 6 })
  })

  it('returns null when below the threshold (保留最近 2 轮原文)', () => {
    expect(turnCompressionRange(5, 2)).toBeNull()
  })

  it('returns null when the compressible window is empty', () => {
    expect(turnCompressionRange(8, 7)).toBeNull()
  })
})

describe('TurnTrigger (计划 v18 §4.2.1 turn/end 触发, T15)', () => {
  it('does not fire below the threshold; fires once per turn at/above it', async () => {
    const calls: string[] = []
    const handler: TurnTriggerHandler = async (sessionId, turn) => { calls.push(`${sessionId}#${turn}`) }
    const trigger = new TurnTrigger({ thresholdTurns: 8 })

    trigger.onTurnEnd('s1', 7, handler)
    expect(calls).toEqual([])
    trigger.onTurnEnd('s1', 8, handler)
    trigger.onTurnEnd('s1', 9, handler)
    expect(calls).toEqual(['s1#8', 's1#9'])
  })

  it('deduplicates the same turn re-emitted (replay safety)', () => {
    const calls: string[] = []
    const trigger = new TurnTrigger({ thresholdTurns: 2 })
    trigger.onTurnEnd('s1', 3, (s, t) => { calls.push(`${s}#${t}`) })
    trigger.onTurnEnd('s1', 3, (s, t) => { calls.push(`${s}#${t}`) })
    expect(calls).toEqual(['s1#3'])
  })

  it('tracks turns independently per session', () => {
    const calls: string[] = []
    const trigger = new TurnTrigger({ thresholdTurns: 2 })
    trigger.onTurnEnd('s1', 2, (s, t) => { calls.push(`${s}#${t}`) })
    trigger.onTurnEnd('s2', 2, (s, t) => { calls.push(`${s}#${t}`) })
    expect(calls).toEqual(['s1#2', 's2#2'])
  })

  it('fails open: a handler rejection is swallowed and never rethrown', async () => {
    const trigger = new TurnTrigger({ thresholdTurns: 1 })
    const spy = vi.fn(async () => { throw new Error('boom') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    trigger.onTurnEnd('s1', 2, spy)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails open for a non-Error rejection too (String(error) 分支)', async () => {
    const trigger = new TurnTrigger({ thresholdTurns: 1 })
    const spy = vi.fn(async () => { throw 'boom-string' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    trigger.onTurnEnd('s1', 2, spy)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(spy).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fires only when the turn advanced past the last processed one', () => {
    const calls: string[] = []
    const trigger = new TurnTrigger({ thresholdTurns: 3 })
    trigger.onTurnEnd('s', 3, (s, t) => { calls.push(`${s}#${t}`) })
    trigger.onTurnEnd('s', 4, (s, t) => { calls.push(`${s}#${t}`) })
    // 乱序重放旧 turn（如恢复会话）不重新触发
    trigger.onTurnEnd('s', 3, (s, t) => { calls.push(`${s}#${t}`) })
    expect(calls).toEqual(['s#3', 's#4'])
  })
})
