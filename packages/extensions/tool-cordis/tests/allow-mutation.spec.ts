import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

/**
 * allowMutation config gate (P2 主 agent 工具面收敛 Task 1):
 * with allowMutation=false only the three cordis_inspect_* read-only tools are
 * registered and the mutation-teaching system prompt is omitted; default / true
 * keeps all 7 tools (backward compatible). Uses a minimal mocked Context — the
 * tool executions themselves are never invoked, only registration side effects.
 */

const INSPECT_TOOLS = ['cordis_inspect_list', 'cordis_inspect_query', 'cordis_inspect_self']
const MUTATION_TOOLS = ['cordis_define', 'cordis_run', 'cordis_stop', 'cordis_undefine']

interface MockCtx {
  ctx: Context
  registeredTools: string[]
  sections: Array<{ name: string; text: string }>
  inspectProviderIds: string[]
}

function mockCtx(): MockCtx {
  const registeredTools: string[] = []
  const sections: Array<{ name: string; text: string }> = []
  const inspectProviderIds: string[] = []
  const ctx = {
    systemPrompt: {
      section: (section: { name: string; text: string }): void => { sections.push(section) },
    },
    tools: {
      register: (tool: { name: string }): void => { registeredTools.push(tool.name) },
    },
    effect: (fn: () => void): (() => void) => { fn(); return () => {} },
    cordisInspect: {
      register: (provider: { manifest: { id: string } }): void => { inspectProviderIds.push(provider.manifest.id) },
      list: (): unknown[] => [],
    },
    dynamicCordisRunner: {},
    on: (): void => {},
  } as unknown as Context
  return { ctx, registeredTools, sections, inspectProviderIds }
}

describe('tool-cordis allowMutation config gate', () => {
  it('default (no config) registers all 7 tools and injects the mutation prompt section', () => {
    const { ctx, registeredTools, sections } = mockCtx()
    apply(ctx)
    expect(registeredTools).toHaveLength(7)
    for (const name of [...INSPECT_TOOLS, ...MUTATION_TOOLS]) {
      expect(registeredTools).toContain(name)
    }
    expect(sections).toHaveLength(1)
    expect(sections[0]?.name).toBe('tool:cordis')
  })

  it('allowMutation=false registers only the 3 inspect tools and omits the prompt', () => {
    const { ctx, registeredTools, sections } = mockCtx()
    apply(ctx, { allowMutation: false })
    expect(registeredTools).toHaveLength(3)
    for (const name of INSPECT_TOOLS) {
      expect(registeredTools).toContain(name)
    }
    for (const name of MUTATION_TOOLS) {
      expect(registeredTools).not.toContain(name)
    }
    expect(sections).toHaveLength(0)
  })

  it('allowMutation=true explicitly keeps all 7 tools (backward compatible)', () => {
    const { ctx, registeredTools, sections } = mockCtx()
    apply(ctx, { allowMutation: true })
    expect(registeredTools).toHaveLength(7)
    for (const name of [...INSPECT_TOOLS, ...MUTATION_TOOLS]) {
      expect(registeredTools).toContain(name)
    }
    expect(sections).toHaveLength(1)
  })

  it('read-only inspect providers still register when mutation is disabled', () => {
    const { ctx, inspectProviderIds } = mockCtx()
    apply(ctx, { allowMutation: false })
    expect(inspectProviderIds.length).toBeGreaterThan(0)
    expect(inspectProviderIds).toContain('Service')
    expect(inspectProviderIds).toContain('Tool')
  })
})
