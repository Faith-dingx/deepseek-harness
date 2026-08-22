/**
 * Integration tests for the conversation-summary injection hook (计划 v18
 * §4.2.5 / T15): the missing link that turns a compression-produced
 * conversationsummary-latest.md into the `dsh:conversation-summary` runtime
 * context on every real system-prompt assembly.
 *
 * Mounts the real Cordis Context with the real SystemPrompt service + the
 * memory-manager plugin, then fires the same `system-prompt/assemble` waterfall
 * the agent loop runs per model step. Assertions:
 *   (a) summary file present → the dsh:conversation-summary context is injected
 *       with text equal to the file content (and survives into the rendered
 *       runtime-context snapshot);
 *   (b) file missing / empty / unreadable / no fs → silent skip, no throw
 *       (fail-open at every stage).
 */

import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, {
  renderContextSnapshot,
  type AssembleContext,
  type PromptAssembly,
} from '@deepseek-ai/dsh-system-prompt'
import { apply, assemblyWorkspace, createRealFs, injectConversationSummary } from '../src/index.ts'
import { resolveMemoryPaths } from '../src/config.ts'
import { CONVERSATION_SUMMARY_CONTEXT } from '../src/history-compressor/inject.ts'

const tmpRoot = '/home/dingx/DSF-work/.temp/dsh-memory-manager-inject'
const ws = `${tmpRoot}/ws`
const home = `${tmpRoot}/home`

const paths = resolveMemoryPaths(ws, home)

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

async function resetWorkspace(): Promise<void> {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.mkdir(`${ws}/.dsh-memory`, { recursive: true })
}

/** Mount systemPrompt + the plugin (host layer), returning the plugin fiber. */
async function setup(): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  const fiber = await ctx.plugin(apply, { pollIntervalMs: 60000 } as const)
  return { ctx, fiber }
}

/** The per-turn assemble context: the agent's session workspace. */
function assembleContext(cwd: string): AssembleContext {
  return { agent: { session: { header: { cwd } } } } as unknown as AssembleContext
}

function summaryContext(assembly: PromptAssembly): { name: string; text: string } | undefined {
  return assembly.contexts.find(context => context.name === CONVERSATION_SUMMARY_CONTEXT)
}

describe('dsh:conversation-summary injection (计划 v18 §4.2.5 / T15)', () => {
  it('injects the summary file content as the dsh:conversation-summary context segment', async () => {
    await resetWorkspace()
    const summaryText = `# 对话历史摘要
> 覆盖范围：第 3-8 轮
## Primary Request
- 修复注入 bug
## Key Concepts
- assemble 瀑布
`
    await fs.writeFile(paths.summaryFile, summaryText, 'utf8')
    const { ctx, fiber } = await setup()
    try {
      const assembly = await ctx.systemPrompt.assemble(assembleContext(ws))
      // 段名与白名单一致; 文本等于文件内容
      expect(summaryContext(assembly)).toEqual({
        name: CONVERSATION_SUMMARY_CONTEXT,
        text: summaryText.trim(),
      })
      // 注入段进入渲染后的运行时上下文快照（模型实际可见）
      expect(renderContextSnapshot(assembly)).toContain('修复注入 bug')
    } finally {
      await fiber.dispose()
    }
  })

  it('silently skips when the summary file is missing (fail-open, no throw)', async () => {
    await resetWorkspace()
    const { ctx, fiber } = await setup()
    try {
      const assembly = await ctx.systemPrompt.assemble(assembleContext(ws))
      expect(summaryContext(assembly)).toBeUndefined()
      expect(assembly.contexts).toEqual([])
      expect(renderContextSnapshot(assembly)).toBe('')
    } finally {
      await fiber.dispose()
    }
  })

  it('skips an empty (whitespace-only) summary file', async () => {
    await resetWorkspace()
    await fs.writeFile(paths.summaryFile, '  \n\t\n', 'utf8')
    const { ctx, fiber } = await setup()
    try {
      const assembly = await ctx.systemPrompt.assemble(assembleContext(ws))
      expect(summaryContext(assembly)).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('fail-open: a downstream assemble listener throwing returns the original assembly (summary stays absent, no crash)', async () => {
    await resetWorkspace()
    const { ctx, fiber } = await setup()
    // 注册在插件之后 → 位于瀑布下游, 抛错模拟故障插件
    ctx.on('system-prompt/assemble', async () => {
      throw new Error('downstream exploded')
    })
    try {
      const assembly = await ctx.systemPrompt.assemble(assembleContext(ws))
      expect(summaryContext(assembly)).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('injectConversationSummary: unreadable file degrades to the untouched assembly', async () => {
    await resetWorkspace()
    const broken = {
      async readFile() { throw new Error('EIO') },
      async writeFile() {},
      async mkdir() {},
    }
    const assembly: PromptAssembly = { sections: [], contexts: [], tools: [], variables: {} }
    const out = await injectConversationSummary(assembly, assembleContext(ws), { home, fsImpl: broken })
    expect(out).toBe(assembly)
  })

  it('injectConversationSummary: absent fs degrades to the untouched assembly (default readFile fail-open)', async () => {
    await resetWorkspace()
    const assembly: PromptAssembly = { sections: [], contexts: [], tools: [], variables: {} }
    const out = await injectConversationSummary(assembly, assembleContext(ws), { home })
    expect(out).toBe(assembly)
  })

  it('injectConversationSummary keeps existing contexts and appends the summary', async () => {
    await resetWorkspace()
    await fs.writeFile(paths.summaryFile, '摘要行', 'utf8')
    const existing: PromptAssembly = {
      sections: [],
      contexts: [{ name: 'subagent:delegation', text: '任务' }],
      tools: [],
      variables: {},
    }
    const out = await injectConversationSummary(existing, assembleContext(ws), { home, fsImpl: createRealFs() })
    expect(out).not.toBe(existing)
    expect(out.contexts).toEqual([
      { name: 'subagent:delegation', text: '任务' },
      { name: CONVERSATION_SUMMARY_CONTEXT, text: '摘要行' },
    ])
  })

  it('assemblyWorkspace resolves the agent session cwd or falls back to process.cwd()', async () => {
    expect(assemblyWorkspace(assembleContext('/tmp/ws-x'))).toBe('/tmp/ws-x')
    expect(assemblyWorkspace({})).toBe(process.cwd())
    expect(assemblyWorkspace({ agent: { session: { header: {} } } } as unknown as AssembleContext)).toBe(process.cwd())
  })
})
