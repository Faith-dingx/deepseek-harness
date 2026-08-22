/**
 * 步骤③ 与之前版本对比 (计划 v18 §5.2 / T4). Longest-common-subsequence
 * line diff, producing structured add/delete/modify changes. The result is a
 * plain JSON-serializable array (T4: diff 结果可序列化). LCS cost is
 * O(n*m) cells over Uint16Array tables — fine for the memory-file scale
 * (≥1000 lines in well under a second).
 *
 * @module dsh-memory-manager/audit-pipeline/diff
 */

/* oxlint-disable typescript/no-non-null-assertion -- Every indexed read in
 * diffLines is bounded by construction: the LCS table is (a.length+1) x
 * (b.length+1) and the backtrack loops stay inside [0, a.length) x
 * [0, b.length). The assertions document those loop invariants. */

/** One structured line-level change. */
export type DiffChange =
  | { readonly type: 'add'; readonly line: number; readonly content: string }
  | { readonly type: 'delete'; readonly line: number; readonly content: string }
  | { readonly type: 'modify'; readonly line: number; readonly before: string; readonly after: string }

function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const parts = content.split('\n')
  // A trailing newline is a terminator, not an empty extra line.
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * Diff `before` against `after` line by line. Returns the add/delete/modify
 * changes; an adjacent delete+add pair on the same position collapses into a
 * single modify. `line` is 1-based in the AFTER document.
 */
export function diffLines(before: string, after: string): DiffChange[] {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length === 0) return b.map((content, i) => ({ type: 'add', line: i + 1, content }) as const)
  if (b.length === 0) return a.map(content => ({ type: 'delete', line: 1, content }) as const)

  // LCS length table (Uint16Array per row: bounded by typical memory files).
  const table: Uint16Array[] = Array.from(
    { length: a.length + 1 },
    () => new Uint16Array(b.length + 1),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = table[i]!
    const nextRow = table[i + 1]!
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!)
    }
  }

  const changes: DiffChange[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      changes.push({ type: 'delete', line: j + 1, content: a[i]! })
      i += 1
    } else {
      changes.push({ type: 'add', line: j + 1, content: b[j]! })
      j += 1
    }
  }
  while (i < a.length) {
    changes.push({ type: 'delete', line: j + 1, content: a[i]! })
    i += 1
  }
  while (j < b.length) {
    changes.push({ type: 'add', line: j + 1, content: b[j]! })
    j += 1
  }
  return mergeAdjacentReplacements(changes)
}

/**
 * Collapse an adjacent delete+add pair on the same line into one modify
 * (the LCS backtrack emits a replacement as delete-then-add).
 */
function mergeAdjacentReplacements(changes: readonly DiffChange[]): DiffChange[] {
  const merged: DiffChange[] = []
  for (const change of changes) {
    const last = merged[merged.length - 1]
    if (change.type === 'add' && last?.type === 'delete' && last.line === change.line) {
      merged[merged.length - 1] = { type: 'modify', line: change.line, before: last.content, after: change.content }
    } else {
      merged.push(change)
    }
  }
  return merged
}
