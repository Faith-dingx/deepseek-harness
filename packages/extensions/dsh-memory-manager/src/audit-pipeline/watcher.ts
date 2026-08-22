/**
 * 步骤① 发现写入 (计划 v18 §5.2). mtime-based change detection over the
 * short-term file list. The first scan seeds the baseline (established
 * state); later scans report only files whose mtime advanced. Fail-open:
 * a stat failure never throws out of the scan — that file is skipped this
 * round (the pipeline must never be able to break memory writes).
 *
 * @module dsh-memory-manager/audit-pipeline/watcher
 */

import { promises as fs } from 'node:fs'
import type { MemoryPaths } from '../config.ts'

/** The stat surface the watcher needs; injectable for tests. */
export interface WatchFs {
  stat(file: string): Promise<{ mtimeMs: number; size: number }>
}

/** The enumerate surface for the short-term scan; injectable for tests. */
export interface ScanFs {
  readdir(dir: string): Promise<string[]>
}

const defaultFs: WatchFs = {
  async stat(file) { const s = await fs.stat(file); return { mtimeMs: s.mtimeMs, size: s.size } },
}

const defaultScanFs: ScanFs = {
  async readdir(dir) { return fs.readdir(dir) },
}

/** One detected write (mtime advanced past the seen baseline). */
export interface DetectedWrite {
  readonly file: string
  readonly mtimeMs: number
  readonly size: number
}

/**
 * Enumerate the concrete short-term file list for one workspace: the five
 * fixed targets plus glob-style directory scans (daily logs `*.md` in
 * `.dsh-memory/`, reflections `*.md`). The archive area is never included
 * (计划 v18 §7 协同点 3 — 归档区不触发审核). Fail-open: unreadable
 * directories are skipped.
 */
export async function scanShortTermFiles(paths: MemoryPaths, fsImpl: ScanFs = defaultScanFs): Promise<string[]> {
  const targets = [
    paths.userMemoryFile,
    paths.userProfileFile,
    paths.userCalendarFile,
    paths.summaryFile,
    paths.suggestionsFile,
  ]
  // 日志: <workspace>/.dsh-memory/*.md（排除摘要文件自身）
  const memoryDir = dirOf(paths.summaryFile)
  try {
    const names = await fsImpl.readdir(memoryDir)
    for (const name of names) {
      const full = `${memoryDir}/${name}`
      if (!name.endsWith('.md')) continue
      if (full === paths.summaryFile) continue
      targets.push(full)
    }
  } catch {
    // fail-open: a missing .dsh-memory dir is fine.
  }
  // 反思: reflections/*.md
  try {
    const names = await fsImpl.readdir(paths.reflectionsDir)
    for (const name of names) {
      if (name.endsWith('.md')) targets.push(`${paths.reflectionsDir}/${name}`)
    }
  } catch {
    // fail-open: a missing reflections dir is fine.
  }
  return targets
}

/** Parent directory of a path (for the .dsh-memory root derivation). */
function dirOf(file: string): string {
  const index = file.lastIndexOf('/')
  return index <= 0 ? '.' : file.slice(0, index)
}

/**
 * mtime-polling change detector. Call {@link detectWrites} on every poll
 * interval (default 5s); each changed file is reported exactly once until
 * its baseline advances again.
 */
export class MtimeWatcher {
  private readonly seen = new Map<string, { mtimeMs: number; size: number }>()

  constructor(private readonly fsImpl: WatchFs = defaultFs) {}

  /** Explicit baseline stamp (used when the pipeline consumed a write). */
  markSeen(file: string, mtimeMs: number, size = 0): void {
    this.seen.set(file, { mtimeMs, size })
  }

  /** The last seen mtime for a file, for tests/inspection. */
  seenMtime(file: string): number | undefined {
    return this.seen.get(file)?.mtimeMs
  }

  /**
   * Scan the target files and return those with an advanced mtime. Files that
   * do not exist are silently skipped; stat failures are contained per file.
   */
  async detectWrites(targets: readonly string[]): Promise<string[]> {
    const changed: string[] = []
    for (const file of targets) {
      let stat: { mtimeMs: number; size: number }
      try {
        stat = await this.fsImpl.stat(file)
      } catch {
        // ENOENT or read error: not writable yet / transient — skip, fail-open.
        continue
      }
      const previous = this.seen.get(file)
      if (previous === undefined) {
        // First scan: seed the baseline, never report established state.
        this.seen.set(file, { mtimeMs: stat.mtimeMs, size: stat.size })
        continue
      }
      // mtime advanced, or same mtime but different size (coarse clocks).
      if (stat.mtimeMs > previous.mtimeMs
        || (stat.mtimeMs === previous.mtimeMs && stat.size !== previous.size)) {
        this.seen.set(file, { mtimeMs: stat.mtimeMs, size: stat.size })
        changed.push(file)
      }
    }
    return changed
  }
}
