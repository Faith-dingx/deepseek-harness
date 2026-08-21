import { describe, expect, it } from 'vitest'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { READ_ONLY_TOOLS, WRITE_TOOLS_TO_CUT } from '../src/config.ts'
import { cutMemoryWriteTools } from '../src/tool-cut.ts'

function tool(name: string): ToolSchema {
  return { name, description: `tool ${name}`, parameters: {} }
}

const readTools = READ_ONLY_TOOLS.map(tool)
const writeTools = WRITE_TOOLS_TO_CUT.map(tool)
const otherTools = [tool('read'), tool('grep'), tool('bash'), tool('write'), tool('edit')]
/** Realistic mixed input: 5 read + 10 write + 5 unrelated tools. */
const mixed = [...readTools, ...writeTools, ...otherTools]

describe('dsh-injection-manager tool cut (计划 v12 T2)', () => {
  it('keeps the 5 read-only memory tools', () => {
    const kept = cutMemoryWriteTools(mixed).map(t => t.name)
    for (const name of READ_ONLY_TOOLS) {
      expect(kept).toContain(name)
    }
  })

  it('removes the 10 memory write tools', () => {
    const kept = cutMemoryWriteTools(mixed).map(t => t.name)
    for (const name of WRITE_TOOLS_TO_CUT) {
      expect(kept).not.toContain(name)
    }
  })

  it('leaves non-memory tools untouched and in relative order', () => {
    const kept = cutMemoryWriteTools(mixed).map(t => t.name)
    expect(kept).toEqual([...READ_ONLY_TOOLS, ...otherTools.map(t => t.name)])
  })

  it('returns a new array and does not mutate the input', () => {
    const input = [...mixed]
    const output = cutMemoryWriteTools(input)
    expect(output).not.toBe(input)
    expect(input.map(t => t.name)).toEqual(mixed.map(t => t.name))
  })

  it('is purely static: write tools are cut wherever they appear and other tools keep their order', () => {
    const scrambled = [...otherTools, ...readTools, ...writeTools]
    const kept = cutMemoryWriteTools(scrambled)
    expect(kept.map(t => t.name)).toEqual([...otherTools.map(t => t.name), ...READ_ONLY_TOOLS])
  })

  it('keeps empty and all-write inputs stable (no crash, no surprise tools)', () => {
    expect(cutMemoryWriteTools([])).toEqual([])
    expect(cutMemoryWriteTools(writeTools)).toEqual([])
  })
})
