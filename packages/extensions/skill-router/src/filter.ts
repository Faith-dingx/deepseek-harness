/**
 * Classification result parsing and fault-tolerance.
 *
 * The classifier may return a JSON object, a bare JSON array, or garbage (or
 * nothing at all when the request failed). This module turns any raw string
 * into a {@link SkillFilterResult}, applying the configured fallback policy
 * when the output cannot be trusted. Names are validated against the available
 * skill list so an inventing classifier can never leak a skill into the
 * catalog.
 *
 * @module @deepseek-ai/dsh-skill-router
 */

import type { FallbackMode, SkillFilterResult } from './types.ts'

/** Minimal safe allowlist used by the `minimal` fallback (matched against available names). */
const MINIMAL_SAFE_NAMES: readonly string[] = []

/**
 * Resolve what the fallback should expose.
 * @param mode - the configured fallback policy.
 * @param available - the full set of available skill names in the catalog.
 */
export function resolveFallback(mode: FallbackMode, available: readonly string[]): string[] {
  switch (mode) {
    case 'close':
      // Fail-close: expose nothing. Isolation beats availability.
      return []
    case 'open':
      // Fail-open: expose everything (identical to no filtering).
      return [...available]
    case 'minimal': {
      const kept = MINIMAL_SAFE_NAMES.filter(name => available.includes(name))
      // Avoid an empty catalog when no minimal-safe name is present: expose
      // the full set rather than a useless empty catalog.
      return kept.length > 0 ? kept : [...available]
    }
  }
}

/**
 * Parse a classifier reply into included skill names.
 *
 * Accepted formats:
 * - `{"included": ["a"], "reason": "..."}` (object form)
 * - `["a", "b"]` (bare array form)
 *
 * Names are normalized (trimmed) and validated against `available`. Unknown or
 * malformed names are dropped; a structurally valid reply that names no known
 * skill yields an empty `included` (expose nothing). Only when the raw output
 * cannot be parsed at all is the configured fallback applied.
 *
 * @param raw - the classifier response text (may be empty on failure).
 * @param fallback - fallback policy to apply on unreadable/empty output.
 * @param available - the full set of available skill names.
 */
export function parseFilterResult(raw: string, fallback: FallbackMode, available: readonly string[]): SkillFilterResult {
  const normalized = raw.trim()
  const names = parseNames(normalized, available)
  if (names === null) {
    const included = resolveFallback(fallback, available)
    return { included, reason: fallback === 'close' ? 'classifier unavailable; fail-close' : `classifier output unreadable; fallback=${fallback}` }
  }
  return { included: names }
}

/**
 * Extract a validated list of names from a classifier reply, or null when the
 * output is structurally unreadable or contains no valid names.
 */
function parseNames(raw: string, available: readonly string[]): string[] | null {
  if (raw === '') return null
  const availableSet = new Set(available)
  let parsedList: unknown
  try {
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) {
      parsedList = value
    } else if (typeof value === 'object' && value !== null) {
      const included = (value as { included?: unknown }).included
      if (Array.isArray(included)) parsedList = included
      else return null
    } else {
      return null
    }
  } catch {
    return null
  }
  const names: string[] = []
  for (const item of parsedList as unknown[]) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    if (name === '' || !availableSet.has(name)) continue
    if (!names.includes(name)) names.push(name)
  }
  return names
}
