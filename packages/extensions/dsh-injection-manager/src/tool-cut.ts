/**
 * Memory-tool cutting: the fixed set of memory write tools the model must not
 * invoke directly.
 *
 * 0.2.2-rc.2 changed the assembly contract: the `system-prompt/assemble`
 * waterfall carries a `PromptPresentation` (sections/contexts/variables) and
 * the tool declarations are attached to the returned `PromptAssembly` AFTER
 * the waterfall resolves. A waterfall listener therefore cannot filter the
 * tool list — the cut moved to the tool registry's per-scope visibility
 * (`tools.restrict({ deny })`), which removes the names from the agent's
 * prompt assembly and from its executable view while leaving the global
 * registry intact for introspection.
 *
 * The pure list filter is kept here as the single definition of the cut, so
 * the deny list and its tests stay in one place; the registry-level
 * restriction is applied in `index.ts`.
 *
 * @module dsh-injection-manager/tool-cut
 */

import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { WRITE_TOOLS_TO_CUT } from './config.ts'

const CUT = new Set<string>(WRITE_TOOLS_TO_CUT)

/**
 * Remove the fixed 10 memory write tools from a tool-schema list.
 * @param tools - the tool list to filter (readonly view; never mutated).
 * @returns a new list without the write tools; the relative order of the
 * surviving tools is preserved.
 */
export function cutMemoryWriteTools(tools: readonly ToolSchema[]): ToolSchema[] {
  return tools.filter(tool => !CUT.has(tool.name))
}
