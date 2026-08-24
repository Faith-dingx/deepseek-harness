/**
 * Tests for the cordis_define HOST half of dsh-memory-guard (cordis/host.js).
 *
 * host.js is a plain-JS function body that gets pasted verbatim into a
 * cordis_define `code.host` parameter (soft-router host-runner sandbox). It is
 * a DUPLICATE of the static package logic — and duplicates drift, as proven by
 * the 2026-08-24 Bug1: the static `buildDenialReason` learned to backtick-escape
 * every `{{...}}` in the deny reason (the reason lands in the session file and
 * later re-injection would interpolate it), while this host copy kept bare
 * `{{xxx}}` / `{{commit}}` literals. This spec locks the same contract on the
 * host half so the two copies cannot drift again on this fault shape.
 *
 * Loading approach: strip the header comment, then `new Function` the
 * `return { apply(ctx) {...} }` body — the same way a host-runner executes it
 * (`(async () => {...})()`), except we keep the plain object instead.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const HOST_FILE = fileURLToPath(new URL('../cordis/host.js', import.meta.url))

/** Split text on backticks; return only the segments OUTSIDE backtick pairs. */
function unbacktickedSegments(text: string): string[] {
  return text.split('`').filter((_, i) => i % 2 === 0)
}

type HostCtx = {
  on: (evt: string, fn: (exec: unknown, next: () => unknown) => unknown) => void
  logger?: unknown
}

/** Load the host plugin object by evaluating the `return {...}` body. */
function loadHostPlugin(): { name: string; apply: (ctx: HostCtx, config?: Record<string, unknown>) => void } {
  const raw = readFileSync(HOST_FILE, 'utf8')
  // 剥掉文件头 `//` 注释块（注释里也提到 `return { ... }`，不能字符串匹配）。
  const lines = raw.split('\n')
  const firstCode = lines.findIndex((line) => {
    const t = line.trim()
    return t !== '' && !t.startsWith('//')
  })
  expect(firstCode).toBeGreaterThan(-1)
  const body = lines.slice(firstCode).join('\n')
  expect(body.startsWith('return {')).toBe(true)
  // 直接 new Function 整个 body（body 以 `return {` 开头）。
  // 注意不能用模板字符串包裹——host.js 内容本身含反引号会截断模板。
  return new Function(body)() as never
}

/** Drive one tools/pre-execute pass through the host listener. */
async function hostPreExecute(
  plugin: ReturnType<typeof loadHostPlugin>,
  name: string,
  args: unknown,
): Promise<{ kind: string; reason?: string; nextCalls: number }> {
  let listener: ((exec: unknown, next: () => unknown) => unknown) | undefined
  const ctx = {
    on: (evt: string, fn: (exec: unknown, next: () => unknown) => unknown) => {
      if (evt === 'tools/pre-execute') listener = fn
    },
  }
  plugin.apply(ctx)
  expect(listener).toBeDefined()
  let nextCalls = 0
  const decision = (await listener!({ name, arguments: args }, () => { nextCalls += 1; return { kind: 'allow' } })) as { kind: string; reason?: string }
  return { ...decision, nextCalls }
}

describe('dsh-memory-guard host half (cordis/host.js)', () => {
  it('拒绝理由不含未转义的裸 {{（Bug1 契约：re-inject 不会被二次插值）', async () => {
    const plugin = loadHostPlugin()
    const { kind, reason, nextCalls } = await hostPreExecute(plugin, 'memory_log', {
      note: '把占位符写成 {{commit}} 而不是裸字面量',
    })
    expect(kind).toBe('deny')
    expect(reason).toContain('记忆禁止写')
    expect(nextCalls).toBe(0)
    for (const segment of unbacktickedSegments(reason ?? '')) {
      expect(segment).not.toContain('{{')
    }
  })

  it('反引号包裹的 `{{commit}}` 是合法转义，不误伤', async () => {
    const plugin = loadHostPlugin()
    const { kind, nextCalls } = await hostPreExecute(plugin, 'memory_log', {
      note: '占位符用反引号包裹如 `{{commit}}`',
    })
    expect(kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })

  it('memory 工具只读 action 放行', async () => {
    const plugin = loadHostPlugin()
    const { kind, nextCalls } = await hostPreExecute(plugin, 'memory', { action: 'read' })
    expect(kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })
})
