/**
 * Subagent guard: caps concurrent subagent starts and force-disposes idle or
 * zombie runs so runaway delegation cannot permanently exhaust the harness.
 *
 * Design notes (per the reviewed plan):
 * - The `subagent/end` listener matches by `info.id` (SessionId), which equals
 *   `run.id`, NOT `info.runId` (a random UUID) — see `observeRun` in the
 *   subagent package.
 * - Per-run metadata (`lastSeenCount`/`lastEventTime`) lives in each entry of
 *   `activeRuns`; nothing is shared across runs.
 * - A module-level `_guardInstalled` flag prevents double-wrapping under HMR;
 *   the disposer restores `originalStart` and clears the flag.
 * - The watchdog is an async-generator fiber effect; cordis accepts
 *   `AsyncIterable` effects and interrupts the generator on dispose.
 *
 * @module @deepseek-ai/dsh-subagent-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig } from './config.ts'
import type { RawConfig } from './types.ts'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent/src/types.ts'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'

export const name = 'subagent-guard'
export const inject = ['subagents', 'sessions'] as const

// H5 fix: module-level flag prevents double wrapping across hot reloads.
let _guardInstalled = false

export function apply(ctx: Context, rawConfig: RawConfig = {}): void | (() => void) {
  // L3(a): `enabled: false` bypasses every interception.
  const config = resolveConfig(rawConfig, ctx.logger)
  if (!config.enabled) {
    ctx.logger.info('[subagent-guard] disabled, bypass')
    return
  }

  // H5: bind the original start BEFORE the re-entrancy check so a rejected
  // re-apply can never capture an already-wrapped implementation. Keep the
  // unbound reference too, so the disposer restores the exact original start.
  const originalUnbound = ctx.subagents.start
  const originalStart = originalUnbound.bind(ctx.subagents)

  if (_guardInstalled) return
  _guardInstalled = true

  let currentActive = 0
  // H1: per-run metadata — nothing shared across runs.
  const activeRuns = new Map<SessionId, {
    startedAt: number
    run: SubagentRun
    lastSeenCount: number
    lastEventTime: number
  }>()

  // M4: register the end listener exactly once, in apply, not per start.
  // H0: match by info.id (SessionId = run.id), never by info.runId (UUID).
  const offEnd = ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    if (activeRuns.has(info.id)) {
      activeRuns.delete(info.id)
      currentActive--
    }
  })

  ctx.subagents.start = async (name, request) => {
    if (currentActive >= config.maxConcurrent) {
      ctx.logger.warn(`[subagent-guard] 拒绝：子代理并发已达上限（${config.maxConcurrent}）`)
      throw new Error(`当前活跃子代理已达上限（${config.maxConcurrent}），子代理并发已满`)
    }

    // H3: never leak a slot when the underlying start fails.
    let run: SubagentRun
    try {
      currentActive++
      run = await originalStart(name, request)
    } catch (e) {
      currentActive--
      throw e
    }

    activeRuns.set(run.id, {
      startedAt: Date.now(),
      run,
      lastSeenCount: -1,
      lastEventTime: 0,
    })

    return run
  }

  // Idle watchdog: an async-generator fiber effect, interruptible on dispose.
  const watchdog = ctx.effect(async function* idleWatchdog() {
    while (true) {
      // Cordis awaits each yielded value in its effect runner; typing it as
      // a Disposable satisfies `Effect` while the promise keeps the cadence.
      yield new Promise<void>(res => setTimeout(res, config.idlePollMs)) as unknown as () => void
      try {
        for (const [runId, meta] of activeRuns) {
          // M2: remote runs have no local session — pure startedAt timeout.
          const session = ctx.sessions.get(runId)
          if (!session) {
            if (Date.now() - meta.startedAt > config.idleTimeoutMs) {
              ctx.logger.warn(`[subagent-guard] 释放远端僵尸 run=${runId}`)
              await meta.run.dispose()
              if (activeRuns.has(runId)) {
                activeRuns.delete(runId)
                currentActive--
              }
            }
            continue
          }

          const events = session.events
          const currentCount = events.length

          if (currentCount === meta.lastSeenCount) {
            const idleMs = Date.now() - meta.lastEventTime
            if (idleMs > config.idleTimeoutMs) {
              ctx.logger.warn(`[subagent-guard] 释放僵尸 run=${runId}`)
              await meta.run.dispose()
              if (activeRuns.has(runId)) {
                activeRuns.delete(runId)
                currentActive--
              }
            }
          } else {
            meta.lastSeenCount = currentCount
            meta.lastEventTime = events[currentCount - 1]?.time ?? meta.startedAt
          }
        }
      } catch (e) {
        ctx.logger.warn(`[subagent-guard] 空闲检测异常: ${e}`)
        // fail-open: never kill on watchdog failure.
      }
    }
  }, 'subagent-guard.idleWatchdog')

  // H5: disposer restores the original start, resets the flag, and tears down
  // every guard-owned resource. Note: cordis has no ctx.off — ctx.on returns
  // a disposer, which is what offEnd is.
  return () => {
    ctx.subagents.start = originalUnbound
    _guardInstalled = false
    activeRuns.clear()
    currentActive = 0
    offEnd()
    void watchdog()
  }
}
