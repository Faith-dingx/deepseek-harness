/**
 * Static configuration for dsh-injection-manager.
 *
 * Every list here is a hardcoded fixed set: the plugin has NO dynamic
 * classification, NO task-type branching, NO classifier, and NO per-agent
 * logic. The same rules apply to every assembly (root agent and sub-agents).
 *
 * @module dsh-injection-manager/config
 */

/**
 * Read-only memory tools kept in every assembly (global resident, 5 tools).
 * 计划 v12 决策1: these stay visible to the model on every agent.
 */
export const READ_ONLY_TOOLS = [
  'memory_read',
  'memory_recall',
  'memory_search',
  'memory_status',
  'calendar_list',
] as const

/**
 * Memory write / calendar-mutating tools removed from every assembly (10 tools).
 * 计划 v12 决策1: the model can no longer invoke these; writes go through the
 * separate write-entry plugin (dsh-memory-write-entry, T7-T11).
 */
export const WRITE_TOOLS_TO_CUT = [
  'memory_log',
  'memory_note',
  'memory_user',
  'memory_reflect',
  'memory_consolidate',
  'memory_maintain',
  'memory_external',
  'calendar_add',
  'calendar_done',
  'calendar_remove',
] as const

/**
 * Section/context names classified as managed SHORT-TERM memory (keep).
 * 计划 v12 决策2: hardcoded by name; any other name in the memory-plugin
 * namespace is long-term (drop); everything outside the namespace is not the
 * manager's business and passes through untouched.
 */
export const SHORT_TERM_MEMORY_NAMES = [
  'dsh:auto-memory',
  'dsh:auto-memory-rules',
  'memory:profile',
  'memory:standing',
  'memory:failures',
  'memory:project',
] as const
