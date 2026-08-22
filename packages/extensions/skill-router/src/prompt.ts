/**
 * Classifier prompt construction. The classifier output decides which skills
 * stay visible; the effect depends almost entirely on prompt quality, so the
 * prompt is a fixed template over a dynamic list of the actual available
 * skills (read from the catalog) plus a few few-shot task→outcome examples.
 *
 * @module @deepseek-ai/dsh-skill-router
 */

import type { SkillCatalogEntry } from './types.ts'

/**
 * A few-shot example pair: a user task and the skills that should stay exposed.
 */
export interface FewShotExample {
  readonly task: string
  readonly shouldInclude: readonly string[]
  readonly reason: string
}

/** The fixed instruction block shared by every classification run. */
const RULES = [
  'You are a skill router for an execution agent. Given a user message and the list of available skills, decide which skills should stay exposed to the model for THIS task only.',
  '',
  'Rules:',
  '- If the task is about PLANNING, writing docs, configuration or prose (a plan, a report, design notes, reviews, meeting notes) -> keep only documentation/planning related skills; drop code-execution and code-edit skills.',
  '- If the task is about CODING, IMPLEMENTATION, debugging, or editing source files -> keep the skills relevant to that work (filesystem, search, editing, build/test, subagent, etc.).',
  '- If the task is ambiguous or you are unsure -> return the minimal safe set (never return an empty response when skills are available).',
  '- Only return names that exist in the provided list. Do not invent skill names.',
  '',
  'Respond with a single JSON value: either an object {"included": ["skill-a", ...], "reason": "..."} '
  + 'or, for short answers, a bare JSON array of names like ["skill-a", "skill-b"].',
].join('\n')

/** A small default few-shot bank; tuned further during T8 manual validation. */
const DEFAULT_FEWSHOT: FewShotExample[] = [
  {
    task: 'Write a project plan and a milestone document for phase 2.',
    shouldInclude: ['editing-cordis-compositions'],
    reason: 'planning/doc task: only doc/planning skills needed',
  },
  {
    task: 'Refactor the classifier module and add unit tests.',
    shouldInclude: ['editing-cordis-compositions'],
    reason: 'coding task: code skills stay available',
  },
]

/**
 * Build the full classifier prompt for one request.
 * @param userMessage - the user's latest message text (trimmed).
 * @param available - the dynamic skill list read from the catalog.
 * @param context - workspace/preset/session context.
 */
export function buildSystemPrompt(
  userMessage: string,
  available: readonly SkillCatalogEntry[],
  context: { workspacePath: string; presetId: string },
): string {
  const skillLines = available.length === 0
    ? ['(none)']
    : available.map(entry => `- ${entry.name}: ${entry.description}`)
  const fewShot = DEFAULT_FEWSHOT
    .map(ex => [
      `User task: ${ex.task}`,
      `Include: ${JSON.stringify(ex.shouldInclude)}`,
      `Reason: ${ex.reason}`,
    ].join('\n'))
    .join('\n\n')

  return [
    RULES,
    '',
    `Workspace path: ${context.workspacePath}`,
    `Agent/preset: ${context.presetId}`,
    '',
    'Available skills:',
    ...skillLines,
    '',
    'Few-shot examples:',
    fewShot,
    '',
    `User task: ${userMessage}`,
    'Your response (JSON only):',
  ].join('\n')
}
