/**
 * Subagent guard: caps concurrent subagent activations and force-disposes idle
 * or zombie activations so runaway delegation cannot permanently exhaust the
 * harness.
 *
 * Design notes (per the reviewed plan, re-based on the 0.2.2 activation API):
 * - 0.2.2 replaced `runtime.start(name, request) -> SubagentRun` with
 *   `runtime.startActivation(spec) -> SubagentActivation`; the wrapper below
 *   keeps the same admission/limit/disposal policy over the new entry point.
 * - The `subagent/end` listener matches by `info.id`, which is the activation's
 *   durable `childId` — NOT `info.runId` (a random UUID per epoch).
 * - Per-activation metadata (`lastSeenCount`/`lastEventTime`) lives in each
 *   entry of `activeRuns`; nothing is shared across activations.
 * - A module-level `_guardInstalled` flag prevents double-wrapping under HMR;
 *   the disposer restores `originalStartActivation` and clears the flag.
 * - The watchdog is an async-generator fiber effect; cordis accepts
 *   `AsyncIterable` effects and interrupts the generator on dispose.
 * - Idle disposal calls `activation.dispose()` (the exact-activation teardown),
 *   never a later resume of the same child.
 *
 * @module @deepseek-ai/dsh-subagent-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  SubagentActivation,
  SubagentActivationSpec,
  SubagentRunEndInfo,
} from '@deepseek-ai/dsh-subagent'
import { resolveConfig } from './config.ts'
import type { RawConfig } from './types.ts'

export const name = 'subagent-guard'
export const inject = ['subagents', 'sessions']

// H5 fix: module-level flag prevents double wrapping across hot reloads.
let _guardInstalled = false

/**
 * 0.2.2 的 `startActivation` 是重载方法（带保留 childId 时返回值附带 messageId）。
 * 这个别名只用于给 bind 后的原方法一个可调用的实现签名，包装层仍按重载声明。
 */
type StartActivationCore = (spec: SubagentActivationSpec) => Promise<SubagentActivation>

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
  // eslint-disable-next-line @typescript-eslint/unbound-method -- 有意：disposer 需用未绑定原引用恢复，调用走下方 bind 版
  const originalUnbound = ctx.subagents.startActivation
  const originalStart: StartActivationCore = originalUnbound.bind(ctx.subagents)

  if (_guardInstalled) return
  _guardInstalled = true

  let currentActive = 0
  // H1: per-activation metadata — nothing shared across activations.
  const activeRuns = new Map<SessionId, {
    startedAt: number
    /** Exact-activation teardown retained for the idle watchdog. */
    dispose: () => Promise<void>
    lastSeenCount: number
    lastEventTime: number
  }>()

  // M4: register the end listener exactly once, in apply, not per start.
  // H0: match by info.id (durable childId), never by info.runId (UUID).
  const offEnd = ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    if (activeRuns.has(info.id)) {
      activeRuns.delete(info.id)
      currentActive--
    }
  })

  // 重载声明保持 0.2.2 服务面的返回值形状：带保留 childId 的调用仍返回 messageId。
  function guardedStart(
    spec: SubagentActivationSpec & { readonly childId: SessionId },
  ): Promise<SubagentActivation & { readonly messageId: MessageId }>
  function guardedStart(spec: SubagentActivationSpec): Promise<SubagentActivation>
  async function guardedStart(spec: SubagentActivationSpec): Promise<SubagentActivation> {
    if (currentActive >= config.maxConcurrent) {
      ctx.logger.warn(`[subagent-guard] 拒绝：子代理并发已达上限（${config.maxConcurrent}）`)
      throw new Error(`当前活跃子代理已达上限（${config.maxConcurrent}），子代理并发已满`)
    }

    // H3: never leak a slot when the underlying start fails.
    let activation: SubagentActivation
    try {
      currentActive++
      activation = await originalStart(spec)
    } catch (e) {
      currentActive--
      throw e
    }

    // childId 是持久身份，`subagent/end` 的 info.id 与它同源。
    activeRuns.set(activation.childId, {
      startedAt: Date.now(),
      dispose: () => activation.dispose(),
      lastSeenCount: -1,
      lastEventTime: 0,
    })

    return activation
  }

  ctx.subagents.startActivation = guardedStart

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
              ctx.logger.warn(`[subagent-guard] 释放远端僵尸 activation=${runId}`)
              await meta.dispose()
              if (activeRuns.has(runId)) {
                activeRuns.delete(runId)
                currentActive--
              }
            }
            continue
          }

          const events = session.snapshotEvents()
          const currentCount = events.length

          if (currentCount === meta.lastSeenCount) {
            const idleMs = Date.now() - meta.lastEventTime
            if (idleMs > config.idleTimeoutMs) {
              ctx.logger.warn(`[subagent-guard] 释放僵尸 activation=${runId}`)
              await meta.dispose()
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
        ctx.logger.warn(`[subagent-guard] 空闲检测异常: ${String(e)}`)
        // fail-open: never kill on watchdog failure.
      }
    }
  }, 'subagent-guard.idleWatchdog')

  // H5: disposer restores the original start, resets the flag, and tears down
  // every guard-owned resource. Note: cordis has no ctx.off — ctx.on returns
  // a disposer, which is what offEnd is.
  return () => {
    ctx.subagents.startActivation = originalUnbound
    _guardInstalled = false
    activeRuns.clear()
    currentActive = 0
    offEnd()
    void watchdog()
  }
}
