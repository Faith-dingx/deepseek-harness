/**
 * File permission interception (D1): machine whitelist + fail-close.
 *
 * Data source: `docs/主agent可改写文件清单.yaml` (v2.1). Judgment rules:
 * 1. resolve symlinks first (realpath, with deepest-existing-ancestor fallback
 *    for create operations) so a symlink can never escape the whitelist;
 * 2. match the resolved absolute path against whitelist rules (prefix / exact
 *    / glob via regex), then enforce `allowedExtensions`;
 * 3. temporaryOverrides (user-authored, time-boxed) may grant one file outside
 *    the whitelist until `expiresAt`, then expire automatically;
 * 4. everything else is denied (fail-close) — no blacklist concept.
 *
 * @module @deepseek-ai/dsh-guard-main-agent
 */

import { parse as parseYaml } from 'yaml'
import path from 'node:path'
import { promises as nodeFs } from 'node:fs'

/** Injectable realpath seam (node:fs/promises by default in loadPolicy). */
export interface FileFs {
  realpath(p: string): Promise<string>
}

/** One whitelist rule from the YAML. */
export interface WhitelistRule {
  readonly type: string
  readonly value: string
  readonly allowedExtensions?: readonly string[]
  readonly reason?: string
}

/** One user-authored temporary override record. */
export interface TemporaryOverride {
  readonly filePath: string
  readonly userMessage?: string
  readonly timestamp?: string
  readonly expiresAt: string
  readonly by?: string
}

/** Parsed policy document (mirror of the YAML schema). */
export interface PolicyData {
  readonly defaultPolicy: string
  readonly symlinkResolve: boolean
  readonly whitelist: readonly WhitelistRule[]
  readonly dynamicWhitelist?: readonly WhitelistRule[]
  readonly temporaryOverrides: readonly TemporaryOverride[]
}

/** Result of one write-permission judgment. */
export interface FileDecision {
  readonly allowed: boolean
  readonly reason: string
  /** The resolved (realpath) absolute path. */
  readonly resolvedPath: string
  /** Matching rule reason, when a whitelist rule matched. */
  readonly matchedRule?: string
  /** Effective temporary override, when one authorized the write. */
  readonly override?: TemporaryOverride
}

/** The policy object with the raw path entry point used by the guard. */
export interface FilePolicy {
  /** Judge one write operation against the whitelist. Never throws. */
  canWrite(rawPath: string): Promise<FileDecision>
  /** Currently active (unexpired) temporary overrides. */
  activeOverrides(): readonly TemporaryOverride[]
}

export interface FilePolicyOptions {
  readonly cwd: string
  readonly fs?: FileFs
  /** Clock injection for override expiry tests. */
  readonly now?: () => number
}

/** Parse the YAML policy text; throws on malformed input (caller fails closed). */
export function parsePolicy(yamlText: string): PolicyData {
  const value: unknown = parseYaml(yamlText)
  const root = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  return {
    defaultPolicy: typeof root.defaultPolicy === 'string' ? root.defaultPolicy : 'deny',
    symlinkResolve: root.symlinkResolve !== false,
    whitelist: Array.isArray(root.whitelist) ? root.whitelist as WhitelistRule[] : [],
    dynamicWhitelist: Array.isArray(root.dynamicWhitelist) ? root.dynamicWhitelist as WhitelistRule[] : [],
    temporaryOverrides: Array.isArray(root.temporaryOverrides) ? root.temporaryOverrides as TemporaryOverride[] : [],
  }
}

/** Parse policy text and remember the workspace cwd (used by the loader). */
export function loadPolicy(yamlText: string, cwd: string): { data: PolicyData; cwd: string } {
  return { data: parsePolicy(yamlText), cwd }
}

/** Escape regex metacharacters; `*` is escaped first and restored by callers. */
const ESCAPE_GLOB = /[.+?*^${}()|[\]\\]/g

/**
 * glob -> prefix-anchored regex, exactly per the plan (§8.0):
 * `*` becomes a non-slash segment (`[^/]+`). Prefix rules use this as-is;
 * exact rules add the trailing anchor in matchRule.
 */
export function globToRegex(globPath: string): RegExp {
  return new RegExp(`^${globBody(globPath)}`)
}

/** Build the non-anchored regex body for one glob path. */
function globBody(globPath: string): string {
  return globPath.replace(ESCAPE_GLOB, '\\$&').replace(/\\\*/g, '[^/]+')
}

/**
 * Match one resolved absolute path against one whitelist rule.
 * - exact -> full equality (glob-aware when the value contains `*`)
 * - prefix -> starts-with (glob-aware segment matching)
 */
export function matchRule(resolvedPath: string, rule: WhitelistRule): boolean {
  if (rule.value.includes('*')) {
    const body = globBody(rule.value)
    return rule.type === 'exact'
      ? new RegExp(`^${body}$`).test(resolvedPath)
      : new RegExp(`^${body}`).test(resolvedPath)
  }
  return rule.type === 'exact'
    ? resolvedPath === rule.value
    : resolvedPath.startsWith(rule.value)
}

/**
 * Resolve a (probably absolute) path to its physical location:
 * realpath of the full path when it exists, otherwise realpath of the deepest
 * existing ancestor with the missing suffix re-appended (create operations).
 * Unresolvable input falls back to the raw path (which then fails the
 * whitelist check — fail-close).
 */
export async function resolvePath(absolute: string, fs: FileFs): Promise<string> {
  try {
    return await fs.realpath(absolute)
  } catch {
    let ancestor = path.dirname(absolute)
    const tail: string[] = [path.basename(absolute)]
    for (;;) {
      try {
        const resolved = await fs.realpath(ancestor)
        return path.join(resolved, ...tail.reverse())
      } catch {
        const parent = path.dirname(ancestor)
        if (parent === ancestor) return absolute
        tail.push(path.basename(ancestor))
        ancestor = parent
      }
    }
  }
}

/** Build a policy instance over parsed data. */
export function createFilePolicy(data: PolicyData, options: FilePolicyOptions): FilePolicy {
  const cwd = options.cwd
  // Real node:fs realpath by default — the symlink defense MUST resolve
  // physical paths, never mirror the input (identity would let symlinks
  // escape the whitelist). Tests inject a mock seam.
  const fs: FileFs = options.fs ?? { realpath: p => nodeFs.realpath(p) }
  const now = options.now ?? (() => Date.now())
  const extensionOf = (resolved: string): string => path.extname(resolved).toLowerCase()

  const filterLiveOverrides = (): TemporaryOverride[] =>
    data.temporaryOverrides.filter(override => Date.parse(override.expiresAt) >= now())

  const canWrite = async (rawPath: string): Promise<FileDecision> => {
    const absolute = path.resolve(cwd, rawPath)
    const resolvedPath = await resolvePath(absolute, fs)
    const rules = [...data.whitelist, ...(data.dynamicWhitelist ?? [])]

    // ① whitelist hit -> extension gate -> allow.
    for (const rule of rules) {
      if (!matchRule(resolvedPath, rule)) continue
      const extensions = rule.allowedExtensions
      if (extensions !== undefined && extensions.length > 0 && !extensions.includes(extensionOf(resolvedPath))) {
        return {
          allowed: false,
          reason: `白名单路径 ${rule.value} 命中，但文件类型 ${extensionOf(resolvedPath)} 不在允许列表 [${extensions.join(', ')}]`,
          resolvedPath,
          matchedRule: rule.reason ?? rule.value,
        }
      }
      return { allowed: true, reason: `白名单: ${rule.reason ?? rule.value}`, resolvedPath, matchedRule: rule.reason ?? rule.value }
    }

    // ② temporaryOverrides (user-authored, time-boxed).
    for (const override of filterLiveOverrides()) {
      const overridePath = path.resolve(cwd, override.filePath)
      if (resolvedPath === overridePath) {
        return { allowed: true, reason: '临时例外（用户直接请求）生效', resolvedPath, override }
      }
    }

    // ③ fail-close.
    const expired = data.temporaryOverrides.some((o) => {
      const candidate = path.resolve(cwd, o.filePath)
      return candidate === resolvedPath && Date.parse(o.expiresAt) < now()
    })
    return {
      allowed: false,
      reason: expired
        ? '未匹配白名单，且临时例外已过期（expiresAt < now），默认拒绝'
        : '未匹配白名单，默认拒绝',
      resolvedPath,
    }
  }

  return {
    canWrite,
    activeOverrides: filterLiveOverrides,
  }
}
