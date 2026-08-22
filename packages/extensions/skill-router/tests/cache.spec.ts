import { describe, expect, it } from 'vitest'
import { cacheKeyString, TTLMap } from '../src/cache.ts'

/** Deterministic string key (the cache is used with string keys in production). */
function key(sessionId = 's1', messageHash = 'h1', workspacePath = '/w1', presetId = 'full'): string {
  return cacheKeyString({ sessionId, messageHash, workspacePath, presetId })
}

describe('cacheKeyString', () => {
  it('joins the four tuple fields in stable order', () => {
    expect(cacheKeyString({ sessionId: 'a', messageHash: 'b', workspacePath: 'c', presetId: 'd' })).toBe('a|b|c|d')
  })
})

describe('TTLMap', () => {
  it('stores and retrieves values', () => {
    const cache = new TTLMap<string, string>(10, 60_000)
    cache.set(key(), 'kept')
    expect(cache.get(key())).toBe('kept')
  })

  it('returns undefined for a missing key', () => {
    const cache = new TTLMap<string, string>(10, 60_000)
    expect(cache.get(key('missing'))).toBeUndefined()
  })

  it('evicts the least-recently-used head under the cap', () => {
    const cache = new TTLMap<string, string>(2, 60_000)
    cache.set(key('a', 'h1'), '1')
    cache.set(key('b', 'h2'), '2')
    cache.set(key('c', 'h3'), '3')
    expect(cache.get(key('a', 'h1'))).toBeUndefined() // LRU evicted
    expect(cache.get(key('b', 'h2'))).toBe('2')
    expect(cache.get(key('c', 'h3'))).toBe('3')
  })

  it('refreshes recency on get so a recently-read key is not the next eviction', () => {
    const cache = new TTLMap<string, string>(2, 60_000)
    cache.set(key('a', 'h1'), '1')
    cache.set(key('b', 'h2'), '2')
    cache.get(key('a', 'h1')) // touch a -> now b is LRU
    cache.set(key('c', 'h3'), '3')
    expect(cache.get(key('b', 'h2'))).toBeUndefined()
    expect(cache.get(key('a', 'h1'))).toBe('1')
  })

  it('expires entries after the TTL', () => {
    const cache = new TTLMap<string, string>(10, 1) // 1ms TTL
    cache.set(key(), 'v')
    // Force time to pass past the 1ms expiry.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get(key())).toBeUndefined()
        resolve()
      }, 5)
    })
  })

  it('rejects invalid capacity/ttl at construction', () => {
    expect(() => new TTLMap<string, string>(0, 60_000)).toThrow()
    expect(() => new TTLMap<string, string>(10, 0)).toThrow()
  })
})
