import { describe, expect, it } from 'vitest'
import {
  classifyEntryLine,
  parseSuggestionEntries,
  validateSuggestionTarget,
  validateMemoryFile,
  type ValidationIssue,
} from '../src/shared/validators.ts'

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
})

describe('issue shape', () => {
  it('issues are structured with severity + autoFixable for machine handling (T2)', () => {
    const result = validateMemoryFile('log', `## 2026-08-22\n- ${'y'.repeat(300)}\n`, {})
    const issue: ValidationIssue | undefined = result.issues[0]
    expect(typeof issue?.severity).toBe('string')
    expect(typeof issue?.autoFixable).toBe('boolean')
  })
})
