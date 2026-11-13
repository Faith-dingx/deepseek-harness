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
 *     (dedup.ts).
 *
 * The memory-tool cut (③) lives in a SEPARATE mechanism, because 0.2.2-rc.2
 * changed the assembly contract: `system-prompt/assemble` now carries a
 * `PromptPresentation` (sections/contexts/variables) and the tool
 * declarations are attached to the returned `PromptAssembly` AFTER the
 * waterfall resolves (packages/core/system-prompt/src/index.ts). A waterfall
 * listener therefore cannot see `assembly.tools` at all — reading it yields
 * `undefined`, so the cut silently did nothing and (because the transform
 * threw on the undefined list) the whole fail-open path returned the
 * downstream assembly untransformed.
 *
 * The cut is now applied where the tool list is actually built: the tool
 * registry's per-scope visibility. `tools.restrict({ deny })` on the agent's
 * own scope removes the names from that agent's prompt assembly AND from its
 * executable view, while leaving the global registry intact for
 * introspection (same intent as the original `assembly.tools` cut, which also
 * deliberately never touched `ctx.tools`).
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
import type {} from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import { dedup } from './dedup.ts'
import { filterMemoryLayers } from './memory-layer.ts'
import { WRITE_TOOLS_TO_CUT } from './config.ts'

export const name = 'dsh-injection-manager'
export const inject = ['systemPrompt', 'tools']

/** One-liner exception description for the fail-open log line. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Names the tool registry currently exposes globally. `tools.restrict()`
 * rejects a name the registry does not know, so the deny list is intersected
 * with the live global view: the memory write tools are registered by the
 * memory plugin, which may or may not be present in a given deployment.
 */
function restrictableWriteTools(ctx: Context): string[] {
  const known = new Set(ctx.tools.schemas().map((tool: { name: string }) => tool.name))
  return WRITE_TOOLS_TO_CUT.filter(name => known.has(name))
}

export function apply(ctx: Context): void {
  // ③ memory-tool cut: hide the memory write tools from every agent.
  //
  // The restriction is registered on the agent's OWN scope, so it applies to
  // that agent's prompt assembly (the assembly is produced with
  // `scope: agent`) and to its executable view. The global registry is left
  // untouched — introspection and the separate write-entry plugin keep
  // working, exactly as the original `assembly.tools` cut intended.
  ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    const deny = restrictableWriteTools(ctx)
    if (deny.length === 0) return
    try {
      agent.ctx.tools.restrict({ deny })
    } catch (error) {
      // Fail open: a deployment without the memory plugin, or a registry that
      // does not know one of the names, must not break agent creation.
      ctx.logger.warn(
        `[dsh-injection-manager] could not restrict memory write tools: ${errorMessage(error)}; continuing without the cut`,
      )
    }
  })

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

    // ② own transforms, fail-open on any of them.
    try {
      const layered = filterMemoryLayers(assembled.sections, assembled.contexts)
      const deduped = dedup(layered.sections, layered.contexts)
      return {
        ...assembled,
        sections: deduped.sections,
        contexts: deduped.contexts,
      }
    } catch (error) {
      ctx.logger.warn(
        `[dsh-injection-manager] system-prompt/assemble transform failed: ${errorMessage(error)}; fail-open: returning downstream assembly`,
      )
      return assembled
    }
  })
}
