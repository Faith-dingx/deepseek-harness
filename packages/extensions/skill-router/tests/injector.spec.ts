import { describe, expect, it } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { interceptCatalog, type SkillCatalogSource } from '../src/injector.ts'

const ALL: { name: string; description: string }[] = [
  { name: 'skill-docs', description: 'planning & docs' },
  { name: 'skill-code', description: 'code editing' },
  { name: 'skill-search', description: 'search' },
  { name: 'skill-subagent', description: 'delegation' },
]

function catalogMessage(entries: { name: string; description: string }[]): UserMessage {
  const source: SkillCatalogSource = { kind: 'skill-catalog', form: 'catalog', entries }
  return createUserMessage({
    content: [{
      type: 'text',
      text: '<system-reminder>\n<available_skills>\n</available_skills>\n</system-reminder>',
    }],
    source,
  })
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function catalogByName(messages: UserMessage[]): SkillCatalogSource | undefined {
  const msg = messages.find(m => (m.source as { kind?: unknown }).kind === 'skill-catalog')
  return msg?.source as SkillCatalogSource | undefined
}

describe('interceptCatalog', () => {
  it('filters the catalog entries to the included set', () => {
    const messages = [userMessage('x'), catalogMessage(ALL)]
    const out = interceptCatalog(messages, ['skill-docs', 'skill-search'])
    const entries = catalogByName(out)?.entries
    expect(entries?.map(e => e.name)).toEqual(['skill-docs', 'skill-search'])
  })

  it('keeps ordering stable and drops out-of-catalog names', () => {
    const out = interceptCatalog([catalogMessage(ALL)], ['skill-docs', 'never-existed'])
    expect(catalogByName(out)?.entries.map(e => e.name)).toEqual(['skill-docs'])
  })

  it('yields an empty catalog when included is empty (fail-close)', () => {
    const out = interceptCatalog([catalogMessage(ALL)], [])
    expect(catalogByName(out)?.entries).toEqual([])
  })

  it('re-renders the available_skills block to reflect the filtered entries', () => {
    const out = interceptCatalog([catalogMessage(ALL)], ['skill-docs'])
    const msg = out.find(m => (m.source as { kind?: unknown }).kind === 'skill-catalog')
    const first = msg?.content[0]
    const text = first && first.type === 'text' ? first.text : ''
    expect(text).toContain('- `skill-docs`: planning & docs')
    expect(text).not.toContain('skill-code')
  })

  it('returns a new array and leaves the original messages untouched', () => {
    const original = [userMessage('x'), catalogMessage(ALL)]
    const out = interceptCatalog(original, ['skill-docs'])
    expect(out).not.toBe(original)
    expect(catalogByName(original)?.entries).toEqual(ALL)
  })

  it('passes through cleanly when no catalog message exists and included is empty', () => {
    const messages = [userMessage('x')]
    expect(interceptCatalog(messages, [])).toEqual([...messages])
  })
})
