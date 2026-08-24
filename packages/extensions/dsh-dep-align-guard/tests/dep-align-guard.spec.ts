/**
 * Integration + unit tests for dsh-dep-align-guard: the host-level
 * transaction-style dependency alignment guard over `tools/pre-execute`
 * (warn + block) and `tools/post-execute` (alignment check).
 *
 * Assembles a real cordis Context (SystemPrompt + ToolRuntime + AgentRegistry)
 * with the plugin and drives the waterfalls via ctx.waterfall, exactly like the
 * dsh-memory-guard / guard-main-agent specs. Fixture workspaces live in a
 * mkdtemp dir per suite and are removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as guard from '../src/index.ts'

let suiteRoot = ''
beforeAll(async () => {
  suiteRoot = await mkdtemp(join(tmpdir(), 'dsh-dep-align-guard-'))
})
afterAll(async () => {
  await rm(suiteRoot, { recursive: true, force: true })
})

interface WorkspaceOptions {
  /** settings.dev 值；undefined 时不写 state 文件（missing）。 */
  dev?: boolean
  /** 是否创建 node_modules/.bin/lefthook。 */
  lefthook?: boolean
  /** 是否创建 node_modules 目录本身（缺省 true，测试"全新安装豁免"传 false）。 */
  nodeModules?: boolean
}

/** 建一个 fixture workspace，返回其绝对路径。 */
async function makeWorkspace(options: WorkspaceOptions = {}): Promise<string> {
  const workspaceRoot = await mkdtemp(join(suiteRoot, 'ws-'))
  if (options.nodeModules !== false) {
    await mkdir(join(workspaceRoot, 'node_modules', '.bin'), { recursive: true })
    if (options.dev !== undefined) {
      const state = { lastValidatedTimestamp: 1, settings: { dev: options.dev, production: !options.dev } }
      await writeFile(join(workspaceRoot, 'node_modules', '.pnpm-workspace-state-v1.json'), JSON.stringify(state))
    }
    if (options.lefthook !== false) {
      await writeFile(join(workspaceRoot, 'node_modules', '.bin', 'lefthook'), '#!/bin/sh\nexit 0\n')
      await chmod(join(workspaceRoot, 'node_modules', '.bin', 'lefthook'), 0o755)
    }
  }
  return workspaceRoot
}

/** 覆写 state 文件的 settings.dev（用于阻断→解除→再阻断的转换测试）。 */
async function setDevFlag(workspaceRoot: string, dev: boolean): Promise<void> {
  const state = { lastValidatedTimestamp: Date.now(), settings: { dev, production: !dev } }
  await writeFile(join(workspaceRoot, 'node_modules', '.pnpm-workspace-state-v1.json'), JSON.stringify(state))
}

/** 造一个 fixture pnpm 可执行脚本。 */
async function makeFakePnpm(script: string): Promise<string> {
  const dir = await mkdtemp(join(suiteRoot, 'fake-pnpm-'))
  const bin = join(dir, 'pnpm')
  await writeFile(bin, script)
  await chmod(bin, 0o755)
  return bin
}

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(guard, config)
  return ctx
}

/** 派发一次 pre-execute，返回 decision + next 被调次数。 */
async function preExecute(
  ctx: Context,
  name: string,
  args: unknown,
  agentId = 'agent-a',
): Promise<{ kind: string; reason?: string; nextCalls: number }> {
  const exec = {
    token: Symbol('exec'),
    callId: CallId(`pre-${name}-${Math.random()}`),
    rootCallId: CallId('dep-align-root'),
    name,
    arguments: args,
    agent: { id: agentId } as ToolExecution['agent'],
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

/** 派发一次 post-execute（携带一个成功的工具结果）。 */
async function postExecute(
  ctx: Context,
  name: string,
  args: unknown,
  agentId = 'agent-a',
): Promise<{ kind: string; feedback?: unknown; additionalContexts?: unknown[]; nextCalls: number }> {
  const exec = {
    token: Symbol('exec'),
    callId: CallId(`post-${name}-${Math.random()}`),
    rootCallId: CallId('dep-align-root'),
    name,
    arguments: args,
    agent: { id: agentId } as ToolExecution['agent'],
    signal: new AbortController().signal,
  } as unknown as ToolExecution
  const result = {
    isError: false,
    value: { ok: true },
    content: [{ type: 'text', text: 'ok' }],
  } as unknown as ToolExecutionResult
  let nextCalls = 0
  const decision = await ctx.waterfall(
    ctx as never,
    'tools/post-execute',
    exec,
    result,
    () => { nextCalls += 1; return Promise.resolve({ kind: 'accept' as const }) },
  )
  return { ...decision, nextCalls }
}

function contextTexts(decision: { additionalContexts?: unknown[] }): string[] {
  if (decision.additionalContexts === undefined) return []
  return decision.additionalContexts.map((message) => {
    const content = (message as { content?: { type: string; text: string }[] }).content ?? []
    return content.map(block => block.text).join('\n')
  })
}

describe('detectPnpmOperation（纯函数）', () => {
  it('识别 install / deploy / add / update / -r 旗标组合', () => {
    expect(guard.detectPnpmOperation('pnpm install')).toBe('install')
    expect(guard.detectPnpmOperation('pnpm deploy --legacy --prod')).toBe('deploy')
    expect(guard.detectPnpmOperation('corepack pnpm deploy --legacy --prod')).toBe('deploy')
    expect(guard.detectPnpmOperation('pnpm --filter @deepseek-ai/dsh-core add lodash')).toBe('add')
    expect(guard.detectPnpmOperation('pnpm -r --workspace-concurrency=1 update')).toBe('update')
    expect(guard.detectPnpmOperation('pnpm --no-frozen-lockfile install')).toBe('install')
    expect(guard.detectPnpmOperation('CI=true pnpm install --no-frozen-lockfile')).toBe('install')
  })

  it('脚本调用（run/exec/dlx）与非 pnpm 命令不是依赖操作', () => {
    expect(guard.detectPnpmOperation('pnpm run build')).toBeNull()
    expect(guard.detectPnpmOperation('pnpm exec oxlint')).toBeNull()
    expect(guard.detectPnpmOperation('npm install')).toBeNull()
    expect(guard.detectPnpmOperation('ls -la')).toBeNull()
    expect(guard.detectPnpmOperation('bun install')).toBeNull()
  })

  it('未知子命令或只有旗标时不是依赖操作（scanPnpmArgs 兜底路径）', () => {
    expect(guard.detectPnpmOperation('pnpm version upgrade')).toBeNull()
    expect(guard.detectPnpmOperation('pnpm -r')).toBeNull()
    expect(guard.detectPnpmOperation('pnpm --filter @deepseek-ai/dsh-core')).toBeNull()
  })

  it('命令链分隔符（&& / 括号）终结当前 pnpm 段（scanPnpmArgs 分隔符分支）', () => {
    expect(guard.detectPnpmOperations('pnpm -r && pnpm install')).toEqual(['install'])
    expect(guard.detectPnpmOperations('pnpm (cd /tmp && pnpm add x)')).toEqual(['add'])
    expect(guard.detectPnpmOperations('pnpm && echo hi')).toEqual([])
  })

  it('命令链中多个 pnpm 操作全部识别（install && deploy）', () => {
    expect(guard.detectPnpmOperations('CI=true pnpm install && CI=true pnpm deploy --prod')).toEqual(['install', 'deploy'])
  })

  it('引号包裹、注释行、解释性文本中的 pnpm 不是依赖操作（文本误判修复）', () => {
    // 引号包裹（单/双引号）：整段被引号包住的 pnpm 命令不起作用
    expect(guard.detectPnpmOperations('echo "注意别乱跑 pnpm install"')).toEqual([])
    expect(guard.detectPnpmOperations("echo '请勿 pnpm add lodash'")).toEqual([])
    expect(guard.detectPnpmOperations('不要执行 "pnpm prune"')).toEqual([])
    expect(guard.detectPnpmOperations('先读文档 "pnpm deploy --prod" 再动手')).toEqual([])
    // 注释行（含缩进）
    expect(guard.detectPnpmOperations('# 注意别乱跑 pnpm install')).toEqual([])
    expect(guard.detectPnpmOperations('  # 修复前先 pnpm update 对齐')).toEqual([])
    // 命令内的内联注释
    expect(guard.detectPnpmOperations('echo done # 请勿 pnpm install')).toEqual([])
    // 普通字符串/解释性文本（非命令位置）
    expect(guard.detectPnpmOperations('echo 注意别乱跑 pnpm install')).toEqual([])
    // 真实命令不受影响（防过度过滤回归）
    expect(guard.detectPnpmOperations('pnpm install')).toEqual(['install'])
    expect(guard.detectPnpmOperations('echo hi && pnpm install')).toEqual(['install'])
    expect(guard.detectPnpmOperations('CI=true pnpm install --no-frozen-lockfile')).toEqual(['install'])
    expect(guard.detectPnpmOperations('echo 警告 && pnpm add x && echo ok')).toEqual(['add'])
  })
})

describe('detectDepOperation（纯函数、分支全覆盖）', () => {
  it('shell 工具：command / text / 非对象参数 / 缺命令字段各种形状', () => {
    expect(guard.detectDepOperation({ name: 'bash', arguments: { command: 'ls' } })).toBeNull()
    expect(guard.detectDepOperation({ name: 'bash', arguments: { command: 'pnpm add x' } })).toEqual({ kind: 'shell', target: 'add' })
    expect(guard.detectDepOperation({ name: 'bash', arguments: 'raw' })).toBeNull()
    expect(guard.detectDepOperation({ name: 'bash', arguments: { workdir: '/x' } })).toBeNull()
    expect(guard.detectDepOperation({ name: 'terminal_send', arguments: { text: 'pnpm prune' } })).toEqual({ kind: 'shell', target: 'prune' })
  })

  it('文件工具：file_path / path / 缺路径 / 非受管文件各种形状', () => {
    expect(guard.detectDepOperation({ name: 'write', arguments: {} })).toBeNull()
    expect(guard.detectDepOperation({ name: 'write', arguments: null })).toBeNull()
    expect(guard.detectDepOperation({ name: 'write', arguments: { file_path: 'src/a.ts' } })).toBeNull()
    expect(guard.detectDepOperation({ name: 'write', arguments: { file_path: 'package.json' } })).toEqual({ kind: 'file', target: 'package.json' })
    expect(guard.detectDepOperation({ name: 'str_replace_editor', arguments: { path: 'node_modules/.modules.yaml' } }))
      .toEqual({ kind: 'file', target: 'node_modules/.modules.yaml' })
    expect(guard.detectDepOperation({ name: 'read', arguments: { file_path: 'package.json' } })).toBeNull()
  })
})

describe('detectGuardedFile（纯函数）', () => {
  it('识别六个受管清单文件（精确与任意层级后缀）', () => {
    expect(guard.detectGuardedFile('package.json')).toBe('package.json')
    expect(guard.detectGuardedFile('./package.json')).toBe('package.json')
    expect(guard.detectGuardedFile('packages/foo/package.json')).toBe('package.json')
    expect(guard.detectGuardedFile('pnpm-lock.yaml')).toBe('pnpm-lock.yaml')
    expect(guard.detectGuardedFile('pnpm-workspace.yaml')).toBe('pnpm-workspace.yaml')
    expect(guard.detectGuardedFile('~/.npmrc')).toBe('.npmrc')
    expect(guard.detectGuardedFile('node_modules/.pnpm-workspace-state-v1.json')).toBe('node_modules/.pnpm-workspace-state-v1.json')
    expect(guard.detectGuardedFile('node_modules/.modules.yaml')).toBe('node_modules/.modules.yaml')
  })

  it('普通文件不触发', () => {
    expect(guard.detectGuardedFile('src/index.ts')).toBeNull()
    expect(guard.detectGuardedFile('docs/README.md')).toBeNull()
    expect(guard.detectGuardedFile('')).toBeNull()
    expect(guard.detectGuardedFile(undefined as unknown as string)).toBeNull()
  })
})

describe('isAlignmentCommand（纯函数）', () => {
  it('CI=true pnpm install（含旗标变体）是唯一对齐命令', () => {
    expect(guard.isAlignmentCommand('CI=true pnpm install')).toBe(true)
    expect(guard.isAlignmentCommand('CI=true pnpm install --no-frozen-lockfile --force')).toBe(true)
    expect(guard.isAlignmentCommand('env CI=true pnpm install')).toBe(true)
  })

  it('缺 CI、非 install、或混入其它依赖操作都不是对齐命令', () => {
    expect(guard.isAlignmentCommand('pnpm install')).toBe(false)
    expect(guard.isAlignmentCommand('CI=true pnpm deploy --legacy --prod')).toBe(false)
    expect(guard.isAlignmentCommand('CI=true npm install')).toBe(false)
    expect(guard.isAlignmentCommand('CI=true pnpm install && CI=true pnpm deploy')).toBe(false)
    expect(guard.isAlignmentCommand('CI=true pnpm run install')).toBe(false)
  })
})

describe('agentKeyOf（纯函数）', () => {
  it('优先 agent.id，缺省回退调用号', () => {
    const withAgent = { agent: { id: 'sess-1' }, callId: CallId('c'), rootCallId: CallId('r') } as unknown as ToolExecution
    expect(guard.agentKeyOf(withAgent)).toBe('sess-1')
    const withoutAgent = { agent: undefined, callId: CallId('c'), rootCallId: CallId('r') } as unknown as ToolExecution
    expect(guard.agentKeyOf(withoutAgent)).toBe('no-agent:r')
  })
})

describe('runPnpmDryRun + classifyDryRun（判据③）', () => {
  it('退出码 0 → ok', async () => {
    const fake = await makeFakePnpm('#!/bin/sh\nexit 0\n')
    const result = await guard.runPnpmDryRun(fake, suiteRoot, 5000)
    expect(result.ok).toBe(true)
    expect(result.code).toBe(0)
    expect(guard.classifyDryRun(result)).toBe('ok')
  })

  it('非零退出且 stderr 含 lockfile 过期特征 → mismatch', async () => {
    const fake = await makeFakePnpm('#!/bin/sh\necho "ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen-lockfile" >&2\nexit 1\n')
    const result = await guard.runPnpmDryRun(fake, suiteRoot, 5000)
    expect(result.ok).toBe(false)
    expect(guard.classifyDryRun(result)).toBe('mismatch')
  })

  it('命令不存在 → unknown（fail-open，不据此阻断）', async () => {
    const result = await guard.runPnpmDryRun(join(suiteRoot, 'no-such-pnpm'), suiteRoot, 5000)
    expect(result.error).not.toBeNull()
    expect(guard.classifyDryRun(result)).toBe('unknown')
  })

  it('超时被杀 → unknown', async () => {
    const fake = await makeFakePnpm('#!/bin/sh\nexec sleep 30\n')
    const result = await guard.runPnpmDryRun(fake, suiteRoot, 300)
    expect(result.ok).toBe(false)
    expect(result.error).toBeNull()
    expect(guard.classifyDryRun(result)).toBe('unknown')
  }, 10_000)

  it('非零退出但 stderr 无 lockfile 特征（如网络错误）→ unknown', async () => {
    const fake = await makeFakePnpm('#!/bin/sh\necho "fetch failed: ETIMEDOUT registry.npmjs.org" >&2\nexit 1\n')
    const result = await guard.runPnpmDryRun(fake, suiteRoot, 5000)
    expect(result.ok).toBe(false)
    expect(guard.classifyDryRun(result)).toBe('unknown')
  })
})

describe('resolveOptions（纯函数）', () => {
  it('空配置走完整缺省链（cwd/家目录/默认值）', () => {
    const options = guard.resolveOptions({})
    expect(options.workspaceRoot).toBe(process.env.DSH_WORKSPACE ?? process.cwd())
    expect(options.alertDir.endsWith(join('.dsh', '.alerts'))).toBe(true)
    expect(options.timeoutMs).toBe(30_000)
    expect(options.runLockfileCheck).toBe(true)
    expect(options.pnpmCommand).toBe('pnpm')
  })

  it('显式配置优先于缺省值', () => {
    const options = guard.resolveOptions({ workspaceRoot: '/w', alertDir: '/a', timeoutMs: 5, runLockfileCheck: false, pnpmCommand: 'pnpmx' })
    expect(options.workspaceRoot).toBe('/w')
    expect(options.alertDir).toBe('/a')
    expect(options.timeoutMs).toBe(5)
    expect(options.runLockfileCheck).toBe(false)
    expect(options.pnpmCommand).toBe('pnpmx')
  })
})

describe('runAlignmentCheck（对齐检测直测）', () => {
  it('node_modules 是一个普通文件（非目录）→ 视为全新安装豁免', async () => {
    const workspaceRoot = await mkdtemp(join(suiteRoot, 'ws-file-nm-'))
    await writeFile(join(workspaceRoot, 'node_modules'), 'not a directory')
    const report = await guard.runAlignmentCheck(guard.resolveOptions({ workspaceRoot, runLockfileCheck: false }))
    expect(report.nodeModulesAbsent).toBe(true)
    expect(report.aligned).toBe(true)
    expect(report.details.join('\n')).toContain('豁免')
  })
})

describe('dsh-dep-align-guard（tools/pre-execute 提醒前置）', () => {
  it('非依赖操作直接放行，无打扰', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-1'), runLockfileCheck: false })
    const { nextCalls } = await preExecute(ctx, 'read', { file_path: 'src/index.ts' })
    expect(nextCalls).toBe(1)
    const bash = await preExecute(ctx, 'bash', { command: 'ls -la' })
    expect(bash.nextCalls).toBe(1)
  })

  it('pnpm install 触发提醒但不阻断（放行）', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-2'), runLockfileCheck: false })
    const { kind, nextCalls } = await preExecute(ctx, 'bash', { command: 'pnpm install --frozen-lockfile' })
    expect(kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })

  it('write package.json 触发提醒但不阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-3'), runLockfileCheck: false })
    const { kind, nextCalls } = await preExecute(ctx, 'write', { file_path: 'package.json' })
    expect(kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })

  it('str_replace_editor 的 path 字段同样触发提醒但不阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-3b'), runLockfileCheck: false })
    const { kind, nextCalls } = await preExecute(ctx, 'str_replace_editor', { command: 'str_replace', path: 'packages/foo/pnpm-lock.yaml' })
    expect(kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })

  it('terminal_send 的 text 字段同样触发提醒但不阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-3c'), runLockfileCheck: false })
    const { kind, nextCalls } = await preExecute(ctx, 'terminal_send', { text: 'pnpm add lodash', sessionId: 's1' })
    expect(kind).toBe('allow')
    expect(nextCalls).toBe(1)
  })
})

describe('dsh-dep-align-guard（tools/post-execute 对齐检测）', () => {
  it('对齐通过：dev=true + lefthook 存在，放行并附"通过"上下文', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true, lefthook: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-4'), runLockfileCheck: false })
    const post = await postExecute(ctx, 'bash', { command: 'pnpm install' })
    expect(post.kind).toBe('accept')
    expect(post.nextCalls).toBe(1)
    expect(contextTexts(post).join('\n')).toContain('对齐校验通过')
    // 未被阻断：后续工具仍放行
    const next = await preExecute(ctx, 'bash', { command: 'pnpm add lodash' })
    expect(next.kind).toBe('allow')
    expect(next.nextCalls).toBe(1)
  })

  it('文件类依赖操作（write package.json）的对齐通过上下文（非 shell 分支）', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true, lefthook: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-4b'), runLockfileCheck: false })
    const post = await postExecute(ctx, 'write', { file_path: 'package.json' })
    expect(contextTexts(post).join('\n')).toContain('依赖操作 package.json 已完成')
    expect(contextTexts(post).join('\n')).toContain('对齐校验通过')
  })

  it('文件类依赖操作未对齐 → 阻断并附"未通过"上下文（非 shell 分支）', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false, lefthook: true })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-4c'), runLockfileCheck: false })
    const post = await postExecute(ctx, 'write', { file_path: 'package.json' })
    expect(contextTexts(post).join('\n')).toContain('依赖操作 package.json 完成后对齐校验未通过')
    const denied = await preExecute(ctx, 'bash', { command: 'ls' })
    expect(denied.kind).toBe('deny')
  })

  it('判据①失败：settings.dev=false → 阻断 + 写告警文件', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false, lefthook: true })
    const alertDir = join(suiteRoot, 'alerts-5')
    const ctx = await setup({ workspaceRoot, alertDir, runLockfileCheck: false })
    await postExecute(ctx, 'bash', { command: 'pnpm deploy --legacy --prod' })
    // 告警文件: 时间戳 + i03n 细节
    const alertText = await readFile(join(alertDir, 'dep-misaligned.json'), 'utf8')
    const payload = JSON.parse(alertText) as { updatedAt: string; incidents: Array<Record<string, unknown>> }
    expect(payload.updatedAt).toBeTruthy()
    expect(payload.incidents).toHaveLength(1)
    expect(payload.incidents[0]).toMatchObject({ agent: 'agent-a', tool: 'bash', operation: 'deploy', devFlag: 'nondev' })
    expect(payload.incidents[0]?.details).toBeTruthy()
    // 后续工具调用被阻断（除非对齐命令）
    const denied = await preExecute(ctx, 'bash', { command: 'git status' })
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('依赖未对齐')
    expect(denied.reason).toContain('CI=true pnpm install')
  })

  it('判据②失败：lefthook 缺失 → 阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true, lefthook: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-6'), runLockfileCheck: false })
    await postExecute(ctx, 'bash', { command: 'pnpm install' })
    const denied = await preExecute(ctx, 'read', { file_path: 'src/index.ts' })
    expect(denied.kind).toBe('deny')
    expect(denied.reason).toContain('依赖未对齐')
    expect(denied.reason).toContain('CI=true pnpm install')
  })

  it('state 文件存在但 dev 不是布尔值 → 判据① missing → 阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true, lefthook: true })
    await writeFile(join(workspaceRoot, 'node_modules', '.pnpm-workspace-state-v1.json'), JSON.stringify({ settings: { dev: 'yes' } }))
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-6b'), runLockfileCheck: false })
    const post = await postExecute(ctx, 'bash', { command: 'pnpm install' })
    expect(contextTexts(post).join('\n')).toContain('判据①')
    const denied = await preExecute(ctx, 'read', { file_path: 'x.md' })
    expect(denied.kind).toBe('deny')
  })

  it('告警目录不可写时仍阻断，不崩溃', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    // alertDir 指向一个已存在的普通文件 → mkdir/writeFile 必然失败
    const alertDir = join(suiteRoot, 'alerts-6c')
    await writeFile(alertDir, 'i am a file, not a dir')
    const ctx = await setup({ workspaceRoot, alertDir, runLockfileCheck: false })
    await postExecute(ctx, 'bash', { command: 'pnpm deploy --legacy --prod' })
    const denied = await preExecute(ctx, 'bash', { command: 'git status' })
    expect(denied.kind).toBe('deny')
  })

  it('下游 post-execute 已返回非 accept 决策时原样透传（不覆盖）', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-6d'), runLockfileCheck: false })
    const exec = {
      token: Symbol('exec'),
      callId: CallId(`post-passthrough-${Math.random()}`),
      rootCallId: CallId('dep-align-root'),
      name: 'bash',
      arguments: { command: 'pnpm deploy --legacy --prod' },
      agent: { id: 'agent-a' } as ToolExecution['agent'],
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    const result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] } as unknown as ToolExecutionResult
    const decision = await (ctx.waterfall(
      ctx as never,
      'tools/post-execute',
      exec,
      result,
      () => Promise.resolve({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'downstream blocked' }] }),
    ) as unknown as Promise<{ kind: string; additionalContexts?: unknown[] }>)
    expect(decision.kind).toBe('block')
    expect((decision as { additionalContexts?: unknown[] }).additionalContexts).toBeUndefined()
    // 仍应阻断（对齐未通过）
    const denied = await preExecute(ctx, 'bash', { command: 'ls' })
    expect(denied.kind).toBe('deny')
  })

  it('下游 accept 决策自带 additionalContexts 时合并追加（不覆盖）', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-6e'), runLockfileCheck: false })
    const exec = {
      token: Symbol('exec'),
      callId: CallId(`post-merge-${Math.random()}`),
      rootCallId: CallId('dep-align-root'),
      name: 'bash',
      arguments: { command: 'pnpm install' },
      agent: { id: 'agent-a' } as ToolExecution['agent'],
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    const result = { isError: false, value: { ok: true }, content: [{ type: 'text', text: 'ok' }] } as unknown as ToolExecutionResult
    const downstreamContext: UserMessage = {
      id: 'downstream-msg',
      role: 'user',
      content: [{ type: 'text', text: 'downstream context' }],
      source: { kind: 'plugin', plugin: 'downstream' },
    } as unknown as UserMessage
    const decision = await (ctx.waterfall(
      ctx as never,
      'tools/post-execute',
      exec,
      result,
      () => Promise.resolve({ kind: 'accept' as const, additionalContexts: [downstreamContext] }),
    ) as unknown as Promise<{ kind: string; additionalContexts?: unknown[] }>)
    expect(decision.kind).toBe('accept')
    const contexts = (decision as { additionalContexts?: unknown[] }).additionalContexts
    expect(contexts).toHaveLength(2)
    expect(contexts?.[0]).toBe(downstreamContext)
  })

  it('全新安装豁免：node_modules 不存在 → 视为对齐，不阻断', async () => {
    const workspaceRoot = await makeWorkspace({ nodeModules: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-7'), runLockfileCheck: false })
    // 全新仓库第一次 pnpm install
    const post = await postExecute(ctx, 'bash', { command: 'pnpm install' })
    const texts = contextTexts(post).join('\n')
    expect(texts).toContain('对齐校验通过')
    const next = await preExecute(ctx, 'bash', { command: 'pnpm add lodash' })
    expect(next.nextCalls).toBe(1)
  })

  it('判据③失败：lockfile mismatch（fixture pnpm 报过期）→ 即使 ①② 通过也阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true, lefthook: true })
    const fakePnpm = await makeFakePnpm('#!/bin/sh\necho "ERR_PNPM_OUTDATED_LOCKFILE: Cannot install with frozen-lockfile" >&2\nexit 1\n')
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-8'), runLockfileCheck: true, pnpmCommand: fakePnpm })
    const post = await postExecute(ctx, 'bash', { command: 'pnpm add lodash' })
    expect(contextTexts(post).join('\n')).toContain('判据③')
    const denied = await preExecute(ctx, 'bash', { command: 'pnpm deploy' })
    expect(denied.kind).toBe('deny')
  })

  it('判据③ unknown（命令不可用）→ fail-open，不阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: true, lefthook: true })
    const ctx = await setup({
      workspaceRoot,
      alertDir: join(suiteRoot, 'alerts-9'),
      runLockfileCheck: true,
      pnpmCommand: join(suiteRoot, 'no-such-pnpm-binary'),
    })
    const post = await postExecute(ctx, 'bash', { command: 'pnpm install' })
    expect(contextTexts(post).join('\n')).toContain('对齐校验通过')
    const next = await preExecute(ctx, 'read', { file_path: 'x.md' })
    expect(next.nextCalls).toBe(1)
  })

  it('非依赖操作的 post-execute 原样放行，不附加上下文', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-10'), runLockfileCheck: false })
    const post = await postExecute(ctx, 'read', { file_path: 'src/index.ts' })
    expect(post.nextCalls).toBe(1)
    expect(post.additionalContexts).toBeUndefined()
  })
})

describe('dsh-dep-align-guard（阻断生命周期）', () => {
  it('阻断只放行 CI=true pnpm install；其余全拒', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-11'), runLockfileCheck: false })
    await postExecute(ctx, 'bash', { command: 'pnpm install' }) // 现在处于未对齐

    const alignment = await preExecute(ctx, 'bash', { command: 'CI=true pnpm install --no-frozen-lockfile' })
    expect(alignment.kind).toBe('allow')
    expect(alignment.nextCalls).toBe(1)

    const deploy = await preExecute(ctx, 'bash', { command: 'pnpm deploy --legacy --prod' })
    expect(deploy.kind).toBe('deny')
    const readTool = await preExecute(ctx, 'read', { file_path: 'package.json' })
    expect(readTool.kind).toBe('deny')
    // 非对象参数（无 command 字段）也不是对齐命令 → 拒绝
    const rawArgs = await preExecute(ctx, 'bash', 'CI=true pnpm install')
    expect(rawArgs.kind).toBe('deny')
  })

  it('对齐命令完成后恢复对齐 → 自动解除阻断', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-12'), runLockfileCheck: false })
    await postExecute(ctx, 'bash', { command: 'pnpm deploy --legacy --prod' })
    await setDevFlag(workspaceRoot, true) // 模拟 CI=true pnpm install 修复了 state
    const post = await postExecute(ctx, 'bash', { command: 'CI=true pnpm install' })
    expect(contextTexts(post).join('\n')).toContain('对齐校验通过')
    const next = await preExecute(ctx, 'bash', { command: 'pnpm add lodash' })
    expect(next.kind).toBe('allow')
    expect(next.nextCalls).toBe(1)
  })

  it('按 agent 粒度阻断：A 被拒，B 不受影响', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const ctx = await setup({ workspaceRoot, alertDir: join(suiteRoot, 'alerts-13'), runLockfileCheck: false })
    await postExecute(ctx, 'bash', { command: 'pnpm install' }, 'agent-A')
    const deniedA = await preExecute(ctx, 'bash', { command: 'ls' }, 'agent-A')
    expect(deniedA.kind).toBe('deny')
    const allowedB = await preExecute(ctx, 'bash', { command: 'ls' }, 'agent-B')
    expect(allowedB.nextCalls).toBe(1)
  })

  it('已是阻断态时不重复写告警；再次进入阻断时 incidents 累计', async () => {
    const workspaceRoot = await makeWorkspace({ dev: false })
    const alertDir = join(suiteRoot, 'alerts-14')
    const ctx = await setup({ workspaceRoot, alertDir, runLockfileCheck: false })

    // 第一次进入阻断 → incidents 1
    await postExecute(ctx, 'bash', { command: 'pnpm install' })
    let payload = JSON.parse(await readFile(join(alertDir, 'dep-misaligned.json'), 'utf8')) as { incidents: unknown[] }
    expect(payload.incidents).toHaveLength(1)

    // 对齐命令执行但 state 仍坏 → 保持阻断，不新增 incident
    await postExecute(ctx, 'bash', { command: 'CI=true pnpm install' })
    payload = JSON.parse(await readFile(join(alertDir, 'dep-misaligned.json'), 'utf8')) as { incidents: unknown[] }
    expect(payload.incidents).toHaveLength(1)

    // 修复 → 解除阻断
    await setDevFlag(workspaceRoot, true)
    await postExecute(ctx, 'bash', { command: 'CI=true pnpm install' })

    // 再次破坏 → 第二次进入阻断 → incidents 2
    await setDevFlag(workspaceRoot, false)
    await postExecute(ctx, 'bash', { command: 'pnpm install' })
    payload = JSON.parse(await readFile(join(alertDir, 'dep-misaligned.json'), 'utf8')) as { incidents: unknown[] }
    expect(payload.incidents).toHaveLength(2)
  })
})
