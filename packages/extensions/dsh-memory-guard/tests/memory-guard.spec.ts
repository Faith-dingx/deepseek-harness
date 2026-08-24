/**
 * Integration tests for dsh-memory-guard: the tools/pre-execute gate over
 * memory tool payloads containing bare `{{` / `}}` literals.
 *
 * Assembles a real cordis Context (SystemPrompt + ToolRuntime + AgentRegistry)
 * with the plugin and drives `tools/pre-execute` via ctx.waterfall, exactly
 * like the guard-main-agent spec.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import * as memoryGuard from '../src/index.ts'

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(memoryGuard, config)
  return ctx
}

/** Dispatch one pre-execute pass and return decision + next-call count. */
async function preExecute(
  ctx: Context,
  name: string,
  args: unknown,
): Promise<{ kind: string; reason?: string; nextCalls: number }> {
  const exec = {
    token: Symbol('exec'),
    callId: CallId('memory-guard-call'),
    rootCallId: CallId('memory-guard-call'),
    name,
    arguments: args,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
  let nextCalls = 0
  const decision = await ctx.waterfall(
    ctx as never,
    'tools/pre-execute',
    exec,
    () => { nextCalls += 1; return Promise.resolve({ kind: 'allow' as const }) },
  )
  return { ...decision, nextCalls }
}

describe('dsh-memory-guard (tools/pre-execute)', () => {
  it('放行: memory_log payload 干净（无花括号）', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory_log', { note: '完成 config-ui 中文化，重启服务生效' })
    expect(nextCalls).toBe(1)
  })

  it('拒绝: memory_log payload 含裸 {{commit}}（故障二形状）', async () => {
    const ctx = await setup()
    const { kind, reason, nextCalls } = await preExecute(ctx, 'memory_log', {
      note: 'commit 占位符已生效',
      extra: '详见 {{commit}} 说明',
    })
    expect(kind).toBe('deny')
    expect(reason).toContain('记忆禁止写')
    expect(reason).toContain('{{commit}}')
    expect(reason).toContain('extra')
    expect(nextCalls).toBe(0)
  })

  it('拒绝: memory_note 含单侧花括号 {{ (不完整模板)', async () => {
    const ctx = await setup()
    const { kind, reason } = await preExecute(ctx, 'memory_note', { action: 'append', content: '模板开始 {{ 后面还有内容' })
    expect(kind).toBe('deny')
    expect(reason).toContain('记忆禁止写')
  })

  it('放行: 反引号包裹的 `{{commit}}` 是合法转义形式', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory_log', { note: '描述占位符用 `{{commit}}` 包住即可' })
    expect(nextCalls).toBe(1)
  })

  it('放行: 嵌套对象 payload 干净时不被 JSON 结构性括号误拦', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory_user', {
      action: 'append',
      content: { body: ['第一行完全干净', { key: '第二行也干净' }] },
    })
    expect(nextCalls).toBe(1)
  })

  it('放行: 非记忆工具不受影响', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'read', { file_path: '/tmp/x.md' })
    expect(nextCalls).toBe(1)
  })

  it('放行(默认): 只读工具 memory_recall 含 {{commit}} 不落盘', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory_recall', { query: 'commit 故障' })
    expect(nextCalls).toBe(1)
  })

  it('拒绝: includeReadOnlyTools=true 时只读查询也拦截', async () => {
    const ctx = await setup({ includeReadOnlyTools: true })
    const { kind, reason } = await preExecute(ctx, 'memory_recall', { query: '{{commit}} 故障' })
    expect(kind).toBe('deny')
    expect(reason).toContain('记忆禁止写')
    expect(reason).toContain('query')
  })

  it('放行: memory 工具只读 action (read)', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory', { action: 'read', which: 'memory' })
    expect(nextCalls).toBe(1)
  })

  it('拒绝: memory 工具写 action (add) 含裸字面量', async () => {
    const ctx = await setup()
    const { kind, reason } = await preExecute(ctx, 'memory', { action: 'add', content: '不要把 {{model}} 写进来' })
    expect(kind).toBe('deny')
    expect(reason).toContain('记忆禁止写')
    expect(reason).toContain('content')
  })

  it('拒绝: 深层嵌套字段也能定位路径', async () => {
    const ctx = await setup()
    const { kind, reason } = await preExecute(ctx, 'memory_user', {
      action: 'append',
      content: { body: ['规则：禁止裸 {{x}} 字面量', '第二行 {{y}}'] },
    })
    expect(kind).toBe('deny')
    expect(reason).toContain('content.body[0]')
    expect(reason).toContain('{{x}}')
    expect(reason).toContain('{{y}}')
  })

  it('拒绝: 未闭合反引号后的裸 {{commit}} 不漏检（fail-safe）', async () => {
    const ctx = await setup()
    // 单个反引号未闭合 → 后续裸 {{commit}} 不能借"反引号内"逃逸
    const { kind, nextCalls } = await preExecute(ctx, 'memory_log', {
      note: '详见 `commit 或 {{commit}} 写法',
    })
    expect(kind).toBe('deny')
    expect(nextCalls).toBe(0)
  })

  it('放行: 成对反引号内的 {{commit}} 仍是合法转义', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory_log', {
      note: '正确写法是 `{{commit}}` 包住',
    })
    expect(nextCalls).toBe(1)
  })

  it('放行: 正常代码含 }} 不误杀（如 foo({a:{b:1}})）', async () => {
    const ctx = await setup()
    const { nextCalls } = await preExecute(ctx, 'memory_log', {
      note: '调试代码 foo({a:{b:1}}) 已通过',
    })
    expect(nextCalls).toBe(1)
  })

  it('拒绝: 单侧 {{ 仍是注入入口', async () => {
    const ctx = await setup()
    const { kind, nextCalls } = await preExecute(ctx, 'memory_log', {
      note: '模板开始 {{ 后面内容',
    })
    expect(kind).toBe('deny')
    expect(nextCalls).toBe(0)
  })

  it('拒绝 reason 自身不含裸 {{...}}（防二次污染）', async () => {
    const ctx = await setup()
    const { kind, reason } = await preExecute(ctx, 'memory_log', {
      note: 'commit 占位符已生效',
      extra: '详见 {{commit}} 说明',
    })
    expect(kind).toBe('deny')
    // reason 会传给 LLM 并落盘会话文件：剔除反引号包裹片段后，
    // 剩余文本不得再出现裸 {{...}}，否则守卫拦得住写记忆、reason 本身却二次污染。
    const outside = (reason ?? '').split('`').filter((_, i) => i % 2 === 0).join('')
    expect(outside).not.toMatch(/\{\{[^{}]*\}\}/)
  })
})
