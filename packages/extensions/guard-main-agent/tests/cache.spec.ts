import { describe, expect, it, vi } from 'vitest'
import { cacheKeyString, hashText, type CacheKey, TTLMap } from '../src/cache.ts'

function key(overrides: Partial<CacheKey> = {}): CacheKey {
  return {
    sessionId: 's',
    messageHash: 'h',
    workspacePath: '/ws',
    presetId: 'full',
    ...overrides,
  }
}

describe('guard-main-agent cache', () => {
  describe('cacheKeyString', () => {
    it('joins the four tuple fields in stable order', () => {
      expect(cacheKeyString(key())).toBe('s|h|/ws|full')
      expect(cacheKeyString(key({ workspacePath: '/other', presetId: 'code' }))).toBe('s|h|/other|code')
    })

    it('produces different keys when any tuple field changes', () => {
      const base = cacheKeyString(key())
      expect(cacheKeyString(key({ messageHash: 'other' }))).not.toBe(base)
      expect(cacheKeyString(key({ sessionId: 'other' }))).not.toBe(base)
      expect(cacheKeyString(key({ workspacePath: '/other' }))).not.toBe(base)
      expect(cacheKeyString(key({ presetId: 'other' }))).not.toBe(base)
    })
  })

  describe('hashText', () => {
    it('is deterministic and differs between inputs', () => {
      expect(hashText('write a plan')).toBe(hashText('write a plan'))
      expect(hashText('write a plan')).not.toBe(hashText('fix the bug'))
      expect(hashText('')).toBe(hashText(''))
    })
  })

  describe('TTLMap', () => {
    it('returns a stored value on cache hit', () => {
      const cache = new TTLMap<string, string>(3, 60_000)
      cache.set('a', 'verdict-1')
      expect(cache.get('a')).toBe('verdict-1')
    })

    it('returns undefined for a missing key', () => {
      const cache = new TTLMap<string, string>(3, 60_000)
      expect(cache.get('nope')).toBeUndefined()
    })

    it('evicts an entry after its TTL expires', () => {
      vi.useFakeTimers()
      try {
        const cache = new TTLMap<string, string>(3, 1_000)
        cache.set('a', 'verdict-1')
        expect(cache.get('a')).toBe('verdict-1')
        vi.advanceTimersByTime(1_001)
        expect(cache.get('a')).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('evicts the least-recently-used entry when over capacity', () => {
      vi.useFakeTimers()
      try {
        const cache = new TTLMap<string, string>(2, 60_000)
        cache.set('a', 'v1')
        cache.set('b', 'v2')
        // Touch `a` so it becomes most-recent; `b` is now the LRU head.
        expect(cache.get('a')).toBe('v1')
        cache.set('c', 'v3')
        expect(cache.get('c')).toBe('v3')
        expect(cache.get('a')).toBe('v1')
        expect(cache.get('b')).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    })

    it('refreshes recency on every get so a hot key survives later inserts', () => {
      vi.useFakeTimers()
      try {
        const cache = new TTLMap<string, string>(2, 60_000)
        cache.set('a', 'v1')
        cache.set('b', 'v2')
        cache.get('a')
        cache.set('c', 'v3') // evicts b, keeps a
        expect(cache.get('a')).toBe('v1')
        expect(cache.get('c')).toBe('v3')
      } finally {
        vi.useRealTimers()
      }
    })

    it('overwriting a key keeps a single entry with a fresh TTL', () => {
      vi.useFakeTimers()
      try {
        const cache = new TTLMap<string, string>(3, 10_000)
        cache.set('a', 'old')
        cache.set('a', 'new')
        expect(cache.size).toBe(1)
        expect(cache.get('a')).toBe('new')
      } finally {
        vi.useRealTimers()
      }
    })

    it('clear drops every entry', () => {
      const cache = new TTLMap<string, string>(3, 60_000)
      cache.set('a', 'v1')
      cache.set('b', 'v2')
      cache.clear()
      expect(cache.size).toBe(0)
      expect(cache.get('a')).toBeUndefined()
    })

    it('rejects non-positive max and ttl at construction', () => {
      expect(() => new TTLMap<string, string>(0, 60_000)).toThrow(/positive integer/)
      expect(() => new TTLMap<string, string>(3, 0)).toThrow(/positive integer/)
    })
  })
})
