import { describe, expect, it } from 'vitest'
import { parseFilterResult, resolveFallback } from '../src/filter.ts'

const AVAILABLE = ['skill-docs', 'skill-code', 'skill-search', 'skill-subagent']

describe('resolveFallback', () => {
  it('close exposes nothing', () => {
    expect(resolveFallback('close', AVAILABLE)).toEqual([])
  })

  it('open exposes everything', () => {
    expect(resolveFallback('open', AVAILABLE)).toEqual(['skill-docs', 'skill-code', 'skill-search', 'skill-subagent'])
  })

  it('minimal returns the safe intersection or the full set when empty', () => {
    // No MINIMAL_SAFE name exists among AVAILABLE -> full set to avoid an empty catalog.
    expect(resolveFallback('minimal', AVAILABLE)).toEqual(AVAILABLE)
  })
})

describe('parseFilterResult', () => {
  it('parses the object form and filters to available names', () => {
    const result = parseFilterResult('{"included": ["skill-docs", "ghost"], "reason": "doc task"}', 'close', AVAILABLE)
    expect(result.included).toEqual(['skill-docs'])
  })

  it('parses the bare array form', () => {
    const result = parseFilterResult('["skill-docs", "skill-search"]', 'close', AVAILABLE)
    expect(result.included).toEqual(['skill-docs', 'skill-search'])
  })

  it('deduplicates names and preserves order', () => {
    const result = parseFilterResult('["skill-docs", "skill-docs", "skill-code"]', 'close', AVAILABLE)
    expect(result.included).toEqual(['skill-docs', 'skill-code'])
  })

  it('treats an empty array as a valid empty result (expose nothing)', () => {
    const result = parseFilterResult('[]', 'close', AVAILABLE)
    expect(result.included).toEqual([])
    expect(result.reason).toBeUndefined()
  })

  it('falls back on garbage / non-JSON input', () => {
    expect(parseFilterResult('not json at all', 'close', AVAILABLE).included).toEqual([])
    expect(parseFilterResult('', 'open', AVAILABLE).included).toEqual(AVAILABLE)
  })

  it('ignores non-string and unknown entries', () => {
    const result = parseFilterResult('[123, "skill-code", null]', 'close', AVAILABLE)
    expect(result.included).toEqual(['skill-code'])
  })

  it('treats an object without a usable included array as unreadable', () => {
    expect(parseFilterResult('{"foo": 1}', 'close', AVAILABLE).included).toEqual([])
  })
})
