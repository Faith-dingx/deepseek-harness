import { describe, expect, it } from 'vitest'
import type { AssembledContext, AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import { SHORT_TERM_MEMORY_NAMES } from '../src/config.ts'
import { classifyMemoryLayer, filterMemoryLayers } from '../src/memory-layer.ts'

function section(name: string, text = `text:${name}`): AssembledSection {
  return { name, text }
}

function context(name: string, text = `text:${name}`): AssembledContext {
  return { name, text }
}

describe('classifyMemoryLayer (计划 v12 T3)', () => {
  it.each([...SHORT_TERM_MEMORY_NAMES])('classifies known short-term name %s', (name) => {
    expect(classifyMemoryLayer(name)).toBe('short-term')
  })

  it('classifies unknown memory-namespace names as long-term', () => {
    expect(classifyMemoryLayer('memory:future-injection')).toBe('long-term')
    expect(classifyMemoryLayer('dsh:brand-new-snapshot')).toBe('long-term')
  })

  it('classifies every other name as long-term', () => {
    expect(classifyMemoryLayer('deployment:persona')).toBe('long-term')
    expect(classifyMemoryLayer('harness:identity')).toBe('long-term')
    expect(classifyMemoryLayer('tool:cordis')).toBe('long-term')
  })

  it('is purely name-based: a date-bearing unknown name stays long-term (0 timestamp parsing)', () => {
    expect(classifyMemoryLayer('memory:standing-2026-08-21')).toBe('long-term')
    expect(classifyMemoryLayer('dsh:auto-memory:2026-08-21')).toBe('long-term')
  })
})

describe('filterMemoryLayers (计划 v12 T5.c)', () => {
  it('keeps every known short-term section and context', () => {
    // dsh:auto-memory is a context, not a section: only the 5 section names here.
    const sections = [
      section('dsh:auto-memory-rules'),
      section('memory:profile'),
      section('memory:standing'),
      section('memory:failures'),
      section('memory:project'),
    ]
    const contexts = [context('dsh:auto-memory')]
    const out = filterMemoryLayers(sections, contexts)
    expect(out.sections.map(s => s.name)).toEqual([
      'dsh:auto-memory-rules',
      'memory:profile',
      'memory:standing',
      'memory:failures',
      'memory:project',
    ])
    expect(out.contexts.map(c => c.name)).toEqual(['dsh:auto-memory'])
  })

  it('drops unknown (long-term) memory-namespace names, both sections and contexts', () => {
    const sections = [section('memory:profile'), section('memory:future-x'), section('dsh:brand-new')]
    const contexts = [context('dsh:auto-memory'), context('dsh:archive-snapshot')]
    const out = filterMemoryLayers(sections, contexts)
    expect(out.sections.map(s => s.name)).toEqual(['memory:profile'])
    expect(out.contexts.map(c => c.name)).toEqual(['dsh:auto-memory'])
  })

  it('passes non-memory sections and contexts through untouched', () => {
    const sections = [
      section('deployment:persona'),
      section('harness:identity'),
      section('tool:lsp'),
      section('memory:standing'),
      section('agent-instructions'),
    ]
    const contexts = [context('subagent:delegation'), context('dsh:auto-memory')]
    const out = filterMemoryLayers(sections, contexts)
    expect(out.sections.map(s => s.name)).toEqual([
      'deployment:persona',
      'harness:identity',
      'tool:lsp',
      'memory:standing',
      'agent-instructions',
    ])
    expect(out.contexts.map(c => c.name)).toEqual(['subagent:delegation', 'dsh:auto-memory'])
  })

  it('keeps calendar content intact inside the dsh:auto-memory context (calendar covered, no separate handling)', () => {
    const calendarText = '## 日历\n- 今日评审计划\n- 明日用户手动重启 dsh'
    const out = filterMemoryLayers([], [context('dsh:auto-memory', calendarText)])
    expect(out.contexts).toHaveLength(1)
    expect(out.contexts[0]?.text).toBe(calendarText)
  })

  it('never rewrites the text of a surviving entry', () => {
    const sections = [section('memory:profile', '## 画像\nalpha'), section('deployment:persona', 'persona text')]
    const out = filterMemoryLayers(sections, [])
    expect(out.sections.map(s => s.text)).toEqual(['## 画像\nalpha', 'persona text'])
  })
})
