# @deepseek-ai/dsh-injection-manager

Memory-file and context-injection manager for DeepSeek Harness. The plugin
listens on `system-prompt/assemble` and applies, to **every** assembly (root
agent and sub-agents alike — no agent branching):

| Transform | What it does | Where |
|-----------|--------------|-------|
| Memory-tool cut | Statically removes the 10 memory write tools (`memory_log`, `memory_note`, `memory_user`, `memory_reflect`, `memory_consolidate`, `memory_maintain`, `memory_external`, `calendar_add`, `calendar_done`, `calendar_remove`) from `assembly.tools`; the 5 read tools (`memory_read`, `memory_recall`, `memory_search`, `memory_status`, `calendar_list`) stay resident. The global `ctx.tools` registry is never touched. | `src/tool-cut.ts` |
| Memory-file layering | Keeps the six known short-term names (`dsh:auto-memory`, `dsh:auto-memory-rules`, `memory:profile`, `memory:standing`, `memory:failures`, `memory:project`), drops unknown long-term names inside the memory-plugin namespace (`memory:*`, `dsh:*`), and passes every non-memory section/context (persona, identity, tool guidance, agent instructions) through untouched. Calendar content lives inside the `dsh:auto-memory` context and needs no separate handling. | `src/memory-layer.ts` |
| Minimal dedup | First occurrence of each section/context name wins; no hashing, no content merging, no priority picking. | `src/dedup.ts` |
| Fail-open | Any exception returns the downstream `await next()` result; a downstream failure returns the original assembly. Exceptions are logged (event type + reason); the system prompt never collapses because of this plugin. | `src/index.ts` |

The tool cut, layer rules, and short-term names are hardcoded fixed sets
(`src/config.ts`): no classifier, no task-type branching, no dynamic logic.

## Mounting

Add to the agent preset's `agent.cordis.yml` after `guard-main-agent`:

```yaml
- id: dsh-injection-manager
  name: '@deepseek-ai/dsh-injection-manager'
```

The package is registered in `apps/cli/package.json` and `tsconfig.host.json`.