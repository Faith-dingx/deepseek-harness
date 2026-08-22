/**
 * 用户授意记忆入口通道 (计划-用户授意记忆入口写入 v2 §2.2/§2.7).
 *
 * 用户/主 agent 把"用户授意要记的内容"写进入口文件
 * `<workspace>/.dsh-memory/user-entries.md`; 本模块在每次审核轮次扫描该文件,
 * 经三层防线 (guard 白名单 fail-close → validators 来源/引用/target 校验 →
 * 用户编辑触发的 mtime 变化) 确认后, 规范化写入目标记忆文件并登记审计。
 *
 * 安全红线 (fail-open, 任何异常不自动写、不误写):
 * - source ≠ user       → 静默跳过 (不写目标, 不写 pending-review, 避免污染队列)
 * - 无用户原话引用       → 标记 pending-review, 绝不写目标
 * - 非法 target/项目缺失 → 标记 pending-review
 * - 超三类内容           → 标记 pending-review
 * - 条目级独立 try/catch → 单条失败不影响其他条目 (L-9), 审计记 success=N/failed=M
 * - 同目标文件并发写锁    → 串行排队, settle 后自动清理 (M-1), 错误不静默吞给调用方
 *
 * @module dsh-memory-manager/user-entry-scanner
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { MemoryPaths } from './config.ts'
import type { PendingWriteRegistry } from './audit-pipeline/confirm.ts'
import { appendPendingReview, buildPendingReviewEntry } from './audit-pipeline/archive.ts'
import { appendAuditLine, type AuditLogEntry } from './shared/logger.ts'
import {
  parseUserEntries,
  resolveTargetPath,
  validateUserEntry,
  type ParsedUserEntry,
  type UserEntryTarget,
} from './shared/validators.ts'

/** File-system surface the scanner needs; injectable for tests. */
export interface UserEntryFs {
  readFile(file: string): Promise<string>
  writeFile(file: string, data: string): Promise<void>
  mkdir(dir: string, options?: { recursive: boolean }): Promise<void>
  stat(file: string): Promise<unknown>
}

const defaultFs: UserEntryFs = {
  async readFile(file) { return fs.readFile(file, 'utf8') },
  async writeFile(file, data) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data, 'utf8') },
  async mkdir(dir, options) { await fs.mkdir(dir, options) },
  async stat(file) { return fs.stat(file) },
}

/** 首次扫描时入口文件不存在 → 自动创建的模板 (条目格式注释, §2.7). */
const ENTRY_TEMPLATE = `# 用户授意记忆入口

此文件供用户直接编辑，插件会定期扫描并自动将条目写入对应的记忆文件。
每个条目格式：

<!-- 用户授意条目 -->
[source=user] [target=memory|user|project|log] [project=<project>] 用户说："你的原话"
- 要写入的记忆内容

target 说明：
- memory → ~/.dsh/memory/MEMORY.md（关键规则）
- user   → ~/.dsh/memory/USER.md（用户偏好）
- project → <workspace>/projects/<name>/docs/MEMORY.md（项目笔记，需目录已存在）
- log    → .dsh-memory/YYYY-MM-DD.md（工作日志）

注意事项：
- 必须包含用户原话引用（用户说："..."），否则条目会被标记为待审核
- source 字段必须为 user，其他值会被静默跳过
- target=project 时必须指定 project，且项目目录必须已存在
`

/**
 * 首次扫描时, 入口文件不存在则自动创建 (带模板注释)。已存在 → 不动。
 * 永不抛错 (fail-open): 创建失败静默返回 false, 下一轮 poll 重试。
 */
export async function initUserEntriesFile(filePath: string, fsImpl: UserEntryFs = defaultFs): Promise<boolean> {
  try {
    await fsImpl.stat(filePath)
    return false
  } catch {
    // ENOENT (或 stat 失败): 视为缺失, 创建模板
  }
  try {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true })
    await fsImpl.writeFile(filePath, ENTRY_TEMPLATE)
    return true
  } catch {
    // fail-open: 创建失败不影响主流程
    return false
  }
}

/**
 * 读取入口文件并解析全部条目。文件缺失/不可读 → 空列表 (fail-open, 绝不抛错)。
 */
export async function scanUserEntries(filePath: string, fsImpl: UserEntryFs = defaultFs): Promise<ParsedUserEntry[]> {
  let text: string
  try {
    text = await fsImpl.readFile(filePath)
  } catch {
    return []
  }
  return parseUserEntries(text)
}

/**
 * per-file 并发写入锁 (M-1): 同一目标文件的写入串行排队, 不同目标文件互不阻塞。
 * 队列槽位吞错 (只影响排队), 调用方拿到真正的执行结果 —— 错误不静默吞给调用方;
 * settle 后自动从 Map 清理 (带身份校验, 防止清理到后来者的槽位)。
 */
export class FileWriterLock {
  private readonly queues = new Map<string, Promise<void>>()

  async withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(file) ?? Promise.resolve()
    // 前一个完成后执行当前 (失败也放行, 锁不会被卡死)
    const next = previous.then(fn, fn)
    const slot = next.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.queues.get(file) === slot) this.queues.delete(file)
    })
    this.queues.set(file, slot)
    return next
  }

  /** 当前排队中的文件数 (含执行中); 测试断言 settle 后自动清理 (M-1). */
  size(): number {
    return this.queues.size
  }
}

/** 一次扫描处理的结构化结果 (L-9: success=N failed=M 的依据). */
export interface UserEntryProcessReport {
  /** 解析出的条目总数。 */
  readonly entries: number
  /** 成功写入目标记忆文件的条目数。 */
  readonly written: number
  /** source ≠ user 静默跳过的条目数。 */
  readonly skipped: number
  /** 标记 pending-review 等待用户决策的条目数。 */
  readonly queued: number
  /** 目标文件已含相同内容而跳过的条目数 (幂等去重)。 */
  readonly duplicates: number
  /** 处理失败的条目数 (写入/排队异常, 不影响其他条目)。 */
  readonly failed: number
  /** 实际写入过的目标文件 (去重)。 */
  readonly targets: readonly string[]
}

/** 扫描处理的可注入依赖 (fs/时钟/审计槽). */
export interface UserEntryProcessDeps {
  readonly paths: MemoryPaths
  readonly registry: PendingWriteRegistry
  readonly fsImpl?: UserEntryFs
  readonly now?: Date
  /** 审计目录 (默认 paths.auditDir). */
  readonly auditDir?: string
  /** 自定义审计槽 (默认 appendAuditLine). */
  readonly audit?: (dir: string, entry: AuditLogEntry) => Promise<void>
}

/** Mutable accumulator shaping {@link UserEntryProcessReport} (返回前定型). */
interface UserEntryProcessStats {
  entries: number
  written: number
  skipped: number
  queued: number
  duplicates: number
  failed: number
  targets: string[]
}

/**
 * 扫描→验证→写入→审计 全流程 (T2)。处理入口文件中变化带来的全部条目。
 *
 * 三层防线在写前的校验序列:
 * 1. guard 层 (T0): 入口文件不在白名单 → 主 agent 根本写不进来 (mtime 不变不触发)
 * 2. 来源/引用/target 校验 (validators.validateUserEntry)
 * 3. 用户编辑触发的 mtime 检测 (由 watcher 驱动本函数)
 *
 * 未确认/不合规条目进 pending-review 队列, 绝不自动写; 每条条目独立 try/catch,
 * 单条失败不影响其他条目 (L-9); 写入目标文件前注册 pendingWrite
 * (source=user-approved-entry, skipAudit=true) 防止审核管线循环 (S-5/S-1)。
 */
export async function processUserEntries(
  entryFile: string,
  deps: UserEntryProcessDeps,
): Promise<UserEntryProcessReport> {
  const paths = deps.paths
  const fsImpl = deps.fsImpl ?? defaultFs
  const now = deps.now ?? new Date()
  const auditDir = deps.auditDir ?? paths.auditDir
  const audit = deps.audit ?? ((dir: string, entry: AuditLogEntry) => appendAuditLine(dir, entry))
  const entries = await scanUserEntries(entryFile, fsImpl)
  const report: UserEntryProcessStats = {
    entries: entries.length,
    written: 0,
    skipped: 0,
    queued: 0,
    duplicates: 0,
    failed: 0,
    targets: [],
  }
  // 同目标文件的多条条目串行写入 (不同目标文件可并行, 见 FileWriterLock)
  const lock = new FileWriterLock()

  for (const entry of entries) {
    // L-9: 每条条目独立 try/catch, 单条失败不影响其他条目
    try {
      const validation = validateUserEntry(entry)
      if (validation.disposition === 'skip') {
        // 反伪造断言 1: source ≠ user → 静默跳过 (不写目标, 不写队列)
        report.skipped += 1
        await audit(auditDir, {
          time: now.toISOString(), event: 'user-entry-skipped', file: entryFile,
          detail: `line=${entry.headerLine} source=${entry.source}`,
        })
        continue
      }
      if (validation.disposition === 'pending-review') {
        await queueForReview(entryFile, entry, paths.pendingReviewFile, fsImpl, now)
        report.queued += 1
        await audit(auditDir, {
          time: now.toISOString(), event: 'user-entry-queued', file: entryFile,
          detail: `line=${entry.headerLine} issues=${validation.issues.map(i => i.code).join(',')}`,
        })
        continue
      }
      const targetFile = resolveTargetPath(entry.target as UserEntryTarget, entry.project, now, paths)
      /* v8 ignore next 3 -- validation guarantees a resolvable target on the
       * write disposition; this guard is defense-in-depth only. */
      if (targetFile === null) {
        await queueForReview(entryFile, entry, paths.pendingReviewFile, fsImpl, now)
        report.queued += 1
        continue
      }
      // M-2: project 目标必须已存在; 不存在不自动建目录, 标记 pending-review
      if (entry.target === 'project' && !(await targetExists(targetFile, fsImpl))) {
        await queueForReview(entryFile, entry, paths.pendingReviewFile, fsImpl, now)
        report.queued += 1
        await audit(auditDir, {
          time: now.toISOString(), event: 'user-entry-queued', file: entryFile,
          detail: `line=${entry.headerLine} issues=project-missing target=${targetFile}`,
        })
        continue
      }
      const outcome = await lock.withLock(targetFile, async (): Promise<'written' | 'duplicate'> => {
        // 幂等去重: 目标文件已含相同内容 → 跳过 (入口文件条目保留, 重复扫描不重复写)
        if (await targetContainsBullet(targetFile, entry.content, fsImpl)) return 'duplicate'
        // 写入目标文件前注册 pendingWrite (skipAudit=true): 审核管线识别后跳过
        // normalize/archive, 防止插件自写触发守门循环 (S-5)
        deps.registry.register(targetFile, 'user-approved-entry', now.getTime(), true)
        await appendEntryBullet(targetFile, entry.content, fsImpl, now)
        return 'written'
      })
      if (outcome === 'duplicate') {
        report.duplicates += 1
        await audit(auditDir, {
          time: now.toISOString(), event: 'user-entry-duplicate', file: targetFile,
          detail: `line=${entry.headerLine} content already present`,
        })
        continue
      }
      report.written += 1
      if (!report.targets.includes(targetFile)) report.targets.push(targetFile)
      await audit(auditDir, {
        time: now.toISOString(), event: 'user-entry-written', file: targetFile,
        detail: `line=${entry.headerLine} source=user-approved-entry skipAudit=true target=${entry.target as string}`,
      })
    } catch {
      // fail-open: 单条失败不影响其他条目; 失败条目不入 pending-review, 用户
      // 下次编辑入口文件时重新处理
      report.failed += 1
      await audit(auditDir, {
        time: now.toISOString(), event: 'user-entry-failed', file: entryFile,
        detail: `line=${entry.headerLine}`,
      })
    }
  }

  // L-9 汇总审计: success=N failed=M
  if (entries.length > 0) {
    await audit(auditDir, {
      time: now.toISOString(), event: 'user-entries-processed', file: entryFile,
      detail: `success=${entries.length - report.failed} failed=${report.failed}`,
    })
  }
  return report
}

/** 推入 pending-review 队列 (与 pending-suggestions 独立队列, 7 天 TTL 由 maintenance 清理). */
async function queueForReview(
  entryFile: string,
  entry: ParsedUserEntry,
  pendingReviewPath: string,
  fsImpl: UserEntryFs,
  now: Date,
): Promise<void> {
  await appendPendingReview(pendingReviewPath, buildPendingReviewEntry(entryFile, entry.headerLine, entry.raw, now), fsImpl)
}

/** 目标文件是否存在 (project 目标 M-2 存在性检查). */
async function targetExists(targetFile: string, fsImpl: UserEntryFs): Promise<boolean> {
  try {
    await fsImpl.stat(targetFile)
    return true
  } catch {
    return false
  }
}

/** 目标文件是否已包含该条目内容 (幂等去重). */
async function targetContainsBullet(targetFile: string, content: string, fsImpl: UserEntryFs): Promise<boolean> {
  let text: string
  try {
    text = await fsImpl.readFile(targetFile)
  } catch {
    return false
  }
  return text.includes(content.trim())
}

/**
 * 在目标文件末尾追加 `- <内容>` (带日期标题, 标题存在则复用; memory/user/log
 * 目标目录不存在时自动 mkdir —— M-2)。写入失败抛错给调用方 (L-9 计数)。
 */
async function appendEntryBullet(targetFile: string, content: string, fsImpl: UserEntryFs, now: Date): Promise<void> {
  let current = ''
  try {
    current = await fsImpl.readFile(targetFile)
  } catch {
    current = ''
  }
  await fsImpl.mkdir(path.dirname(targetFile), { recursive: true })
  const heading = `## ${now.toISOString().slice(0, 10)}`
  const body = current.trim().length === 0 ? `${heading}\n` : current
  const appended = `${body.replace(/\n$/, '')}\n- ${content.trim()}\n`
  await fsImpl.writeFile(targetFile, appended)
}
