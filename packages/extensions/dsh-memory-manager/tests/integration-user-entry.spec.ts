import { afterAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { createRealFs, runAuditOnce } from '../src/index.ts'
import { MtimeWatcher } from '../src/audit-pipeline/watcher.ts'
import { PendingWriteRegistry } from '../src/audit-pipeline/confirm.ts'
import { resolveConfig, resolveMemoryPaths, type ResolvedPluginConfig } from '../src/config.ts'

const tmpRoot = '/home/dingx/DSF-work/.temp/dsh-memory-manager-uentry'
const ws = `${tmpRoot}/ws`
const home = `${tmpRoot}/home`
const paths = resolveMemoryPaths(ws, home)
const config: ResolvedPluginConfig = resolveConfig({ pollIntervalMs: 60000 })

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

/** 干净的临时工作区 + 预置用户级 MEMORY.md (使目标文件先于条目处理存在, 便于 skip-audit 闭环). */
async function prepare(): Promise<void> {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.mkdir(`${ws}/.dsh-memory`, { recursive: true })
  await fs.mkdir(`${home}/.dsh/memory`, { recursive: true })
  await fs.writeFile(paths.userMemoryFile, '## 2026-08-22\n- 既有内容\n', 'utf8')
}

async function advanceMtime(file: string): Promise<void> {
  // 确保 mtime 前进 (粗粒度时钟安全)
  const future = new Date(Date.now() + 2000)
  await fs.utimes(file, future, future)
}

describe('用户授意记忆入口端到端 (写入口 → 扫描 → 确认 → 写入 → 审计 → skip-audit)', () => {
  it('完整闭环: 首次自动创建模板 → 用户条目写入 MEMORY.md → 目标文件 skip-audit 直接 fixed', async () => {
    await prepare()
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    const fsImpl = createRealFs()

    // poll 1: 入口文件不存在 → 自动创建带模板注释; 首次扫描只建基线, 不触发处理
    const first = await runAuditOnce({ watcher, registry, paths, fsImpl }, config)
    expect(first.changed).toEqual([])
    const template = await fs.readFile(paths.userEntriesFile, 'utf8')
    expect(template).toContain('[source=user]')

    // 用户编辑入口文件 (写入合法条目, 防线 3: 用户 shell 编辑触发 mtime 变化)
    const entryText = '[source=user] [target=memory] 用户说："工作完成后必须立即记录"\n- 用户偏好：工作完成后立即记录到工作区文档，不询问\n'
    await fs.writeFile(paths.userEntriesFile, entryText, 'utf8')
    await advanceMtime(paths.userEntriesFile)
    await new Promise((r) => { setTimeout(r, 50) })

    // poll 2: 入口变化 → 独立分支处理 → 写入目标 MEMORY.md, 注册 pendingWrite(skipAudit)
    const second = await runAuditOnce({ watcher, registry, paths, fsImpl }, config)
    expect(second.changed).toEqual([paths.userEntriesFile])
    expect(second.fixed).not.toContain(paths.userEntriesFile) // 入口文件绝不进 normalize (S-2)
    const mem = await fs.readFile(paths.userMemoryFile, 'utf8')
    expect(mem).toContain('- 用户偏好：工作完成后立即记录到工作区文档，不询问')
    // 入口文件本身不被规范化 (内容原样保留, 无日期标题注入)
    expect(await fs.readFile(paths.userEntriesFile, 'utf8')).toBe(entryText)
    expect(registry.size()).toBe(1) // 目标文件 pendingWrite 待下一 poll 消费

    // poll 3: 目标文件变化 → consume → source=user-approved-entry + skipAudit → 直接 fixed
    const third = await runAuditOnce({ watcher, registry, paths, fsImpl }, config)
    expect(third.changed).toContain(paths.userMemoryFile)
    expect(third.fixed).toContain(paths.userMemoryFile)
    expect(third.flagged).not.toContain(paths.userMemoryFile)
    expect(registry.size()).toBe(0) // consume 即清除
    // skip-audit: 内容未被 normalize/归档改写
    expect(await fs.readFile(paths.userMemoryFile, 'utf8')).toBe(mem)

    // poll 4: 无新变化 → 无处理 (mtime 检测自动去重)
    const fourth = await runAuditOnce({ watcher, registry, paths, fsImpl }, config)
    expect(fourth.changed).toEqual([])

    // 审计日志落盘: 逐条写入 + L-9 汇总 success=N failed=M + skip-audit 标记
    const auditFiles = await fs.readdir(paths.auditDir)
    const auditLog = auditFiles.find(name => name.startsWith('audit-'))
    expect(auditLog).toBeDefined()
    const log = await fs.readFile(`${paths.auditDir}/${auditLog}`, 'utf8')
    expect(log).toContain('user-entry-written')
    expect(log).toContain('skipAudit=true')
    expect(log).toContain('user-entries-processed')
    expect(log).toContain('success=1 failed=0')
    expect(log).toContain('user-entry-skip-audit')
  })

  it('部分失败条目不阻塞: 合法条目写入, 伪造条目进 pending-review 零写入', async () => {
    await prepare()
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    const fsImpl = createRealFs()
    await runAuditOnce({ watcher, registry, paths, fsImpl }, config) // 基线

    await fs.writeFile(paths.userEntriesFile, [
      '[source=user] [target=memory] 用户说："工作完成后必须立即记录"',
      '- 用户偏好：工作完成后立即记录到工作区文档，不询问',
      '[source=user] [target=memory] 缺引用内容',
      '- 用户偏好：缺引用内容',
    ].join('\n'), 'utf8')
    await advanceMtime(paths.userEntriesFile)
    await new Promise((r) => { setTimeout(r, 50) })

    const second = await runAuditOnce({ watcher, registry, paths, fsImpl }, config)
    expect(second.changed).toEqual([paths.userEntriesFile])
    const mem = await fs.readFile(paths.userMemoryFile, 'utf8')
    expect(mem).toContain('用户偏好：工作完成后立即记录到工作区文档')
    expect(mem).not.toContain('缺引用内容')
    const queue = JSON.parse(await fs.readFile(paths.pendingReviewFile, 'utf8')) as { entries: unknown[] }
    expect(queue.entries).toHaveLength(1)
  })

  it('守卫被绕过的边缘 (L-2): 入口文件内容无引用 → 插件标记 pending-review 绝不自动写', async () => {
    await prepare()
    const watcher = new MtimeWatcher()
    const registry = new PendingWriteRegistry()
    const fsImpl = createRealFs()
    await runAuditOnce({ watcher, registry, paths, fsImpl }, config) // 基线

    // 即使 guard 被绕过 (文件可写), 无用户原话引用 → 三层防线第 2 层拦截
    await fs.writeFile(paths.userEntriesFile, '[source=user] [target=memory] 主 agent 提议："新增一条规则"\n- 用户偏好：新增一条规则\n', 'utf8')
    await advanceMtime(paths.userEntriesFile)
    await new Promise((r) => { setTimeout(r, 50) })

    await runAuditOnce({ watcher, registry, paths, fsImpl }, config)
    const mem = await fs.readFile(paths.userMemoryFile, 'utf8')
    expect(mem).not.toContain('新增一条规则')
    const queue = JSON.parse(await fs.readFile(paths.pendingReviewFile, 'utf8')) as { entries: unknown[] }
    expect(queue.entries).toHaveLength(1)
  })
})
