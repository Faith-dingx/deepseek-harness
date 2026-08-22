/**
 * 触发时机 (计划 v18 §4.2.1): turn/end. `trigger.ts` decides WHEN to compress
 * (turn >= threshold, once per turn per session, replay-safe) and WHICH turns
 * to compress (turns 3..turn-retain, keeping the most recent turns verbatim).
 * Firing is fire-and-forget + fail-open: a handler rejection is swallowed so
 * the trigger can never break the turn lifecycle.
 *
 * @module dsh-memory-manager/history-compressor/trigger
 */

/** Tapped on a turn/end boundary; failures are contained by the trigger. */
export type TurnTriggerHandler = (sessionId: string, turn: number) => Promise<void> | void

/** Trigger configuration (threshold from config.triggerThresholdTurns). */
export interface TurnTriggerOptions {
  readonly thresholdTurns: number
}

/** The turn window a compression pass should fold into a summary. */
export interface CompressionRange {
  readonly from: number
  readonly to: number
}

/**
 * Which turns get compressed: from the first compressible turn (3) up to
 * `turn - retainRecentTurns`. Null when history is too short or the window is
 * empty — the most recent turns always stay verbatim (计划 v18 §4.2.4).
 */
export function turnCompressionRange(turn: number, retainRecentTurns: number): CompressionRange | null {
  // history 达到 threshold 轮才开始压缩
  if (turn < 8) return null
  const to = turn - retainRecentTurns
  if (to < 3) return null
  return { from: 3, to }
}

/**
 * Per-session turn/end tracker: fires the handler once per turn, at/above the
 * threshold, never for already-processed turns (turn replay or restored
 * sessions must not re-trigger compression).
 */
export class TurnTrigger {
  private readonly processed = new Map<string, number>()

  constructor(private readonly options: TurnTriggerOptions) {}

  /** Handle one turn/end. Fires async; errors are swallowed (fail-open). */
  onTurnEnd(sessionId: string, turn: number, handler: TurnTriggerHandler): void {
    if (turn < this.options.thresholdTurns) return
    const last = this.processed.get(sessionId) ?? 0
    if (turn <= last) return
    this.processed.set(sessionId, turn)
    void Promise.resolve(handler(sessionId, turn)).catch((error: unknown) => {
      // fail-open: a compressor failure must never break the turn lifecycle.
      console.warn(`[dsh-memory-manager] turn/end handler failed (${sessionId}#${turn}): ${error instanceof Error ? error.message : String(error)}`)
    })
  }
}
