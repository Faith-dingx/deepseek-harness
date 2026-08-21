/**
 * End-to-end integration for the dsh-injection-manager assemble pipeline.
 *
 * Assembles a real cordis Context with the real SystemPrompt service and the
 * plugin, then fires the same `system-prompt/assemble` waterfall the agent
 * loop runs per model step (计划 v12 T1/T5). Scenarios follow the plan's
 * acceptance criteria: tool cut on assembly.tools, memory-layer filtering on
 * assembly.sections + assembly.contexts, minimal dedup, and fail-open.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { type AssembledSection, type PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
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
  await ctx.plugin(injectionManager)
  return ctx
}

describe('dsh-injection-manager system-prompt/assemble (计划 v12 T5)', () => {
  it('cuts the 10 write tools, keeps 5 read tools + unrelated tools, keeps short-term memory sections/contexts, drops long-term memory', async () => {
    const ctx = await setup()
    // NOTE: 'deployment:persona' + 'harness:identity' are registered by the
    // SystemPrompt service itself; registering them again would throw.
    ctx.systemPrompt.section({ name: 'memory:profile', order: 50, text: 'profile text' })
    ctx.systemPrompt.section({ name: 'memory:standing', order: 51, text: 'standing text' })
    ctx.systemPrompt.section({ name: 'memory:future-snapshot', order: 52, text: 'long-term memory, must not be injected' })
    ctx.systemPrompt.section({ name: 'tool:lsp', order: 112, text: 'lsp guidance' })
    ctx.systemPrompt.context({ name: 'dsh:auto-memory', order: 10000, text: '## 日历\n- 今日评审' })
    ctx.systemPrompt.tools(() => ({ schemas: [...memoryTools(), tool('read'), tool('grep'), tool('bash')] }))

    const assembly = await ctx.systemPrompt.assemble({})

    // ③ tools: 10 write cut, 5 read + unrelated remain (orderTools sorts lexicographically).
    expect(assembly.tools.map(t => t.name).sort()).toEqual(
      [...READ_ONLY_TOOLS, 'read', 'grep', 'bash'].sort(),
    )

    // ② sections: short-term memory + non-memory survive, long-term memory dropped.
    expect(assembly.sections.map(s => s.name).sort()).toEqual([
      'deployment:persona',
      'harness:identity',
      'memory:profile',
      'memory:standing',
      'tool:lsp',
    ])

    // contexts: the short-term auto-memory context survives with its text (calendar covered inside).
    expect(assembly.contexts).toEqual([{ name: 'dsh:auto-memory', text: '## 日历\n- 今日评审' }])
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
    ctx.systemPrompt.tools(() => ({ schemas: memoryTools() }))
    ctx.on('system-prompt/assemble', async () => {
      throw new Error('downstream exploded')
    })

    const assembly = await ctx.systemPrompt.assemble({})
    // The original (pre-transformation) assembly is returned: nothing was cut or dropped.
    expect(assembly.tools.map(t => t.name).sort()).toEqual(memoryTools().map(t => t.name).sort())
    expect(assembly.sections.map(s => s.name).sort()).toEqual(['deployment:persona', 'harness:identity', 'memory:profile'])
  })

  it('fail-open: a malformed downstream assembly is returned unchanged instead of crashing the step', async () => {
    const ctx = await setup()
    const warnings: unknown[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(message) }) as typeof ctx.logger.warn
    ctx.on('system-prompt/assemble', async (_assembly, _context, _next) => {
      // A broken listener (buggy plugin) hands back a non-conforming assembly.
      return { sections: undefined, contexts: [], tools: [], variables: {} } as unknown as PromptAssembly
    })

    const assembly = await ctx.systemPrompt.assemble({})
    expect((assembly as { sections?: unknown }).sections).toBeUndefined() // untouched fail-open result
    expect(warnings.some(w => String(w).includes('dsh-injection-manager'))).toBe(true)
    expect(warnings.some(w => String(w).includes('fail-open'))).toBe(true)
  })

  it('does not require any agent context: the same static rule applies to every assembly (global, sub/root agents alike)', async () => {
    const ctx = await setup()
    ctx.systemPrompt.section({ name: 'memory:profile', order: 50, text: 'profile text' })
    ctx.systemPrompt.tools(() => ({ schemas: memoryTools() }))
    // No agent, no session, no scope: pure assembly path that sub-agent scopes reuse.
    const assembly = await ctx.systemPrompt.assemble({})
    const names = assembly.tools.map(t => t.name)
    for (const write of WRITE_TOOLS_TO_CUT) expect(names).not.toContain(write)
    for (const read of READ_ONLY_TOOLS) expect(names).toContain(read)
  })
})
