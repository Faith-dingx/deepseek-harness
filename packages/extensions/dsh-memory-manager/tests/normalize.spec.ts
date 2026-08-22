import { describe, expect, it } from 'vitest'
import {
  collapseBlankLines,
  findDuplicateLines,
  normalizeBulletPrefix,
  normalizeDateHeading,
  normalizeMemoryContent,
} from '../src/audit-pipeline/normalize.ts'
import type { MemoryFileKind } from '../src/shared/validators.ts'
import { REQUIRED_SUMMARY_SECTIONS } from '../src/shared/validators.ts'

describe('normalizeDateHeading (计划 v18 §5.2 步骤④/⑤ 格式自动修正, T6)', () => {
  it('leaves an existing dated heading untouched', () => {
    expect(normalizeDateHeading('memory', '## 2026-08-22\n- x\n', new Date('2026-08-22'))).toBe('## 2026-08-22\n- x\n')
  })

  it('prepends a heading for memory/log files when missing', () => {
    const out = normalizeDateHeading('memory', '- 规则：x\n', new Date('2026-08-22'))
    expect(out.startsWith('## 2026-08-22\n')).toBe(true)
  })

  it('prepends the reflection-styled heading for reflection files', () => {
    const out = normalizeDateHeading('reflection', 'text\n', new Date('2026-08-22'))
    expect(out.startsWith('# 反思 2026-08-22\n')).toBe(true)
  })

  it('non-dated kinds are untouched', () => {
    expect(normalizeDateHeading('summary', 'body', new Date())).toBe('body')
  })

  it('sanctifies existing other-date headings (已有旧日期标题 → 不改)', () => {
    // 内容是昨天的日期标题, 但结构合法 → 不追加今天的标题
    expect(normalizeDateHeading('memory', '## 2026-08-21\n- 昨天的记录\n', new Date('2026-08-22'))).toBe('## 2026-08-21\n- 昨天的记录\n')
  })

  it('adds the heading to blank content (空内容 → 只写标题)', () => {
    expect(normalizeDateHeading('memory', '   \n', new Date('2026-08-22'))).toBe('## 2026-08-22\n')
    expect(normalizeDateHeading('reflection', '', new Date('2026-08-22'))).toBe('# 反思 2026-08-22\n')
  })
})

describe('normalizeBulletPrefix (T6 条目格式统一)', () => {
  it('fixes bullet items missing the separating space', () => {
    expect(normalizeBulletPrefix('- 规则：x\n-item\n*item\n- 好\n')).toBe('- 规则：x\n- item\n* item\n- 好\n')
  })

  it('does not touch heading/blank lines', () => {
    expect(normalizeBulletPrefix('## 标题\n\n- ok\n')).toBe('## 标题\n\n- ok\n')
  })
})

describe('collapseBlankLines (T6 格式统一)', () => {
  it('collapses runs of blank lines to a single one', () => {
    expect(collapseBlankLines('a\n\n\n\nb\n')).toBe('a\n\nb\n')
  })

  it('collapses leading blank lines away from content start', () => {
    expect(collapseBlankLines('\n\n\na\n')).toBe('a\n')
  })
})

describe('findDuplicateLines (T7 重复条目识别, 只标记不删)', () => {
  it('finds duplicated non-empty lines', () => {
    expect(findDuplicateLines('- 规则：x\n- 规则：y\n- 规则：x\n')).toEqual(['- 规则：x'])
  })

  it('ignores headings, blanks and single occurrences', () => {
    expect(findDuplicateLines('## h\n\n- a\n- b\n')).toEqual([])
  })
})

describe('normalizeMemoryContent (计划 v18 §5.2 步骤④ 校验+规范化, T2/T5/T7)', () => {
  it('auto-fixes fixable format issues and reports them (守门: 不创作内容)', () => {
    const result = normalizeMemoryContent('memory', '-x\n- 今天天气不错\n', { now: new Date('2026-08-22') })
    expect(result.hasFixable).toBe(true)
    expect(result.hasOutOfCategory).toBe(true)
    expect(result.normalized).toBe('## 2026-08-22\n- x\n- 今天天气不错\n')
    expect(result.issues.some(i => i.code === 'out-of-category')).toBe(true)
    // 语义内容未被修改: 天气行原样保留, 只是它被标记为超三类
    expect(result.normalized).toContain('今天天气不错')
  })

  it('returns the content unchanged when nothing needs fixing', () => {
    const content = '## 2026-08-22\n- 规则：重启是用户专属操作\n- 完成：guard 上线\n'
    const result = normalizeMemoryContent('memory', content, { now: new Date('2026-08-22') })
    expect(result.normalized).toBe(content)
    expect(result.issues).toEqual([])
    expect(result.hasFixable).toBe(false)
    expect(result.hasOutOfCategory).toBe(false)
  })

  it('does not touch summary or suggestions kinds (they are validated elsewhere)', () => {
    const result = normalizeMemoryContent('summary', 'body', { now: new Date() })
    expect(result.normalized).toBe('body')
    expect(result.hasFixable).toBe(false)
    expect(result.hasOutOfCategory).toBe(false)
  })

  it('handles every kind without throwing (log/reflection/calendar)', () => {
    for (const kind of ['log', 'reflection', 'calendar'] as MemoryFileKind[]) {
      const result = normalizeMemoryContent(kind, 'plain\n', { now: new Date('2026-08-22') })
      expect(result.normalized.length).toBeGreaterThan(0)
    }
  })

  it('reports duplicate lines through the same result (T7 重复识别)', () => {
    const result = normalizeMemoryContent('memory', '## 2026-08-22\n- 规则：x\n- 规则：x\n', { now: new Date('2026-08-22') })
    expect(result.issues.some(i => i.code === 'duplicate-line')).toBe(true)
  })

  it('applies the maxSummaryLines budget through validateOptions', () => {
    const many = Array.from({ length: 60 }, () => '- line').join('\n')
    const result = normalizeMemoryContent('summary', many, { maxSummaryLines: 55 })
    expect(result.issues.some(i => i.code === 'summary-too-long')).toBe(true)
  })

  it('summary validation surfaces missing sections through the same result (T5)', () => {
    const result = normalizeMemoryContent('summary', '## Key Concepts\n- k\n', { now: new Date() })
    const sectionIssues = result.issues.filter(i => i.code === 'summary-missing-section')
    expect(sectionIssues.length).toBe(REQUIRED_SUMMARY_SECTIONS.length - 1)
  })

  it('defaults now to the current date when omitted (options.now 缺省)', () => {
    const result = normalizeMemoryContent('memory', '-x\n', {})
    // 缺省 now → 用当前日期补标题; 断言标题日期合法即可
    expect(result.normalized).toMatch(/^## \d{4}-\d{2}-\d{2}\n- x\n$/)
  })
})
