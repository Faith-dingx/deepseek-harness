import { describe, expect, it } from 'vitest'
import { diffLines, type DiffChange } from '../src/audit-pipeline/diff.ts'

describe('diffLines (计划 v18 §5.2 步骤③, T4)', () => {
  it('returns no changes for identical content', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([])
  })

  it('detects appended lines as adds (行级新增)', () => {
    const changes = diffLines('a\n', 'a\nb\n')
    expect(changes).toEqual([{ type: 'add', line: 2, content: 'b' }])
  })

  it('detects removed lines as deletes (行级删除)', () => {
    const changes = diffLines('a\nb\n', 'a\n')
    expect(changes).toEqual([{ type: 'delete', line: 2, content: 'b' }])
  })

  it('merges an adjacent add+delete pair into a modify', () => {
    const changes = diffLines('a\nold\nc\n', 'a\nnew\nc\n')
    expect(changes).toEqual([{ type: 'modify', line: 2, before: 'old', after: 'new' }])
  })

  it('reports adds and deletes around an inserted block', () => {
    const changes = diffLines('x\ny\n', 'x\nins1\nins2\ny\n')
    expect(changes).toEqual([
      { type: 'add', line: 2, content: 'ins1' },
      { type: 'add', line: 3, content: 'ins2' },
    ])
  })

  it('supports large files efficiently (T4: ≥1000 lines)', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')
    const now = performance.now()
    const changes = diffLines(big, `${big}\nline 1000`)
    expect(changes).toEqual([{ type: 'add', line: 1001, content: 'line 1000' }])
    expect(performance.now() - now).toBeLessThan(2000)
  })

  it('treats empty content as an empty baseline (additions only)', () => {
    expect(diffLines('', 'a\n')).toEqual([{ type: 'add', line: 1, content: 'a' }])
    expect(diffLines('a\n', '')).toEqual([{ type: 'delete', line: 1, content: 'a' }])
  })

  it('produces serializable change structures (T4: diff 结果可序列化)', () => {
    const changes = diffLines('a\n', 'b\n')
    const roundTrip = JSON.parse(JSON.stringify(changes)) as DiffChange[]
    expect(roundTrip).toEqual(changes)
  })
})
