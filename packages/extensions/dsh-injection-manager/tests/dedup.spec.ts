import { describe, expect, it } from 'vitest'
import type { AssembledContext, AssembledSection } from '@deepseek-ai/dsh-system-prompt'
import { dedup } from '../src/dedup.ts'

function section(name: string, text = `text:${name}`): AssembledSection {
  return { name, text }
}

function context(name: string, text = `text:${name}`): AssembledContext {
  return { name, text }
}

describe('dedup (计划 v12 T4)', () => {
  it('keeps only the first occurrence of a same-name section', () => {
    const sections = [section('memory:profile', 'first profile'), section('deployment:persona'), section('memory:profile', 'second profile')]
    const out = dedup(sections, [])
    expect(out.sections).toHaveLength(2)
    expect(out.sections.map(s => s.name)).toEqual(['memory:profile', 'deployment:persona'])
    expect(out.sections[0]?.text).toBe('first profile')
  })

  it('returns the input unchanged when there are no duplicates (same order, same texts)', () => {
    const sections = [section('deployment:persona'), section('memory:profile'), section('tool:lsp')]
    const contexts = [context('dsh:auto-memory'), context('subagent:delegation')]
    const out = dedup(sections, contexts)
    expect(out.sections).toEqual(sections)
    expect(out.contexts).toEqual(contexts)
  })

  it('dedups contexts independently', () => {
    const contexts = [context('dsh:auto-memory', 'first'), context('subagent:delegation'), context('dsh:auto-memory', 'second')]
    const out = dedup([], contexts)
    expect(out.contexts).toHaveLength(2)
    expect(out.contexts.map(c => c.name)).toEqual(['dsh:auto-memory', 'subagent:delegation'])
    expect(out.contexts[0]?.text).toBe('first')
  })

  it('does not treat a section and a context with the same name as duplicates', () => {
    const sections = [section('shared-name')]
    const contexts = [context('shared-name')]
    const out = dedup(sections, contexts)
    expect(out.sections).toHaveLength(1)
    expect(out.contexts).toHaveLength(1)
  })

  it('never merges or appends content of duplicate entries (no hash, no merge)', () => {
    const sections = [section('memory:project', 'A'), section('memory:project', 'B'), section('memory:project', 'C')]
    const out = dedup(sections, [])
    expect(out.sections).toHaveLength(1)
    expect(out.sections[0]?.text).toBe('A') // first wins wholesale; B and C are gone, not concatenated
  })

  it('keeps stable order for distinct names', () => {
    const sections = [section('zeta'), section('alpha'), section('mid')]
    const out = dedup(sections, [])
    expect(out.sections.map(s => s.name)).toEqual(['zeta', 'alpha', 'mid'])
  })
})
