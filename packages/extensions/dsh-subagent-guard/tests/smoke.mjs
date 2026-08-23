/**
 * Smoke tests for the subagent guard — eight gates covering the reviewed
 * plan's acceptance criteria (H0/H1/H3/H5/L3/M2/M4).
 *
 * Run with: pnpm test:smoke
 */
import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'
import { Config, resolveConfig } from '../src/config.ts'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let seq = 0
function fakeRun(id) {
  const run = {
    id,
    localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' }),
    disposed: false,
  }
  run.dispose = async () => { run.disposed = true }
  return run
}

/** Build a mock cordis context around the guard's inject surface. */
function makeHarness({ getSession = () => undefined, startImpl } = {}) {
  const listeners = {}
  let generator = null
  const ctx = {
    subagents: {
      start: startImpl ?? (async () => fakeRun(`sess-${++seq}`)),
    },
    sessions: { get: getSession },
    logger: { info: () => {}, warn: () => {} },
    on: (name, listener) => {
      listeners[name] = listener
      return () => { delete listeners[name] }
    },
    effect: (fn) => {
      generator = fn()
      // Cordis `Disposable` is a callable (() => T); the disposer may also be
      // invoked through this function.
      return () => { generator = null }
    },
  }
  return {
    ctx,
    originalStart: ctx.subagents.start,
    emit: (name, payload) => listeners[name]?.(payload),
    /** Advance the captured watchdog generator by one iteration. */
    tick: async () => { if (generator) await generator.next() },
  }
}

let passed = 0
async function gate(name, fn) {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}

await gate('1. Config defaults', () => {
  const defaults = Config({})
  assert.deepEqual(defaults, { maxConcurrent: 2, idleTimeoutMs: 600000, idlePollMs: 30000, enabled: true })
  // Bounds: out-of-range falls back to default, valid values pass through.
  assert.equal(resolveConfig({ maxConcurrent: 0 }).maxConcurrent, 2)
  assert.equal(resolveConfig({ maxConcurrent: 5 }).maxConcurrent, 5)
  assert.equal(resolveConfig({ idleTimeoutMs: 500 }).idleTimeoutMs, 600000)
  assert.equal(resolveConfig({ idlePollMs: 0 }).idlePollMs, 30000)
})

await gate('2. 并发满拒绝', async () => {
  const h = makeHarness()
  const d = apply(h.ctx, { maxConcurrent: 2 })
  await h.ctx.subagents.start('a', {})
  await h.ctx.subagents.start('b', {})
  await assert.rejects(() => h.ctx.subagents.start('c', {}), /子代理并发已满/)
  d?.()
})

await gate('3. end 事件释放', async () => {
  const h = makeHarness()
  const d = apply(h.ctx, { maxConcurrent: 2 })
  const r1 = await h.ctx.subagents.start('a', {})
  await h.ctx.subagents.start('b', {})
  await assert.rejects(() => h.ctx.subagents.start('c', {}), /子代理并发已满/)
  // H0: match by info.id (SessionId = run.id), not the random runId.
  h.emit('subagent/end', { id: r1.id, runId: 'uuid-not-the-key', provider: 'mock', local: false, stopReason: 'completed' })
  const r3 = await h.ctx.subagents.start('c', {})
  assert.ok(r3.id, 'fourth start succeeds after end release')
  d?.()
})

await gate('4. 幂等重复 end', async () => {
  const h = makeHarness()
  const d = apply(h.ctx, { maxConcurrent: 2 })
  const r1 = await h.ctx.subagents.start('a', {})
  const r2 = await h.ctx.subagents.start('b', {})
  // Emit the same terminal event twice for one run.
  const payload = { id: r2.id, runId: 'uuid-2', provider: 'mock', local: false, stopReason: 'completed' }
  h.emit('subagent/end', payload)
  h.emit('subagent/end', payload)
  // Exactly one slot was released (no leak): the next start succeeds...
  await h.ctx.subagents.start('c', {})
  // ...and a repeated end must not over-release, so the concurrency cap holds.
  await assert.rejects(() => h.ctx.subagents.start('d', {}), /子代理并发已满/)
  d?.()
})

await gate('5. 远端 run 超时释放 (M2)', async () => {
  const h = makeHarness() // sessions.get → undefined: remote run
  // Note: config clamps sub-1000ms timeouts back to defaults (T4),
  // so the smallest legal override is 1000ms.
  const d = apply(h.ctx, { maxConcurrent: 1, idleTimeoutMs: 1000, idlePollMs: 1000 })
  const r = await h.ctx.subagents.start('a', {})
  await h.tick() // first iteration: reached the sleep yield
  await sleep(1100)
  await h.tick() // body: remote run is past idleTimeoutMs → dispose
  assert.equal(r.disposed, true, 'remote run disposed after startedAt timeout')
  const r2 = await h.ctx.subagents.start('b', {})
  assert.ok(r2.id, 'slot released after remote disposal')
  d?.()
})

await gate('6. fail-open: start 失败槽位回退 (H3)', async () => {
  // The underlying start fails exactly once, then succeeds.
  let failedOnce = false
  const h = makeHarness({
    startImpl: async () => {
      if (!failedOnce) {
        failedOnce = true
        throw new Error('start-fail')
      }
      return fakeRun(`sess-${++seq}`)
    },
  })
  const d = apply(h.ctx, { maxConcurrent: 1 })
  await assert.rejects(() => h.ctx.subagents.start('a', {}), /start-fail/)
  // The failed start must not leak the slot.
  await h.ctx.subagents.start('b', {})
  d?.()
})

await gate('7. 热重载防护 (H5)', async () => {
  const h = makeHarness()
  const d1 = apply(h.ctx, { maxConcurrent: 1 })
  const wrapped = h.ctx.subagents.start
  // Re-apply while installed: must be a no-op (module-level flag).
  const d2 = apply(h.ctx, { maxConcurrent: 1 })
  assert.equal(d2, undefined, 'second apply returns no disposer')
  assert.equal(h.ctx.subagents.start, wrapped, 'start is not double-wrapped')
  d1()
  assert.equal(h.ctx.subagents.start, h.originalStart, 'disposer restores the original start')
})

await gate('8. enabled:false 完全 bypass (L3a)', async () => {
  const h = makeHarness()
  const ret = apply(h.ctx, { enabled: false })
  assert.equal(ret, undefined)
  assert.equal(h.ctx.subagents.start, h.originalStart, 'disabled guard never replaces start')
  await h.ctx.subagents.start('a', {}) // passes straight through
})

console.log(`\n${passed}/8 smoke gates passed`)
assert.equal(passed, 8)