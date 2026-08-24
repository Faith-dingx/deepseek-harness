/**
 * dsh-dep-align-guard: transaction-style dependency alignment guard.
 *
 * 故障一 (2026-08-24) 根因: `pnpm deploy --legacy --prod` 把 workspace state
 * （含 dev:false/production:true）写进了 source 的
 * `node_modules/.pnpm-workspace-state-v1.json`，dsh-web 下次启动时 pnpm 自动
 * `install --production` 删光 devDeps（含 lefthook）→ 根 postinstall
 * ERR_MODULE_NOT_FOUND → 崩溃死循环。
 *
 * 本插件在 host 层注册 `tools/pre-execute` + `tools/post-execute`（与
 * dsh-memory-guard / guard-main-agent 同机制，覆盖主 agent 与所有子代理），
 * 把"任何会触碰依赖的操作"当作一个事务：操作前提醒、操作后校验对齐状态，
 * 未对齐则按 agent 粒度阻断后续工具调用，直到 `CI=true pnpm install`
 * 恢复对齐。阻断状态只存在 host 内存，重启清零。
 *
 * 对齐判据（对齐 = 三者同时满足）：
 *   ① `node_modules/.pnpm-workspace-state-v1.json` 的 `settings.dev === true`
 *      （缺失/非 true 视为可疑，除非整个 node_modules 尚不存在——全新安装豁免）
 *   ② `node_modules/.bin/lefthook` 文件存在（devDeps 被删的直接证据）
 *   ③ lockfile 与 package.json 一致（`pnpm install --frozen-lockfile --dry-run`，
 *      退出码 0 为一致；退出码非 0 且 stderr 含 lockfile 过期特征为不一致；
 *      其余错误（网络/命令缺失/超时）判定为 unknown，fail-open 不据此阻断）
 *
 * @module @deepseek-ai/dsh-dep-align-guard
 */

import { spawn } from 'node:child_process'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-dep-align-guard'
export const inject = ['agents', 'tools']

/**
 * pnpm subcommands that can mutate the dependency tree / workspace state.
 * 触发条件之一：命令中出现这些子命令。
 */
export const PNPM_ACTIONS = [
  'install',
  'deploy',
  'add',
  'remove',
  'update',
  'link',
  'rebuild',
  'dedupe',
  'prune',
] as const

/**
 * Manifest / workspace-state files whose modification can change dependency
 * alignment. 触发条件之二：这些文件被 write/edit/str_replace_editor 修改。
 */
export const GUARDED_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  'node_modules/.pnpm-workspace-state-v1.json',
  'node_modules/.modules.yaml',
] as const

/** Shell tools whose `command`/`text` argument may host a pnpm invocation. */
const SHELL_TOOLS = new Set(['bash', 'terminal_send'])
/** File tools whose `file_path`/`path` argument may name a guarded manifest. */
const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

/** pnpm subcommands that run a package script instead of a dependency op. */
const SCRIPT_WORDS = new Set(['run', 'exec', 'dlx', 'x'])
/** pnpm global flags that consume the next token as their value. */
const FLAG_WITH_VALUE = new Set(['-C', '--dir', '--cwd', '-F', '--filter', '--config', '--reporter'])

/**
 * 阻断（deny）的唯一修复通道：`CI=true pnpm install`（含 --no-frozen-lockfile
 * 等常规旗标）。任何非 pnpm install 的依赖操作都不属于对齐命令。
 */
export const ALIGNMENT_REASON = '依赖未对齐，请先运行 CI=true pnpm install'
/** 告警文件路径（~/.dsh/.alerts/dep-misaligned.json）。 */
export const ALERT_FILE_NAME = 'dep-misaligned.json'

/** Plugin configuration, validated by the schemastery schema. */
export interface DepGuardConfig {
  /** 被守卫的 workspace 根目录（含 node_modules/）。默认: 继承 `DSH_WORKSPACE` 或 process.cwd()。 */
  workspaceRoot?: string
  /** 告警文件所在目录，默认 `~/.dsh/.alerts`。 */
  alertDir?: string
  /** 判据③ dry-run 超时毫秒数，默认 30000。 */
  timeoutMs?: number
  /** 是否执行判据③（lockfile 一致性 dry-run）。默认 true（重型仓库可关掉）。 */
  runLockfileCheck?: boolean
  /** 判据③ 使用的 pnpm 可执行文件。默认 `pnpm`。 */
  pnpmCommand?: string
}

export const Config: z<DepGuardConfig> = z.object({
  workspaceRoot: z.string().default(''),
  alertDir: z.string().default(''),
  timeoutMs: z.number().default(30_000),
  runLockfileCheck: z.boolean().default(true),
  pnpmCommand: z.string().default('pnpm'),
})

/** 解析后的运行时选项（不含可注入函数，全部来自 Config）。 */
export interface ResolvedOptions {
  workspaceRoot: string
  alertDir: string
  timeoutMs: number
  runLockfileCheck: boolean
  pnpmCommand: string
}

/** 被检测到的依赖操作。 */
export interface DepOperation {
  readonly kind: 'shell' | 'file'
  /** shell: pnpm 子命令；file: 被触碰的受管文件名。 */
  readonly target: string
}

/** 判据①的观察结果。 */
export type DevFlagVerdict = 'dev' | 'nondev' | 'missing'
/** 判据②的观察结果。 */
export type LefthookVerdict = 'present' | 'missing'
/** 判据③的观察结果。 */
export type LockfileVerdict = 'ok' | 'mismatch' | 'unknown' | 'skipped'

/** 一次对齐检测的原始观察。 */
export interface AlignmentProbe {
  /** node_modules 目录整体缺失（全新安装尚未发生，豁免阻断）。 */
  readonly nodeModulesAbsent: boolean
  readonly devFlag: DevFlagVerdict
  readonly lefthook: LefthookVerdict
  readonly lockfile: LockfileVerdict
}

/** 对齐检测完整报告。 */
export interface AlignmentReport extends AlignmentProbe {
  readonly aligned: boolean
  readonly details: string[]
}

/** 判据③ dry-run 的原始结果。 */
export interface DryRunResult {
  readonly ok: boolean
  readonly code: number | null
  /** 非零退出时的 stderr 尾部摘要，用于分类 mismatch / unknown。 */
  readonly stderr: string
  /** spawn 级失败（命令不存在等）。 */
  readonly error: string | null
}

/** 提醒/阻断用的上下文消息文本。 */
export function buildAlignedContext(op: DepOperation, report: AlignmentReport): string {
  return `[dsh-dep-align-guard] 依赖操作 ${op.kind === 'shell' ? 'pnpm ' : ''}${op.target} 已完成，`
    + `对齐校验通过（dev=${report.devFlag}, lefthook=${report.lefthook}, lockfile=${report.lockfile}）。`
}

export function buildMisalignedContext(op: DepOperation, report: AlignmentReport): string {
  return `[dsh-dep-align-guard] 依赖操作 ${op.kind === 'shell' ? 'pnpm ' : ''}${op.target} 完成后对齐校验未通过：`
    + `${report.details.join('；')}。后续工具调用将被拒绝，请运行 CI=true pnpm install --no-frozen-lockfile 恢复对齐，完成后自动解除阻断。`
}

/** 阻断后的 deny reason（保持 ALIGNMENT_REASON 原样，便于 agent 识别修复通道）。 */
export function buildBlockReason(since: number): string {
  return `${ALIGNMENT_REASON}（阻断时间 ${new Date(since).toISOString()}）`
}

/** 写入 ~/.dsh/.alerts/ 的告警载荷。 */
export interface AlertRecord {
  readonly timestamp: string
  readonly agent: string
  readonly tool: string
  readonly operation: string
  readonly workspaceRoot: string
  readonly devFlag: DevFlagVerdict
  readonly lefthook: LefthookVerdict
  readonly lockfile: LockfileVerdict
  readonly details: string[]
}

/**
 * 解析纯函数：从命令串里找出第一条依赖操作对应的 pnpm 子命令。
 * 关键词逐词扫描：跳过旗标（含带值的 -F/--filter/-C/--dir 等），
 * 第一个非旗标词即子命令；`run/exec/dlx/x` 前缀视为脚本调用而非依赖操作。
 */
export function detectPnpmOperation(command: string): string | null {
  return detectPnpmOperations(command)[0] ?? null
}

/**
 * pnpm 之前的 shell 命令前缀词：这些词后紧跟的仍是命令位置
 * （区别于 echo/printf 等解释性文本——那些词后的 pnpm 只是被谈论的内容）。
 */
const COMMAND_PREFIX_WORDS = new Set(['sudo', 'env', 'time', 'command', 'nohup', 'xargs'])

/**
 * 判定 `pnpm` 匹配位置是否为真实命令位置（纯词法扫描的误判修复）：
 * - 引号内（单/双）不是命令——被引号包裹的 token 是字符串/解释性文本
 * - `#` 开头的注释行整行不是命令；行内未引号 `#` 之后的内容也不是命令
 * - 段分隔符（&& / || / ; / | / ( ) / > < 等）之后到匹配点之间，只允许
 *   空白、环境变量赋值链（`VAR=...`）或命令前缀词（sudo 等）；否则 pnpm
 *   出现在普通字符串/解释性文本中（如 `echo 注意别乱跑 pnpm install`）
 */
function isPnpmAtCommandPosition(command: string, matchIndex: number): boolean {
  const lineStart = command.lastIndexOf('\n', matchIndex - 1) + 1
  const lineEnd = command.indexOf('\n', matchIndex)
  const line = command.slice(lineStart, lineEnd === -1 ? command.length : lineEnd)
  const rel = matchIndex - lineStart

  // 注释行：行首（忽略空白）即 `#`，整行不是命令。
  if (/^\s*#/.test(line)) return false

  // 引号与内联注释：扫描到匹配点，跟踪单/双引号状态（含转义）。
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < rel; i++) {
    const c = line[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      else if (c === '\\') i++ // 双引号内转义字符
      continue
    }
    if (c === '\\') { i++; continue }
    if (c === "'") inSingle = true
    else if (c === '"') inDouble = true
    else if (c === '#') return false // 内联注释：pnpm 出现在注释内容里
  }
  if (inSingle || inDouble) return false // pnpm 在引号内

  // 命令位置：最后一个段分隔符之后只允许空白 / 赋值链 / 命令前缀词。
  const head = line.slice(0, rel)
  const lastSep = Array.from(head.matchAll(/&&|\|\||[;&|()<>]/g)).at(-1)
  const chunk = lastSep === undefined ? head : head.slice(lastSep.index + lastSep[0].length)
  const words = chunk.replace(/"[^"]*"|'[^']*'/g, 'X').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  return words.every(w => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || COMMAND_PREFIX_WORDS.has(w))
}

/**
 * 解析纯函数：命令串里出现过的全部依赖操作子命令（按出现顺序）。
 * 逐词扫描前先做命令位置门控：引号内、`#` 注释（行首/内联）中、
 * 以及解释性文本（非命令位置）里的 pnpm 不参与匹配。
 */
export function detectPnpmOperations(command: string): string[] {
  const found: string[] = []
  const re = /\b(?:corepack\s+)?pnpm(?:@[^\s]+)?\b/g
  let match: RegExpExecArray | null
  while ((match = re.exec(command)) !== null) {
    if (!isPnpmAtCommandPosition(command, match.index)) continue
    const after = command.slice(match.index + match[0].length)
    const op = scanPnpmArgs(after)
    if (op !== null) found.push(op)
  }
  return found
}

/** 从 `pnpm` 出现位置之后的文本中扫描第一个子命令。 */
function scanPnpmArgs(after: string): string | null {
  const tokens = after.split(/\s+/).filter(token => token.length > 0)
  let index = 0
  while (true) {
    const token = tokens[index]
    // 词法耗尽：pnpm 后面只有旗标/空内容，没有子命令。
    if (token === undefined) return null
    // 命令链分隔符：pnpm 这一段到此为止，不再往前看。
    if (token === '&&' || token === ';' || token === '|' || token === '||' || token.startsWith('(')) return null
    if (token.startsWith('--') && token.includes('=')) {
      index += 1
      continue
    }
    if (FLAG_WITH_VALUE.has(token)) {
      index += 2
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    if (SCRIPT_WORDS.has(token)) return null
    if ((PNPM_ACTIONS as readonly string[]).includes(token)) return token
    return null
  }
}

/**
 * 解析纯函数：参数路径是否命中受管清单文件（精确路径或任意层级的
 * 后缀匹配，如 `packages/foo/package.json`）。
 */
export function detectGuardedFile(target: string): string | null {
  if (typeof target !== 'string') return null
  const normalized = posix.normalize(target.replaceAll('\\', '/').replace(/^\.\//, '')).replace(/\.\.\//g, '')
  for (const name of GUARDED_FILES) {
    if (normalized === name || normalized.endsWith(`/${name}`)) return name
  }
  return null
}

/** 从工具参数里取出路径字段（write/edit 用 file_path，str_replace_editor 用 path）。 */
function pathFieldOf(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  const candidate = typeof record.file_path === 'string' ? record.file_path : record.path
  return typeof candidate === 'string' ? candidate : undefined
}

/**
 * 解析纯函数：一次工具调用是否属于依赖操作。
 * @param exec - 工具调用（只需要 name + arguments）。
 */
export function detectDepOperation(exec: Pick<ToolExecution, 'name' | 'arguments'>): DepOperation | null {
  const args = exec.arguments
  if (SHELL_TOOLS.has(exec.name)) {
    const command = typeof args === 'object' && args !== null
      ? (args as Record<string, unknown>).command ?? (args as Record<string, unknown>).text
      : undefined
    if (typeof command === 'string') {
      const action = detectPnpmOperation(command)
      if (action !== null) return { kind: 'shell', target: action }
    }
    return null
  }
  if (FILE_TOOLS.has(exec.name)) {
    const pathArgument = pathFieldOf(args)
    if (pathArgument === undefined) return null
    const matched = detectGuardedFile(pathArgument)
    if (matched !== null) return { kind: 'file', target: matched }
  }
  return null
}

/**
 * 解析纯函数：是否为唯一合法的对齐命令（`CI=true pnpm install` 及其旗标变体）。
 * 整条命令里出现的所有 pnpm 依赖操作必须全部是 install，否则不算对齐命令
 * （避免 `CI=true pnpm install && CI=true pnpm deploy` 借道放行）。
 */
export function isAlignmentCommand(command: string): boolean {
  const hasCi = /\bCI\s*=\s*true\b/i.test(command)
  if (!hasCi) return false
  const ops = detectPnpmOperations(command)
  return ops.length > 0 && ops.every(op => op === 'install')
}

/** 按 agent 粒度取钥：exec.agent.id，缺省回退到根调用号（host 级兜底）。 */
export function agentKeyOf(exec: Pick<ToolExecution, 'agent' | 'callId' | 'rootCallId'>): string {
  if (exec.agent !== undefined) return String(exec.agent.id)
  return `no-agent:${String(exec.rootCallId)}`
}

/**
 * 解析 Config（带默认值解析）。workspaceRoot 缺省链：
 * config.workspaceRoot → DSH_WORKSPACE 环境变量 → process.cwd()。
 * alertDir 缺省链：config.alertDir → ~/.dsh/.alerts。
 */
export function resolveOptions(config: DepGuardConfig = {}): ResolvedOptions {
  const workspaceRoot = config.workspaceRoot && config.workspaceRoot.length > 0
    ? config.workspaceRoot
    : (process.env.DSH_WORKSPACE ?? process.cwd())
  const alertDir = config.alertDir && config.alertDir.length > 0
    ? config.alertDir
    : join(homedir(), '.dsh', '.alerts')
  return {
    workspaceRoot,
    alertDir,
    timeoutMs: config.timeoutMs ?? 30_000,
    runLockfileCheck: config.runLockfileCheck ?? true,
    pnpmCommand: config.pnpmCommand ?? 'pnpm',
  }
}

/**
 * 判据③：`pnpm install --frozen-lockfile --dry-run` 的原始执行。
 * 导出以便测试用 fixture pnpm 脚本直接验证 spawn 契约。
 */
export function runPnpmDryRun(
  pnpmCommand: string,
  workspaceRoot: string,
  timeoutMs: number,
): Promise<DryRunResult> {
  return new Promise<DryRunResult>((resolve) => {
    let stderr = ''
    const child = spawn(pnpmCommand, ['install', '--frozen-lockfile', '--dry-run'], {
      cwd: workspaceRoot,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: timeoutMs,
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolve({ ok: false, code: null, stderr, error: error.message })
    })
    child.on('close', (code: number | null) => {
      resolve({ ok: code === 0, code, stderr, error: null })
    })
  })
}

/** stderr 中 lockfile 过期/不一致的特征串（pnpm 报错文案）。 */
const LOCKFILE_MISMATCH_MARKERS = [
  'outdated lockfile',
  'ERR_PNPM_OUTDATED_LOCKFILE',
  'lockfile is not up to date',
  'lockfile does not match',
  'Cannot install with',
] as const

/**
 * 判据③结果分类：
 * - 退出码 0 → ok
 * - 非零且 stderr 命中 lockfile 特征 → mismatch
 * - spawn 级失败（命令不存在/超时被杀/网络等其他错误）→ unknown（fail-open，
 *   不据此阻断；①②仍是硬判据）
 */
export function classifyDryRun(result: DryRunResult): LockfileVerdict {
  if (result.ok) return 'ok'
  if (result.error !== null || result.code === null) return 'unknown'
  const stderr = result.stderr.toLowerCase()
  return LOCKFILE_MISMATCH_MARKERS.some(marker => stderr.includes(marker.toLowerCase())) ? 'mismatch' : 'unknown'
}

/**
 * 一次完整的对齐检测（判据①②③）。
 * 全部基于真实文件系统观察，导出以便测试直接驱动 fixture workspace。
 */
export async function runAlignmentCheck(options: ResolvedOptions): Promise<AlignmentReport> {
  const details: string[] = []
  const nodeModulesDir = join(options.workspaceRoot, 'node_modules')

  let nodeModulesAbsent = false
  try {
    const nodeModulesStat = await stat(nodeModulesDir)
    if (!nodeModulesStat.isDirectory()) nodeModulesAbsent = true
  } catch {
    nodeModulesAbsent = true
  }

  const devFlag: DevFlagVerdict = await probeDevFlag(nodeModulesDir)
  const lefthook: LefthookVerdict = await probeLefthook(nodeModulesDir)

  let lockfile: LockfileVerdict
  if (!options.runLockfileCheck) {
    lockfile = 'skipped'
  } else {
    const dryRun = await runPnpmDryRun(options.pnpmCommand, options.workspaceRoot, options.timeoutMs)
    lockfile = classifyDryRun(dryRun)
  }

  let aligned: boolean
  if (nodeModulesAbsent) {
    // 全新安装豁免：node_modules 尚不存在 → 无从判定，视为"未触发"（不阻断）。
    aligned = true
    details.push('node_modules 不存在（全新安装阶段，豁免阻断）')
  } else {
    if (devFlag !== 'dev') details.push(`判据① settings.dev=${devFlag}（期望 true）`)
    if (lefthook !== 'present') details.push(`判据② node_modules/.bin/lefthook=${lefthook}（期望存在）`)
    if (lockfile === 'mismatch') details.push('判据③ lockfile 与 package.json 不一致（frozen-lockfile dry-run 失败）')
    aligned = devFlag === 'dev' && lefthook === 'present' && lockfile !== 'mismatch'
  }
  return { nodeModulesAbsent, devFlag, lefthook, lockfile, aligned, details }
}

/** 判据①：读 workspace state 的 settings.dev。文件缺失/解析失败 → missing。 */
async function probeDevFlag(nodeModulesDir: string): Promise<DevFlagVerdict> {
  try {
    const text = await readFile(join(nodeModulesDir, '.pnpm-workspace-state-v1.json'), 'utf8')
    const parsed: unknown = JSON.parse(text)
    const settings = (parsed as { settings?: { dev?: unknown } } | null)?.settings
    if (settings !== undefined && typeof settings.dev === 'boolean') {
      return settings.dev ? 'dev' : 'nondev'
    }
    return 'missing'
  } catch {
    return 'missing'
  }
}

/** 判据②：node_modules/.bin/lefthook 是否存在（跟随符号链接）。 */
async function probeLefthook(nodeModulesDir: string): Promise<LefthookVerdict> {
  try {
    await access(join(nodeModulesDir, '.bin', 'lefthook'))
    return 'present'
  } catch {
    return 'missing'
  }
}

/** 当前 agent 的阻断状态（host 内存，重启清零）。 */
interface BlockState {
  readonly since: number
  readonly report: AlignmentReport
}

/** host 内存中的按 agent 阻断表。 */
export function apply(ctx: Context, config: DepGuardConfig = {}): void {
  const options: ResolvedOptions = resolveOptions(config)
  const blockedByAgent = new Map<string, BlockState>()
  const incidents: AlertRecord[] = []

  ctx.logger.info(
    `[dsh-dep-align-guard] arming workspaceRoot=${options.workspaceRoot} alertDir=${options.alertDir} `
      + `runLockfileCheck=${options.runLockfileCheck} pnpmCommand=${options.pnpmCommand}`,
  )

  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const key = agentKeyOf(exec)
    const block = blockedByAgent.get(key)
    if (block !== undefined) {
      // 已阻断：只放行唯一对齐命令，其余一律拒绝。
      if (isAlignmentCommandArg(exec)) {
        ctx.logger.warn(`[dsh-dep-align-guard] allow alignment command for blocked agent=${key}`)
        return next()
      }
      return { kind: 'deny', reason: buildBlockReason(block.since) }
    }
    const op = detectDepOperation(exec)
    if (op === null) return next()
    // 提醒前置：放行，提示"完成后将校验对齐状态"（日志 + post-execute 上下文）。
    ctx.logger.warn(
      `[dsh-dep-align-guard] 依赖操作 ${op.kind === 'shell' ? 'pnpm ' : ''}${op.target}（agent=${key}）：`
      + '完成后将校验对齐状态',
    )
    return next()
  })

  ctx.on('tools/post-execute', async (
    exec: ToolExecution,
    _result: Readonly<ToolExecutionResult>,
    next: () => Promise<PostToolDecision>,
  ): Promise<PostToolDecision> => {
    const op = detectDepOperation(exec)
    if (op === null) return next()

    const key = agentKeyOf(exec)
    const report = await runAlignmentCheck(options)
    const wasBlocked = blockedByAgent.get(key) !== undefined

    const decision = await next()

    if (report.aligned) {
      if (wasBlocked) {
        blockedByAgent.delete(key)
        ctx.logger.warn(`[dsh-dep-align-guard] 对齐恢复，解除 agent=${key} 的阻断`)
      }
      return attachContext(decision, buildAlignedContext(op, report))
    }

    // 未对齐：只有"新进入阻断"的转换才写告警（避免重复刷盘）。
    if (!wasBlocked) {
      blockedByAgent.set(key, { since: Date.now(), report })
      const record: AlertRecord = {
        timestamp: new Date().toISOString(),
        agent: key,
        tool: exec.name,
        operation: op.target,
        workspaceRoot: options.workspaceRoot,
        devFlag: report.devFlag,
        lefthook: report.lefthook,
        lockfile: report.lockfile,
        details: report.details,
      }
      incidents.push(record)
      // 告警是持久化证据，等待落盘完成（ms 级），失败仅记日志不阻断。
      try {
        await writeAlertFile(options.alertDir, incidents)
      } catch (error: unknown) {
        ctx.logger.warn(`[dsh-dep-align-guard] 写告警文件失败: ${String(error)}`)
      }
      ctx.logger.warn(`[dsh-dep-align-guard] 对齐校验未通过，阻断 agent=${key}：${report.details.join('；')}`)
    }
    return attachContext(decision, buildMisalignedContext(op, report))
  })
}

/** 已阻断 agent 的对齐命令判据：shell 命令且 isAlignmentCommand。 */
function isAlignmentCommandArg(exec: ToolExecution): boolean {
  const args = exec.arguments
  if (typeof args !== 'object' || args === null) return false
  const record = args as Record<string, unknown>
  const command = typeof record.command === 'string' ? record.command : record.text
  return typeof command === 'string' && isAlignmentCommand(command)
}

/** 把上下文消息附加到 post-execute 决策（不改变结果内容）。 */
function attachContext(decision: PostToolDecision, text: string): PostToolDecision {
  const context = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  })
  if (decision.kind !== 'accept') return decision
  const additionalContexts = decision.additionalContexts === undefined
    ? [context]
    : [...decision.additionalContexts, context]
  return { ...decision, additionalContexts }
}

/** 写入 ~/.dsh/.alerts/dep-misaligned.json（时间戳 + 全部 incident 细节）。 */
export async function writeAlertFile(alertDir: string, incidents: readonly AlertRecord[]): Promise<void> {
  await mkdir(alertDir, { recursive: true })
  const payload = {
    updatedAt: new Date().toISOString(),
    incidents,
  }
  await writeFile(join(alertDir, ALERT_FILE_NAME), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}
