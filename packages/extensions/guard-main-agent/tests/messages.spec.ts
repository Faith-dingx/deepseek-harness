import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { sessionTexts } from '../src/messages.ts'

type FakeEvent = { type: string; seq: number; data: unknown }

function userEvent(seq: number, text: string): FakeEvent {
  return { type: 'user/message', seq, data: { content: [{ type: 'text', text }] } }
}

function assistantEvent(seq: number, text: string): FakeEvent {
  return { type: 'assistant/message', seq, data: { message: { content: [{ type: 'text', text }] } } }
}

function agentWithEvents(events: FakeEvent[]): { session: Session; events: FakeEvent[] } {
  const session = { events } as unknown as Session
  return { session, events }
}

describe('sessionTexts', () => {
  it('extracts the last user message text', () => {
    const { session } = agentWithEvents([
      userEvent(0, 'first'),
      assistantEvent(1, 'ok'),
      userEvent(2, 'second'),
    ])
    expect(sessionTexts({ session } as never).lastUserText).toBe('second')
  })

  it('extracts the last 5 rounds as user/assistant pairs', () => {
    const events = Array.from({ length: 12 }, (_, i) =>
      i % 2 === 0 ? userEvent(i, `msg-${i}`) : assistantEvent(i, `msg-${i}`))
    const texts = sessionTexts({ session: { events } } as never)
    expect(texts.lastUserText).toBe('msg-10')
    // 12 turns -> 5-round window = 10 entries; the oldest pair (msg-0/msg-1) drops.
    const lines = texts.conversationText.split('\n')
    expect(lines[0]).toBe('user: msg-2')
    expect(lines.at(-1)).toBe('assistant: msg-11')
    expect(lines).toHaveLength(10)
    expect(lines).not.toContain('user: msg-0')
    expect(lines).not.toContain('assistant: msg-1')
    expect(lines).toContain('assistant: msg-11')
  })

  it('returns empty strings for an empty session', () => {
    const texts = sessionTexts({ session: { events: [] } } as never)
    expect(texts.lastUserText).toBe('')
    expect(texts.conversationText).toBe('')
  })

  it('handles a session with only assistant messages', () => {
    const texts = sessionTexts({ session: { events: [assistantEvent(0, 'hi')] } } as never)
    expect(texts.lastUserText).toBe('')
    expect(texts.conversationText).toContain('assistant: hi')
  })

  it('bounds the total conversation text length', () => {
    const long = 'x'.repeat(2000)
    const events = [userEvent(0, long), assistantEvent(1, long)]
    const texts = sessionTexts({ session: { events } } as never)
    expect(texts.conversationText.length).toBeLessThanOrEqual(4000)
  })
})
