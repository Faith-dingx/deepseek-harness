import { describe, expect, it } from 'vitest'
import {
  classifyEntryLine,
  parseSuggestionEntries,
  parseUserEntries,
  resolveTargetPath,
  validateSuggestionTarget,
  validateMemoryFile,
  validateUserEntry,
  type ValidationIssue,
} from '../src/shared/validators.ts'
import { resolveMemoryPaths } from '../src/config.ts'

describe('classifyEntryLine (计划 v18 §5.2 步骤④ 三类规矩判定, T2)', () => {
  it('recognizes file-pointer lines (②关键文件指针)', () => {
    expect(classifyEntryLine('- 项目指针：projects/project-execution-system/docs/进展.md')).toBe('file-pointer')
    expect(classifyEntryLine('docs/CHANGELOG.md 是改动明细')).toBe('file-pointer')
    expect(classifyEntryLine('~/.dsh/memory/MEMORY.md 用户级记忆')).toBe('file-pointer')
  })

  it('recognizes critical-rule lines (①关键规则)', () => {
    expect(classifyEntryLine('- 规则：重启 dsh 是用户专属操作')).toBe('critical-rule')
    expect(classifyEntryLine('决策：模块先压缩后审核')).toBe('critical-rule')
    expect(classifyEntryLine('约定：临时文件一律放 .temp/')).toBe('critical-rule')
  })

  it('recognizes work-log-pointer lines (③工作流水账指针)', () => {
    expect(classifyEntryLine('- 完成：guard 误拦修复，115 测试绿')).toBe('work-log-pointer')
    expect(classifyEntryLine('- 修复了 timeout 配置 bug')).toBe('work-log-pointer')
    expect(classifyEntryLine('- 新增 memory 插件，31 测试绿')).toBe('work-log-pointer')
  })

  it('flags out-of-category lines as non-compliant (超三类内容)', () => {
    // 无路径引用、无规则词、无操作动词的随意句子
    expect(classifyEntryLine('- 今天天气不错，心情很好')).toBe('non-compliant')
    // 超长流水账（含大量细节, 违反"一句+指针"原则）
    const longLog = '- 完成了 guard 插件的误拦修复，具体包括把 timeoutMs 从 5000 改成 10000，并且调整了重试逻辑，在超时的时候只重试一次并且只处理 AbortError，还有 caller abort 的时候不重试，同时把缓存 TTL 调到了十分钟，最后更新了文档并提交了代码'
    expect(classifyEntryLine(longLog)).toBe('non-compliant')
  })
})

describe('parseSuggestionEntries (计划 v18 §4.2.3 建议条目格式, T5/T8)', () => {
  const validEntry = {
    id: 'sugg-20260822-001',
    timestamp: '2026-08-22T10:30:00Z',
    source: 'history-compressor/classify',
    targetFile: '~/.dsh/memory/MEMORY.md',
    category: 'critical-rule',
    content: '用户偏好：工作完成后立即记录',
    confidence: 0.85,
    reasoning: '跨任务有效',
  }

  it('parses a well-formed suggestions file into entries', () => {
    const result = parseSuggestionEntries(JSON.stringify({ entries: [validEntry] }, null, 2))
    expect(result.issues).toEqual([])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.id).toBe('sugg-20260822-001')
  })

  it('reports unreadable JSON as an error issue', () => {
    const result = parseSuggestionEntries('{ not json')
    expect(result.entries).toEqual([])
    expect(result.issues.some(i => i.severity === 'error')).toBe(true)
  })

  it('flags entries missing required fields (结构校验, 方案B 不校验语义)', () => {
    const broken = { id: 'x', timestamp: '2026-08-22T10:30:00Z' }
    const result = parseSuggestionEntries(JSON.stringify({ entries: [broken] }))
    expect(result.issues.some(i => i.code === 'suggestion-missing-fields')).toBe(true)
    // 没有语义判断类 issue（方案 B：不校验内容语义）
    expect(result.issues.some(i => i.code.startsWith('suggestion-semantic'))).toBe(false)
  })

  it('flags a non-object entry with a missing-fields issue', () => {
    const result = parseSuggestionEntries(JSON.stringify({ entries: [42, { id: 'ok' }] }))
    expect(result.issues.some(i => i.code === 'suggestion-missing-fields')).toBe(true)
    expect(result.entries).toHaveLength(0)
  })

  it('tolerates a missing top-level entries key as empty', () => {
    const result = parseSuggestionEntries(JSON.stringify({}))
    expect(result.entries).toEqual([])
    expect(result.issues).toEqual([])
  })
})

describe('validateSuggestionTarget (计划 v18 §5.2 步骤④ 方案B: 目标文件类别匹配, T2)', () => {
  it('accepts the three categories against the user memory files', () => {
    expect(validateSuggestionTarget('~/.dsh/memory/MEMORY.md', 'critical-rule')).toBe(true)
    expect(validateSuggestionTarget('~/.dsh/memory/MEMORY.md', 'file-pointer')).toBe(true)
    expect(validateSuggestionTarget('~/.dsh/memory/MEMORY.md', 'work-log-pointer')).toBe(true)
  })

  it('only admits work-log-pointer against the daily log files', () => {
    expect(validateSuggestionTarget('.dsh-memory/2026-08-22.md', 'work-log-pointer')).toBe(true)
    expect(validateSuggestionTarget('.dsh-memory/2026-08-22.md', 'critical-rule')).toBe(false)
  })

  it('rejects unknown targets and unknown categories', () => {
    expect(validateSuggestionTarget('docs/CHANGELOG.md', 'critical-rule')).toBe(false)
    expect(validateSuggestionTarget('~/.dsh/memory/reflections/2026-08-22.md', 'critical-rule')).toBe(false)
    expect(validateSuggestionTarget('~/.dsh/memory/MEMORY.md', 'bogus')).toBe(false)
  })
})

describe('validateMemoryFile (计划 v18 §3.x 各文件类型校验, T2)', () => {
  it('memory files: out-of-category lines produce a non-autoFixable error issue', () => {
    const content = [
      '## 2026-08-22',
      '- 规则：重启是用户专属操作',
      '- 今天天气不错',
      '',
    ].join('\n')
    const result = validateMemoryFile('memory', content, {})
    const issue = result.issues.find(i => i.code === 'out-of-category')
    expect(issue).toBeDefined()
    expect(issue?.severity).toBe('error')
    expect(issue?.autoFixable).toBe(false)
    // 超三类内容绝不自动进记忆文件（T8 核心验证由管线保证）
    expect(result.ok).toBe(false)
  })

  it('memory files without a date heading get a fixable heading issue', () => {
    const result = validateMemoryFile('memory', '- 规则：x\n', {})
    expect(result.issues.some(i => i.code === 'missing-date-heading' &&  i.autoFixable)).toBe(true)
  })

  it('plain compliant memory content passes cleanly', () => {
    const content = [
      '## 2026-08-22',
      '- 规则：临时文件一律放 .temp/',
      '- 项目指针：docs/CHANGELOG.md',
      '- 完成：guard 插件上线',
      '',
    ].join('\n')
    const result = validateMemoryFile('memory', content, {})
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('logs: overlong lines are fixable-shrink issues, temporary markers are warnings', () => {
    const long = 'x'.repeat(201)
    const result = validateMemoryFile('log', `## 2026-08-22\n- ${long}\n- [待定] review 方案\n`, {})
    expect(result.issues.some(i => i.code === 'line-too-long' &&  i.autoFixable)).toBe(true)
    expect(result.issues.some(i => i.code === 'temporary-marker' && i.severity === 'warning')).toBe(true)
  })

  it('reflections: accepts a dated independent document, flags a missing date heading', () => {
    const good = validateMemoryFile('reflection', '# 反思 2026-08-22\n\n## 成果回顾\n- x\n', {})
    expect(good.ok).toBe(true)
    const bad = validateMemoryFile('reflection', 'no heading here\n', {})
    expect(bad.issues.some(i => i.code === 'missing-date-heading')).toBe(true)
  })

  it('summary: enforces the 5 sections and the 50-line budget (计划 v18 §3.6)', () => {
    const good = [
      '# 对话历史摘要',
      '> 生成时间：2026-08-22 10:30',
      '> 覆盖范围：第 3-8 轮（保留最近 2 轮原文）',
      '> 压缩策略：基于内容甄别的结构化摘要（已过时/无用内容已归档）',
      '## Primary Request',
      '- p1',
      '## Key Concepts',
      '- k1',
      '## Files',
      '- f1',
      '## Errors',
      '- e1',
      '## Pending Jobs',
      '- j1',
      '',
    ].join('\n')
    expect(validateMemoryFile('summary', good, {}).ok).toBe(true)
    // 缺一节
    const missingSection = good.replace('## Pending Jobs', '## Anything Else')
    expect(validateMemoryFile('summary', missingSection, {}).issues.some(i => i.code === 'summary-missing-section')).toBe(true)
    // 超 50 行
    const tooLong = Array.from({ length: 60 }, () => '- line').join('\n')
    expect(validateMemoryFile('summary', tooLong, {}).issues.some(i => i.code === 'summary-too-long')).toBe(true)
  })

  it('suggestions: runs the JSON structure validation', () => {
    const result = validateMemoryFile('suggestions', '{ nope', {})
    expect(result.issues.some(i => i.code === 'suggestions-unreadable')).toBe(true)
  })

  it('unknown kinds fall back to a generic ok with no issues', () => {
    const result = validateMemoryFile('calendar', 'anything', {})
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('user-entries kind is a dedicated no-op kind (L-1: 不当日志校验/规范化)', () => {
    const result = validateMemoryFile('user-entries', '[source=user] [target=memory] 任意内容\n- 内容\n', {})
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })
})

describe('issue shape', () => {
  it('issues are structured with severity + autoFixable for machine handling (T2)', () => {
    const result = validateMemoryFile('log', `## 2026-08-22\n- ${'y'.repeat(300)}\n`, {})
    const issue: ValidationIssue | undefined = result.issues[0]
    expect(typeof issue?.severity).toBe('string')
    expect(typeof issue?.autoFixable).toBe('boolean')
  })
})

describe('parseUserEntries (用户授意入口 v2 §2.3 格式), 防线 2', () => {
  const valid = [
    '[source=user] [target=memory] 用户说："工作完成后必须立即记录"',
    '- 用户偏好：工作完成后立即记录到工作区文档，不询问',
  ].join('\n')

  it('parses a header + content block into one entry (source/target/project/quote/content/raw)', () => {
    const entries = parseUserEntries(valid)
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.headerLine).toBe(1)
    expect(entry?.source).toBe('user')
    expect(entry?.target).toBe('memory')
    expect(entry?.project).toBeNull()
    expect(entry?.quote).toBe('工作完成后必须立即记录')
    expect(entry?.content).toBe('用户偏好：工作完成后立即记录到工作区文档，不询问')
    expect(entry?.raw).toBe(valid)
  })

  it('parses multiple entries and skips comments/blank lines', () => {
    const text = [
      '# 用户授意条目',
      '',
      '<!-- 用户授意条目 -->',
      '[source=user] [target=user] 用户说："重启 dsh 是用户专属操作"',
      '- 重启 dsh 是用户专属操作，主 agent 不得自行重启',
      '',
      '[source=user] [target=project] [project=dsh-memory-manager] 用户说："插件模块化设计要清晰"',
      '- 完成：插件模块化设计评审',
      '',
    ].join('\n')
    const entries = parseUserEntries(text)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.target).toBe('user')
    expect(entries[0]?.headerLine).toBe(4)
    expect(entries[1]?.target).toBe('project')
    expect(entries[1]?.project).toBe('dsh-memory-manager')
    expect(entries[1]?.headerLine).toBe(7)
  })

  it('joins multiple consecutive content lines with newline (内容行不丢失)', () => {
    const text = [
      '[source=user] [target=memory] 用户说："记录项目规划"',
      '- 完成：项目规划',
      '- 指针：docs/CHANGELOG.md',
    ].join('\n')
    const entries = parseUserEntries(text)
    expect(entries[0]?.content).toBe('完成：项目规划\n指针：docs/CHANGELOG.md')
    expect(entries[0]?.raw).toContain('- 完成：项目规划')
  })

  it('ignores a bullet line without an open entry header (孤立内容行)', () => {
    const entries = parseUserEntries('- 无标题的内容行\n\n')
    expect(entries).toHaveLength(0)
  })

  it('handles a bare dash bullet and a stray non-bullet line while an entry is open', () => {
    const text = [
      '[source=user] [target=memory] 用户说："x"',
      '-',     // 裸 - 内容行 → 空内容 (missing-content 由校验判)
      '无关行', // 条目打开时的非内容行 → 忽略
    ].join('\n')
    const entries = parseUserEntries(text)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.content).toBe('')
    expect(entries[0]?.raw).toBe('[source=user] [target=memory] 用户说："x"\n-')
  })

  it('a header without a [target=] tag yields target=null (invalid-target 判给校验)', () => {
    const entries = parseUserEntries('[source=user] 用户说："x"\n- 内容\n')
    expect(entries[0]?.target).toBeNull()
  })

  it('a quoted-but-empty attribution yields no quote (missing-quote 判给校验)', () => {
    const entries = parseUserEntries('[source=user] [target=memory] 用户说：" "\n- 内容\n')
    expect(entries[0]?.quote).toBeNull()
  })

  it('accepts a tag-less entry header (有 target 无 source → source=null, 由校验判 missing-source)', () => {
    const entries = parseUserEntries('[target=memory] 用户说："工作完成后必须记录"\n- 内容\n')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.source).toBeNull()
    expect(entries[0]?.target).toBe('memory')
  })

  it('extracts quotes in 用户说：/裸引号/中文引号 forms (风险表容错)', () => {
    const ascii = parseUserEntries('[source=user] [target=memory] 用户说："工作完成后必须记录"\n- 用户偏好：x\n')
    expect(ascii[0]?.quote).toBe('工作完成后必须记录')
    const cn = parseUserEntries('[source=user] [target=memory] 用户说：「重启是用户专属操作」\n- 用户偏好：x\n')
    expect(cn[0]?.quote).toBe('重启是用户专属操作')
    const bare = parseUserEntries('[source=user] [target=memory] "工作完成后必须记录"\n- 用户偏好：x\n')
    expect(bare[0]?.quote).toBe('工作完成后必须记录')
  })
})

describe('validateUserEntry (防线 2: source 强制 / 原话引用必需 / target 合法 / 三类校验)', () => {
  function entry(source: string, target: string, extra = '', quote = '用户说："工作完成后必须立即记录"', content = '- 用户偏好：工作完成后立即记录，不询问'): string {
    return `[source=${source}] [target=${target}]${extra === '' ? '' : ` ${extra}`} ${quote}\n${content}\n`
  }

  it('write: 合法条目 (source=user + 引用 + target + 三类合规内容) 放行', () => {
    const parsed = parseUserEntries(entry('user', 'memory'))[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('write')
    expect(result.issues).toEqual([])
  })

  it('skip: source ≠ user → 静默跳过 (不写目标, 不写 pending-review)', () => {
    const parsed = parseUserEntries(entry('agent', 'memory'))[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('skip')
    expect(result.issues.some(i => i.code === 'invalid-source')).toBe(true)
  })

  it('pending-review: 无 source 标签 (伪造条目)', () => {
    const parsed = parseUserEntries('[target=memory] 用户说："x"\n- 用户偏好：x\n')[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('pending-review')
    expect(result.issues.some(i => i.code === 'missing-source')).toBe(true)
  })

  it('pending-review: 无用户原话引用 (反伪造核心, 防线 2)', () => {
    const parsed = parseUserEntries('[source=user] [target=memory] 一些没有引用标识的内容\n- 用户偏好：x\n')[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('pending-review')
    expect(result.issues.some(i => i.code === 'missing-quote')).toBe(true)
  })

  it('pending-review: 非法 target', () => {
    const parsed = parseUserEntries(entry('user', 'bogus'))[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('pending-review')
    expect(result.issues.some(i => i.code === 'invalid-target')).toBe(true)
  })

  it('pending-review: target=project 缺 project 名 或 项目名非法 (防路径穿越)', () => {
    const missing = parseUserEntries(entry('user', 'project', '', '用户说："x"', '- 用户偏好：x'))[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    expect(validateUserEntry(missing).issues.some(i => i.code === 'missing-project')).toBe(true)
    const traversal = parseUserEntries(entry('user', 'project', '[project=../evil]', '用户说："x"', '- 用户偏好：x'))[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    expect(validateUserEntry(traversal).disposition).toBe('pending-review')
    expect(validateUserEntry(traversal).issues.some(i => i.code === 'invalid-project')).toBe(true)
  })

  it('pending-review: 缺内容行', () => {
    const parsed = parseUserEntries('[source=user] [target=memory] 用户说："x"\n')[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    expect(validateUserEntry(parsed).issues.some(i => i.code === 'missing-content')).toBe(true)
  })

  it('pending-review: 引用与内容逐字相同 (quote-content-mismatch, 反伪造启发)', () => {
    const parsed = parseUserEntries('[source=user] [target=memory] 用户说："规则：重启必须用户操作"\n- 规则：重启必须用户操作\n')[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('pending-review')
    expect(result.issues.some(i => i.code === 'quote-content-mismatch')).toBe(true)
  })

  it('pending-review: 内容超三类 (non-compliant)', () => {
    const parsed = parseUserEntries('[source=user] [target=memory] 用户说："今天天气不错"\n- 今天天气不错，心情很好\n')[0] as NonNullable<ReturnType<typeof parseUserEntries>[0]>
    const result = validateUserEntry(parsed)
    expect(result.disposition).toBe('pending-review')
    expect(result.issues.some(i => i.code === 'out-of-category')).toBe(true)
  })
})

describe('resolveTargetPath (v2 §2.5 写入映射表 + M-2 项目路径约束)', () => {
  const paths = resolveMemoryPaths('/ws', '/home/u')
  const now = new Date('2026-08-22T10:00:00Z')

  it('maps memory/user to the user-level memory files', () => {
    expect(resolveTargetPath('memory', null, now, paths)).toBe('/home/u/.dsh/memory/MEMORY.md')
    expect(resolveTargetPath('user', null, now, paths)).toBe('/home/u/.dsh/memory/USER.md')
  })

  it('maps project to <workspace>/projects/<name>/docs/MEMORY.md (枚举路径)', () => {
    expect(resolveTargetPath('project', 'dsh-memory-manager', now, paths)).toBe('/ws/projects/dsh-memory-manager/docs/MEMORY.md')
  })

  it('maps log to the daily log under .dsh-memory (YYYY-MM-DD)', () => {
    expect(resolveTargetPath('log', null, now, paths)).toBe('/ws/.dsh-memory/2026-08-22.md')
  })

  it('returns null for missing/invalid project names (不生成越界路径)', () => {
    expect(resolveTargetPath('project', null, now, paths)).toBeNull()
    expect(resolveTargetPath('project', '', now, paths)).toBeNull()
    expect(resolveTargetPath('project', '../evil', now, paths)).toBeNull()
    expect(resolveTargetPath('project', 'has space', now, paths)).toBeNull()
  })
})
