import { describe, expect, it } from 'vitest'
import { buildSummaryInjection, isConversationSummaryName, CONVERSATION_SUMMARY_CONTEXT } from '../src/history-compressor/inject.ts'
import { writeSummaryFile, type SummaryWriteFs } from '../src/history-compressor/write-summary.ts'

describe('inject.ts (计划 v18 §4.2.5 / T15 注入段配置)', () => {
  it('exports the dsh:conversation-summary context name for the whitelist', () => {
    expect(CONVERSATION_SUMMARY_CONTEXT).toBe('dsh:conversation-summary')
  })

  it('builds an injection context from the summary text', () => {
    const injection = buildSummaryInjection('# 对话历史摘要\nbody')
    expect(injection.name).toBe('dsh:conversation-summary')
    expect(injection.text).toBe('# 对话历史摘要\nbody')
  })

  it('recognizes the summary context name (注入管理器白名单协同)', () => {
    expect(isConversationSummaryName('dsh:conversation-summary')).toBe(true)
    expect(isConversationSummaryName('dsh:auto-memory')).toBe(false)
  })
})

describe('writeSummaryFile (计划 v18 §4.2.4/§4.2.3, T15)', () => {
  function memoryFs(): SummaryWriteFs & { files: Map<string, string> } {
    const files = new Map<string, string>()
    return {
      files,
      async writeFile(file, data) { files.set(file, data) },
      async mkdir() {},
    }
  }

  it('registers the pendingWrite BEFORE writing and overwrites the single file', async () => {
    const fs = memoryFs()
    const registered: string[] = []
    const result = await writeSummaryFile('/ws/.dsh-memory/conversationsummary-latest.md', '# 对话历史摘要\nx', (file, source) => { registered.push(`${file}:${source}`) }, fs)
    expect(result.ok).toBe(true)
    expect(registered).toEqual(['/ws/.dsh-memory/conversationsummary-latest.md:history-compressor'])
    expect(fs.files.get('/ws/.dsh-memory/conversationsummary-latest.md')).toBe('# 对话历史摘要\nx')
  })

  it('overwrites the previous summary (单文件覆盖策略, 无时间戳)', async () => {
    const fs = memoryFs()
    fs.files.set('/ws/s.md', 'old summary')
    await writeSummaryFile('/ws/s.md', 'new summary', () => {}, fs)
    expect(fs.files.get('/ws/s.md')).toBe('new summary')
  })

  it('handles a summary file name without a directory (root-dot mkdir)', async () => {
    const fs = memoryFs()
    const result = await writeSummaryFile('latest.md', 'text', () => {}, fs)
    expect(result.ok).toBe(true)
    expect(fs.files.get('latest.md')).toBe('text')
  })

  it('fails open: a write failure resolves with ok=false', async () => {
    const broken: SummaryWriteFs = {
      async writeFile() { throw new Error('EACCES') },
      async mkdir() {},
    }
    const result = await writeSummaryFile('/ws/s.md', 'x', () => {}, broken)
    expect(result.ok).toBe(false)
  })
})
