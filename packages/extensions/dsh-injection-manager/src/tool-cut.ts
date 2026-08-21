/**
 * Memory-tool cutting: statically filter the 10 memory write tools out of an
 * assembly's tool list.
 *
 * The cut operates on `assembly.tools` (the assembled PromptAssembly tools,
 * 计划 v12 T2/T5.b) — NOT on the global tool registry (`ctx.tools`), which must
 * stay untouched so introspection/debugging and the write-entry plugin keep
 * working. Purely static: a name is either in WRITE_TOOLS_TO_CUT or not; there
 * is no task classification, no classifier, and no per-agent branch.
 *
 * @module dsh-injection-manager/tool-cut
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { WRITE_TOOLS_TO_CUT } from './config.ts'

const CUT = new Set<string>(WRITE_TOOLS_TO_CUT)

/**
 * Remove the fixed 10 memory write tools from a tool-schema list.
 * @param tools - the assembly's tool list (readonly view; never mutated).
 * @returns a new list without the write tools; the relative order of the
 * surviving tools is preserved.
 */
export function cutMemoryWriteTools(tools: readonly ToolSchema[]): ToolSchema[] {
  return tools.filter(tool => !CUT.has(tool.name))
}
