import { describe, expect, it } from 'vitest'
import {
  createFilePolicy,
  globToRegex,
  loadPolicy,
  matchRule,
  parsePolicy,
  type FileFs,
  type PolicyData,
} from '../src/filePolicy.ts'

/** Model real fs semantics for the fake /ws workspace: symlinked paths map to
 * their target; existing directories resolve to themselves; anything else
 * throws ENOENT so resolvePath walks up to the deepest existing ancestor. */
function identityFs(symlinks: Record<string, string> = {}): FileFs {
  const dirs = new Set([
    '/ws', '/ws/docs', '/ws/.temp', '/ws/projects', '/ws/projects/some', '/ws/projects/some/docs',
    '/ws/与agent的交互目录', '/home/user', '/home/user/secret-dir',
  ])
  return {
    async realpath(p: string) {
      if (symlinks[p] !== undefined) return symlinks[p]
      if (dirs.has(p)) return p
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
}

/** A policy over a fake workspace rooted at /ws (mirrors the v2.1 YAML). */
const WHITELIST_YAML = `
defaultPolicy: deny
symlinkResolve: true
whitelist:
  - type: prefix
    value: "/ws/docs/"
    allowedExtensions: [".md"]
    reason: "项目文档（仅markdown）"
  - type: prefix
    value: "/ws/projects/*/docs/"
    allowedExtensions: [".md"]
    reason: "项目文档（仅markdown）"
  - type: exact
    value: "/ws/projects/*/README.md"
    reason: "项目自述"
  - type: prefix
    value: "/ws/.temp/"
    allowedExtensions: [".md", ".txt", ".log", ".json"]
    reason: "临时文件区（仅文本/日志/JSON）"
  - type: prefix
    value: "/ws/与agent的交互目录/"
    reason: "与agent交互文档（任意类型）"
`

function policyFor(yaml = WHITELIST_YAML, fs?: FileFs, now = () => Date.parse('2026-08-21T12:00:00Z')) {
  const data = parsePolicy(yaml)
  return createFilePolicy(data, { cwd: '/ws', fs: fs ?? identityFs(), now })
}

describe('parsePolicy', () => {
  it('parses the whitelist, defaults and overrides from YAML text', () => {
    const data = parsePolicy(WHITELIST_YAML)
    expect(data.defaultPolicy).toBe('deny')
    expect(data.symlinkResolve).toBe(true)
    expect(data.whitelist).toHaveLength(5)
    expect(data.temporaryOverrides).toEqual([])
    expect(data.whitelist[0]).toMatchObject({ type: 'prefix', value: '/ws/docs/', allowedExtensions: ['.md'] })
  })

  it('throws on malformed YAML so callers can fail closed', () => {
    expect(() => parsePolicy('whitelist: [unclosed')).toThrow()
  })
})

describe('globToRegex', () => {
  it('converts a * into a non-slash segment matcher', () => {
    expect(globToRegex('/ws/projects/*/docs/').test('/ws/projects/alpha/docs/x.md')).toBe(true)
    expect(globToRegex('/ws/projects/*/docs/').test('/ws/projects/a/b/docs/x.md')).toBe(false)
  })

  it('escapes regex metacharacters in literal path parts', () => {
    const regex = globToRegex('/ws/与agent的交互目录/')
    expect(regex.test('/ws/与agent的交互目录/rep.md')).toBe(true)
  })

  it('anchors only at the start (prefix semantics; exact rules add the tail anchor)', () => {
    const regex = globToRegex('/ws/projects/*/README.md')
    expect(regex.test('/ws/projects/x/README.md')).toBe(true)
    // Same glob is a prefix: the trailing .bak also matches at the prefix level;
    // exact-rule anchoring is asserted in the matchRule tests.
    expect(regex.test('/ws/projects/x/README.md.bak')).toBe(true)
    expect(regex.test('not-a-path')).toBe(false)
  })
})

describe('matchRule', () => {
  const [docs, projectsDocs, readme, temp, agentDir] = parsePolicy(WHITELIST_YAML).whitelist

  it('matches prefix rules by start-with on the resolved absolute path', () => {
    expect(matchRule('/ws/docs/a.md', docs as never)).toBe(true)
    expect(matchRule('/ws/docs2/a.md', docs as never)).toBe(false)
  })

  it('matches glob prefix rules through the regex', () => {
    expect(matchRule('/ws/projects/p1/docs/z.md', projectsDocs as never)).toBe(true)
    expect(matchRule('/ws/projects/p1/src/z.md', projectsDocs as never)).toBe(false)
  })

  it('matches exact rules only on equality', () => {
    expect(matchRule('/ws/projects/p1/README.md', readme as never)).toBe(true)
    expect(matchRule('/ws/projects/p1/README.md.bak', readme as never)).toBe(false)
  })

  it('matches plain prefixes regardless of extension', () => {
    expect(matchRule('/ws/.temp/a.txt', temp as never)).toBe(true)
    expect(matchRule('/ws/与agent的交互目录/任意.bin', agentDir as never)).toBe(true)
  })
})

describe('canWrite — whitelist + fail-close', () => {
  it('allows a markdown doc under docs/ (scenario: docs/新文档.md)', async () => {
    const policy = policyFor()
    const decision = await policy.canWrite('/ws/docs/新文档.md')
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toContain('白名单')
  })

  it('rejects a non-md file under docs/ (scenario: docs/配置.yaml)', async () => {
    const decision = await policyFor().canWrite('/ws/docs/配置.yaml')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('.yaml')
  })

  it('rejects a whitelisted dir path with no extension (Makefile)', async () => {
    const decision = await policyFor().canWrite('/ws/docs/Makefile')
    expect(decision.allowed).toBe(false)
  })

  it('rejects a system config file outside the whitelist (~/.dsh/settings.yaml)', async () => {
    const decision = await policyFor().canWrite('/home/user/.dsh/settings.yaml')
    expect(decision.allowed).toBe(false)
  })

  it('allows .temp text/log/json but rejects executable scripts', async () => {
    const policy = policyFor()
    expect((await policy.canWrite('/ws/.temp/test.txt')).allowed).toBe(true)
    expect((await policy.canWrite('/ws/.temp/test.log')).allowed).toBe(true)
    expect((await policy.canWrite('/ws/.temp/test.json')).allowed).toBe(true)
    expect((await policy.canWrite('/ws/.temp/test.ts')).allowed).toBe(false)
    expect((await policy.canWrite('/ws/.temp/test.py')).allowed).toBe(false)
  })

  it('allows project docs via glob and project README via exact glob', async () => {
    const policy = policyFor()
    expect((await policy.canWrite('/ws/projects/some/docs/plan.md')).allowed).toBe(true)
    expect((await policy.canWrite('/ws/projects/some/README.md')).allowed).toBe(true)
  })

  it('rejects anything else, including sibling dirs', async () => {
    const policy = policyFor()
    expect((await policy.canWrite('/ws/src/main.ts')).allowed).toBe(false)
    expect((await policy.canWrite('/ws/projects/some/other.md')).allowed).toBe(false)
    expect((await policy.canWrite('/ws/docs.md')).allowed).toBe(false)
  })

  it('resolves relative inputs against the workspace cwd', async () => {
    const decision = await policyFor().canWrite('docs/rel.md')
    expect(decision.allowed).toBe(true)
  })

  it('rejects a memory file (记忆基础设施)', async () => {
    const decision = await policyFor().canWrite('/ws/AGENTS.md')
    expect(decision.allowed).toBe(false)
  })
})

describe('canWrite — symlink defense', () => {
  it('rejects a file symlink inside .temp pointing at a banned target', async () => {
    const fs = identityFs({
      '/ws/.temp/link-to-settings.yaml': '/home/user/.dsh/settings.yaml',
    })
    const decision = await policyFor(WHITELIST_YAML, fs).canWrite('/ws/.temp/link-to-settings.yaml')
    expect(decision.allowed).toBe(false)
    expect(decision.resolvedPath).toBe('/home/user/.dsh/settings.yaml')
    expect(decision.reason).toContain('未匹配白名单')
  })

  it('rejects a whitelisted extension whose symlink target escapes the whitelist', async () => {
    const fs = identityFs({ '/ws/docs/real.md': '/home/user/secret.md' })
    const decision = await policyFor(WHITELIST_YAML, fs).canWrite('/ws/docs/real.md')
    expect(decision.allowed).toBe(false)
    expect(decision.resolvedPath).toBe('/home/user/secret.md')
  })

  it('resolves a symlinked parent directory before judging', async () => {
    const fs = identityFs({ '/ws/link': '/home/user/secret-dir' })
    const decision = await policyFor(WHITELIST_YAML, fs).canWrite('/ws/link/x.ts')
    expect(decision.allowed).toBe(false)
    expect(decision.resolvedPath).toBe('/home/user/secret-dir/x.ts')
  })

  it('keeps symlinked targets inside the whitelist allowed', async () => {
    const fs = identityFs({ '/ws/alias.md': '/ws/docs/a.md' })
    const decision = await policyFor(WHITELIST_YAML, fs).canWrite('/ws/alias.md')
    expect(decision.allowed).toBe(true)
    expect(decision.resolvedPath).toBe('/ws/docs/a.md')
  })
})

describe('canWrite — temporaryOverrides', () => {
  const WITH_OVERRIDES = `
defaultPolicy: deny
symlinkResolve: true
whitelist:
  - type: prefix
    value: "/ws/docs/"
    allowedExtensions: [".md"]
    reason: "项目文档"
temporaryOverrides:
  - filePath: "/ws/AGENTS.md"
    userMessage: "帮我改一下AGENTS.md"
    timestamp: "2026-08-21T10:00:00Z"
    expiresAt: "2026-08-22T10:00:00Z"
    by: "user-direct-request"
  - filePath: "/ws/EXPIRED.md"
    userMessage: "暂存"
    timestamp: "2026-08-21T10:00:00Z"
    expiresAt: "2026-08-20T10:00:00Z"
    by: "user-direct-request"
`

  const now = () => Date.parse('2026-08-21T12:00:00Z')

  it('allows a live override for a whitelist-excluded file', async () => {
    const decision = await policyFor(WITH_OVERRIDES, identityFs(), now).canWrite('/ws/AGENTS.md')
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toContain('临时例外')
  })

  it('rejects an expired override (expiresAt < now)', async () => {
    const decision = await policyFor(WITH_OVERRIDES, identityFs(), now).canWrite('/ws/EXPIRED.md')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('过期')
  })

  it('expired overrides are filtered out of the active list', () => {
    const policy = policyFor(WITH_OVERRIDES, identityFs(), now)
    expect(policy.activeOverrides().map(o => o.filePath)).toEqual(['/ws/AGENTS.md'])
  })

  it('a whitelist mismatch override never fires', async () => {
    const decision = await policyFor(WITH_OVERRIDES, identityFs(), now).canWrite('/ws/other.md')
    expect(decision.allowed).toBe(false)
  })
})

describe('loadPolicy — file reads and fail-close behavior', () => {
  it('loads policy from YAML text (read path)', () => {
    const data = loadPolicy(WHITELIST_YAML, '/ws')
    expect(data.cwd).toBe('/ws')
    expect(data.data.whitelist).toHaveLength(5)
  })

  it('empty whitelist denies everything (fail-close default)', async () => {
    const empty: PolicyData = parsePolicy('defaultPolicy: deny\nwhitelist: []\ntemporaryOverrides: []\n')
    const policy = createFilePolicy(empty, { cwd: '/ws', fs: identityFs() })
    expect((await policy.canWrite('/ws/docs/a.md')).allowed).toBe(false)
  })
})
