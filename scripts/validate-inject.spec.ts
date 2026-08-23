/**
 * Guard tests for scripts/validate-inject.mjs — Cordis inject legality check.
 *
 * The validator runs the repo guard in a fixture tree (catalog + plugin sources),
 * so the suite stays independent of the live repository state. A missing
 * catalog is a configuration error (exit 2); an illegal inject value is a
 * violation (exit 1); a clean tree passes (exit 0).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const validator = fileURLToPath(new URL('./validate-inject.mjs', import.meta.url))
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Minimal tool-cordis-style harness catalog: a few SERVICE_API keys + core ctx entries. */
const HARNESS_CATALOG = `export const SERVICE_API = [
  {
    key: 'tools',
    summary: 'Tool runtime.',
  },
  {
    key: 'agents',
    summary: 'Agent runtime.',
  },
  {
    key: 'sessions',
    summary: 'Session runtime.',
  },
  {
    key: 'invariants',
    summary: 'Invariant registry.',
  },
  {
    key: 'systemPrompt',
    summary: 'Prompt assembly.',
  },
]
export const EVENT_API = []
export const INHERITED_CTX_API = [
  { name: 'ctx.timer (+ interval / timeout / throttle / debounce)', summary: 'provided at runtime' },
  { name: 'ctx.loader', summary: 'present under the loader' },
  { name: 'ctx.hmr', summary: 'present under the hmr plugin' },
]
`

/** Minimal cordis-client-runner-style client catalog. */
const CLIENT_CATALOG = `export const SERVICE_API = [
  {
    key: 'slots',
    summary: 'Slot registry.',
  },
  {
    key: 'locale',
    summary: 'Locale service.',
  },
]
export const EVENT_API = []
`

interface FixtureOptions {
  /** Catalog files to write; omit a key to simulate a missing catalog. */
  catalogs?: { harness?: string | undefined; client?: string | undefined }
  /** Plugin sources keyed by path under the extensions root. */
  plugins?: Record<string, string>
}

function fixture(options: FixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-validate-inject-'))
  roots.push(root)
  const catalogs = options.catalogs ?? {}
  const harness = 'harness' in catalogs ? catalogs.harness : HARNESS_CATALOG
  const client = 'client' in catalogs ? catalogs.client : CLIENT_CATALOG
  if (harness !== undefined) {
    mkdirSync(join(root, 'tool-cordis/src/generated'), { recursive: true })
    writeFileSync(join(root, 'tool-cordis/src/generated/api-catalog.ts'), harness)
  }
  if (client !== undefined) {
    mkdirSync(join(root, 'cordis-client-runner/src/client'), { recursive: true })
    writeFileSync(join(root, 'cordis-client-runner/src/client/api-catalog.ts'), client)
  }
  for (const [rel, source] of Object.entries(options.plugins ?? {})) {
    const file = join(root, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  return root
}

function run(root: string, extraArgs: string[] = []) {
  return spawnSync(process.execPath, [validator, '--extensions-root', root, ...extraArgs], {
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('validate-inject.mjs', () => {
  it('passes a tree whose inject values resolve to known services', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': "export const inject = ['tools', 'systemPrompt', 'dynamicCordisRunner', 'cordisInspect']\nexport function apply(ctx: never): void {}\n",
        'dsh-probe/src/index.ts': "export const inject = ['slots', 'locale', 'remote', 'remote.dynamicCordisRunner', 'timer', 'inputTriggers', 'modules']\nexport function apply(ctx: never): void {}\n",
        'guard-main-agent/src/index.ts': "export class Plugin {\n  static inject = ['tools']\n  static apply(ctx: never): void {}\n}\n",
        'dsh-injection-manager/src/invariant.ts': "export const inject = ['invariants']\nexport function apply(ctx: never): void {}\n",
      },
    })
    const result = run(root)
    expect(result.status).toBe(0)
  })

  it('rejects an unknown service name', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': "export const inject = ['toolss']\nexport function apply(ctx: never): void {}\n",
      },
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('toolss')
  })

  it('rejects a duplicate service name in one declaration', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': "export const inject = ['tools', 'tools']\nexport function apply(ctx: never): void {}\n",
      },
    })
    const result = run(root)
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('重复')
  })

  it('rejects an empty string element', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': "export const inject = ['tools', '']\nexport function apply(ctx: never): void {}\n",
      },
    })
    const result = run(root)
    expect(result.status).toBe(1)
  })

  it('rejects a non-string array element', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': 'export const inject = [tools]\nexport function apply(ctx: never): void {}\n',
      },
    })
    const result = run(root)
    expect(result.status).toBe(1)
  })

  it('rejects a malformed nested service path', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': "export const inject = ['remote..dynamicCordisRunner']\nexport function apply(ctx: never): void {}\n",
      },
    })
    const result = run(root)
    expect(result.status).toBe(1)
  })

  it('accepts the object form with known keys', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': 'export const inject = { tools: { optional: true } }\nexport function apply(ctx: never): void {}\n',
      },
    })
    const result = run(root)
    expect(result.status).toBe(0)
  })

  it('rejects the object form with an unknown key', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': 'export const inject = { toolzz: {} }\nexport function apply(ctx: never): void {}\n',
      },
    })
    const result = run(root)
    expect(result.status).toBe(1)
  })

  it('treats a missing catalog as a configuration error (exit 2)', () => {
    const root = fixture({ catalogs: { harness: undefined }, plugins: {} })
    const result = run(root)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('api-catalog')
  })

  it('ignores inject text inside doc comments and string literals', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': [
          '/**',
          ' * Example: export const inject = [\'bogusService\'] — doc only.',
          ' */',
          "const hint = \"declare inject: ['alsoBogus'] on your plugin\"",
          "export const inject = ['tools']",
          'export function apply(ctx: never): void {}\n',
        ].join('\n'),
      },
    })
    const result = run(root)
    expect(result.status).toBe(0)
  })

  it('emits a machine-readable report under --json', () => {
    const root = fixture({
      plugins: {
        'tool-cordis/src/index.ts': "export const inject = ['nope']\nexport function apply(ctx: never): void {}\n",
      },
    })
    const result = run(root, ['--json'])
    expect(result.status).toBe(1)
    const report = JSON.parse(result.stdout.trim()) as {
      ok: boolean
      exitCode: number
      failures: readonly { file: string; line: number; message: string }[]
    }
    expect(report.ok).toBe(false)
    expect(report.exitCode).toBe(1)
    expect(report.failures.length).toBe(1)
    expect(report.failures[0]!.message).toContain('nope')
  })
})
