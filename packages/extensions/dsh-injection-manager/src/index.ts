/**
 * dsh-injection-manager: memory-file and context-injection manager.
 *
 * The plugin registers a `system-prompt/assemble` waterfall listener (计划 v12
 * T1/T5) that runs for EVERY assembly — root agent and sub-agents alike, with
 * no agent branching — and applies, in order:
 *
 *   ① memory-file layering: keep the six known short-term memory names, drop
 *     unknown long-term names inside the memory-plugin namespace, pass
 *     everything else through untouched (memory-layer.ts);
 *   ② minimal dedup: first occurrence of each section/context name wins
 *     (dedup.ts);
 *   ③ memory-tool cut: filter the fixed 10 memory write tools out of
 *     `assembly.tools` — the assembly list, NOT the global `ctx.tools`
 *     registry (tool-cut.ts).
 *
 * Every transformation is wrapped so the plugin FAILS OPEN: any exception
 * returns the downstream assembly (`await next()` result), and a downstream
 * failure returns the original assembly — the system prompt never collapses
 * because of this plugin. Exceptions are logged with event type + reason; no
 * extra monitoring tables are kept.
 *
 * @module @deepseek-ai/dsh-injection-manager
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { dedup } from './dedup.ts'
import { filterMemoryLayers } from './memory-layer.ts'
import { cutMemoryWriteTools } from './tool-cut.ts'

export const name = 'dsh-injection-manager'
export const inject = ['systemPrompt']

/** One-liner exception description for the fail-open log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: Context): void {
  ctx.on('system-prompt/assemble', async (
    assembly: PromptAssembly,
    _context: AssembleContext,
    next: () => Promise<PromptAssembly>,
  ): Promise<PromptAssembly> => {
    // ① downstream first: the waterfall result is authoritative for everything
    // the manager does not own.
    let assembled: PromptAssembly
    try {
      assembled = await next()
    } catch (error) {
      ctx.logger.warn(
        `[dsh-injection-manager] system-prompt/assemble downstream failed: ${errorMessage(error)}; fail-open: returning original assembly`,
      )
      return assembly
    }

    // ②-④ own transforms, fail-open on any of them.
    try {
      const layered = filterMemoryLayers(assembled.sections, assembled.contexts)
      const deduped = dedup(layered.sections, layered.contexts)
      return {
        ...assembled,
        sections: deduped.sections,
        contexts: deduped.contexts,
        tools: cutMemoryWriteTools(assembled.tools),
      }
    } catch (error) {
      ctx.logger.warn(
        `[dsh-injection-manager] system-prompt/assemble transform failed: ${errorMessage(error)}; fail-open: returning downstream assembly`,
      )
      return assembled
    }
  })
}
