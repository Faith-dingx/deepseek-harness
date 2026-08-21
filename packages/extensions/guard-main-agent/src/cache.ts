/**
 * Classification cache.
 *
 * Reusing a classification for the same task keeps repeated pre-execute
 * passes free of extra classifier calls. The key is the four-tuple
 * (sessionId, messageHash, workspacePath, presetId), so a new user message, a
 * different workspace, or a different agent each get their own entry. A
 * messageHash change (task switch) therefore misses the cache and forces a
 * reclassification — the caller compares the freshly computed hash with the
 * key before every evaluation (plan decision 4). Entries expire after a TTL
 * and are evicted under an LRU cap.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import { createHash } from 'node:crypto'

/** The four-tuple cache key, matching the skill-router convention. */
export interface CacheKey {
  readonly sessionId: string
  readonly messageHash: string
  readonly workspacePath: string
  readonly presetId: string
}

/** Stringify a cache key deterministically (stable field order). */
export function cacheKeyString(key: CacheKey): string {
  return [key.sessionId, key.messageHash, key.workspacePath, key.presetId].join('|')
}

/** SHA-256 hex of a text (used for the user-message hash in the cache key). */
export function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** An LRU cache with per-entry TTL, backed by a Map (insertion order = recency). */
export class TTLMap<K, V> {
  private readonly map = new Map<K, { value: V; expiresAt: number }>()
  private readonly max: number
  private readonly ttlMs: number

  constructor(max: number, ttlMs: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error('guard-main-agent: cache max must be a positive integer')
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new Error('guard-main-agent: cache ttl must be a positive integer')
    this.max = max
    this.ttlMs = ttlMs
  }

  /** Look up a key; returns undefined when missing or expired. */
  get(key: K): V | undefined {
    const hit = this.map.get(key)
    if (hit === undefined) return undefined
    if (Date.now() >= hit.expiresAt) {
      this.map.delete(key)
      return undefined
    }
    // Refresh recency: re-insert at the tail (most-recent position).
    this.map.delete(key)
    this.map.set(key, hit)
    return hit.value
  }

  /** Store a value under a key with a fresh TTL, evicting the LRU head if over cap. */
  set(key: K, value: V): void {
    this.map.delete(key)
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs })
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  /** Current number of live entries. */
  get size(): number {
    return this.map.size
  }

  /** Drop all entries. */
  clear(): void {
    this.map.clear()
  }
}
