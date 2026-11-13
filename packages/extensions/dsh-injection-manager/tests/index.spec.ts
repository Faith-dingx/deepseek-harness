/**
 * End-to-end integration for the dsh-injection-manager assemble pipeline.
 *
 * Assembles a real cordis Context with the real SystemPrompt and Tools
 * services and the plugin, then fires the same `system-prompt/assemble`
 * waterfall the agent loop runs per model step (计划 v12 T1/T5). Scenarios
 * follow the plan's acceptance criteria: the memory-tool cut, memory-layer
 * filtering on assembly.sections + assembly.contexts, minimal dedup, and
 * fail-open.
 *
 * 0.2.2-rc.2 moved the tool cut: the `system-prompt/assemble` waterfall
 * carries a `PromptPresentation` without the tool declarations (they are
 * attached to the returned `PromptAssembly` after the waterfall resolves), so
 * the cut is applied through the tool registry's per-scope visibility
 * (`tools.restrict({ deny })`) on the agent's own scope. The cut tests
 * therefore drive the registry, and the waterfall tests cover the
 * sections/contexts transforms.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { type AssembledSection, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as injectionManager from '../src/index.ts'
import { READ_ONLY_TOOLS, WRITE_TOOLS_TO_CUT } from '../src/config.ts'

function tool(name: string): ToolSchema {
  return { name, description: `tool ${name}`, parameters: {} }
}

function section(name: string, text = `text:${name}`): AssembledSection {
  return { name, text }
}

/** 5 read + 10 write memory tools, exactly the fixed sets of 计划 v12 决策1. */
function memoryTools(): ToolSchema[] {
  return [...READ_ONLY_TOOLS, ...WRITE_TOOLS_TO_CUT].map(tool)
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // An executor must exist before any assembly: the tools provider describes
  // the registry through it.
  ctx.tools.setExecutor({
    describe: (definitions: readonly { name: string; description?: string; parameters?: unknown }[]) => ({
      schemas: definitions.map(definition => ({
        name: definition.name,
        description: definition.description ?? '',
        parameters: definition.parameters ?? {},
      })),
    }),
    execute: async () => ({}),
  } as never)
  await ctx.plugin(injectionManager)
  return ctx
}

/**
 * Register the memory tools in the real tool registry and give the services an
 * executor, so the registry can describe them the way the agent loop does.
 */
function registerMemoryTools(ctx: Context): void {
  for (const definition of memoryTools()) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ output: 'ok' }),
      output: { schema: { type: 'object' }, render: (value: unknown) => String(value) },
    } as never)
  }
}

/**
 * Emulate one agent: a scope keyed by the agent itself, created from a ctx
 * that resolves `tools` — exactly how agent-loop builds `agent.ctx`.
 */
function agentScope(ctx: Context, agent: object): { ctx: Context; scope: { dispose(): Promise<void> } } {
  const toolsCtx = ctx.plugin({ inject: ['tools'], apply() {} } as never, {} as never).ctx
  const scope = createScope(toolsCtx as never, agent)
  return { ctx: scope.ctx, scope }
}

describe('dsh-injection-manager system-prompt/assemble (计划 v12 T5)', () => {
  it('cuts the 10 write tools from an agent assembly, keeps the 5 read tools + unrelated tools, keeps short-term memory sections/contexts, drops long-term memory', async () => {
    const ctx = await setup()
    registerMemoryTools(ctx)
    // NOTE: 'deployment:persona' + 'harness:identity' are registered by the
    // SystemPrompt service itself; registering them again would throw.
    ctx.systemPrompt.section({ name: 'memory:profile', order: 50, text: 'profile text' })
    ctx.systemPrompt.section({ name: 'memory:standing', order: 51, text: 'standing text' })
    ctx.systemPrompt.section({ name: 'memory:future-snapshot', order: 52, text: 'long-term memory, must not be injected' })
    ctx.systemPrompt.section({ name: 'tool:lsp', order: 112, text: 'lsp guidance' })
    ctx.systemPrompt.context({ name: 'dsh:auto-memory', order: 10000, text: '## 日历\n- 今日评审' })

    const agent = { id: 'agent-1' }
    const agentCtx = agentScope(ctx, agent).ctx
    // The plugin applies the cut on agent creation.
    ctx.emit('agent/created', { agent: { id: agent.id, ctx: agentCtx } as never, source: 'fresh' } as never)

    const assembly = await ctx.systemPrompt.assemble({ scope: agent })

    // ③ tools: 10 write cut, 5 read + unrelated remain.
    const names = assembly.tools.map(t => t.name)
    for (const write of WRITE_TOOLS_TO_CUT) expect(names).not.toContain(write)
    for (const read of READ_ONLY_TOOLS) expect(names).toContain(read)

    // ② sections: short-term memory + non-memory survive, long-term memory dropped.
    expect(assembly.sections.map(s => s.name).sort()).toEqual([
      'deployment:persona-prefix',
      'deployment:persona-suffix',
      'harness:identity',
      'memory:profile',
      'memory:standing',
      'tool:lsp',
    ])

    // contexts: the short-term auto-memory context survives with its text (calendar covered inside).
    expect(assembly.contexts).toEqual([{ name: 'dsh:auto-memory', text: '## 日历\n- 今日评审' }])
  })

  it('leaves the global tool registry intact: the cut is per-agent', async () => {
    const ctx = await setup()
    registerMemoryTools(ctx)

    const agent = { id: 'agent-2' }
    const agentCtx = agentScope(ctx, agent).ctx
    ctx.emit('agent/created', { agent: { id: agent.id, ctx: agentCtx } as never, source: 'fresh' } as never)

    const agentAssembly = await ctx.systemPrompt.assemble({ scope: agent })
    for (const write of WRITE_TOOLS_TO_CUT) expect(agentAssembly.tools.map(t => t.name)).not.toContain(write)

    // The global registry keeps every tool — introspection and the separate
    // write-entry plugin must still see them.
    const globalNames = ctx.tools.schemas().map(t => t.name)
    for (const write of WRITE_TOOLS_TO_CUT) expect(globalNames).toContain(write)
  })

  it('dedups a same-name section pushed by a downstream assemble listener', async () => {
    const ctx = await setup()
    ctx.systemPrompt.section({ name: 'memory:profile', order: 50, text: 'first profile' })
    // Registered after the plugin -> runs INSIDE the waterfall, after the manager.
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const result = await next()
      result.sections.push(section('memory:profile', 'duplicate pushed downstream'))
      return result
    })

    const assembly = await ctx.systemPrompt.assemble({})
    const profiles = assembly.sections.filter(s => s.name === 'memory:profile')
    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.text).toBe('first profile')
  })

  it('fail-open: when a downstream listener throws, returns the original assembly with every injection intact', async () => {
    const ctx = await setup()
    ctx.systemPrompt.section({ name: 'memory:profile', order: 50, text: 'profile text' })
    ctx.on('system-prompt/assemble', async () => {
      throw new Error('downstream exploded')
    })

    const assembly = await ctx.systemPrompt.assemble({})
    // The original (pre-transformation) assembly is returned: nothing was dropped.
    expect(assembly.sections.map(s => s.name).sort()).toEqual(['deployment:persona-prefix', 'deployment:persona-suffix', 'harness:identity', 'memory:profile'])
  })

  it('fail-open: a malformed downstream assembly is returned unchanged instead of crashing the step', async () => {
    const ctx = await setup()
    const warnings: unknown[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof ctx.logger.warn
    ctx.on('system-prompt/assemble', async (_assembly, _context, _next) => {
      // A broken listener (buggy plugin) hands back a non-conforming assembly.
      return { sections: undefined, contexts: [], variables: {} } as unknown as PromptAssembly
    })

    const assembly = await ctx.systemPrompt.assemble({})
    expect((assembly as { sections?: unknown }).sections).toBeUndefined() // untouched fail-open result
    expect(warnings.some(w => String(w).includes('dsh-injection-manager'))).toBe(true)
    expect(warnings.some(w => String(w).includes('fail-open'))).toBe(true)
  })

  it('does not require any agent context: the same static rule applies to every assembly (global, sub/root agents alike)', async () => {
    const ctx = await setup()
    ctx.systemPrompt.section({ name: 'memory:profile', order: 50, text: 'profile text' })
    // No agent, no session, no scope: pure assembly path that sub-agent scopes reuse.
    const assembly = await ctx.systemPrompt.assemble({})
    expect(assembly.sections.map(s => s.name)).toContain('memory:profile')
    expect(assembly.sections.map(s => s.name)).not.toContain('memory:future-snapshot')
  })
})
