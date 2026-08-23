/**
 * Progress-oriented smoke tests: local session progress must keep a run
 * alive, stagnation must trigger disposal, short-timeout overrides must
 * really force-kill, and per-run idle metadata must stay isolated (H1).
 *
 * Timing note: the watchdog is an async-generator effect, and `yield`
 * awaits its operand, so every manual tick blocks for `idlePollMs` (1000ms
 * here). Gates therefore use the fewest possible ticks and parallelize
 * session progress with intervals during ticks.
 *
 * Run with: pnpm test:smoke-progress
 */
import assert from 'node:assert/strict'
import { apply } from '../src/index.ts'

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

/** Session with a real-Session-like `events` getter returning a fresh snapshot. */
function makeSession() {
  const log = []
  return {
    get events() { return [...log] },
    push(type = 'user/message') {
      log.push({ type, seq: log.length, time: Date.now(), data: {} })
    },
  }
}

/** Build a mock context whose sessions map is maintained per started run. */
function makeHarness() {
  const sessions = new Map()
  const listeners = {}
  let generator = null
  const ctx = {
    subagents: {
      start: async () => {
        const id = `sess-${++seq}`
        const session = makeSession()
        const run = fakeRun(id)
        sessions.set(id, session)
        run._session = session
        return run
      },
    },
    sessions: { get: (id) => sessions.get(id) },
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
    tick: async () => { if (generator) await generator.next() },
  }
}

let passed = 0
async function gate(name, fn) {
  await fn()
  passed++
  console.log(`PASS ${name}`)
}

await gate('1. 本地 session 推进不误杀', async () => {
  const h = makeHarness()
  const d = apply(h.ctx, { maxConcurrent: 1, idleTimeoutMs: 1000, idlePollMs: 1000 })
  const run = await h.ctx.subagents.start('a', {})
  run._session.push()
  run._session.push()
  // Push continuously while the watchdog runs; the run must survive.
  const pusher = setInterval(() => run._session.push(), 200)
  await h.tick() // body 1: initializes per-run metadata
  await h.tick() // body 2: events kept growing → still alive
  clearInterval(pusher)
  assert.equal(run.disposed, false, 'progressing session keeps the run alive')
  d?.()
})

await gate('2. 停摆后释放', async () => {
  const h = makeHarness()
  const d = apply(h.ctx, { maxConcurrent: 1, idleTimeoutMs: 1000, idlePollMs: 1000 })
  const run = await h.ctx.subagents.start('a', {})
  run._session.push()
  run._session.push()
  await h.tick() // paused at the sleep yield
  await h.tick() // body 1: initializes lastSeenCount / lastEventTime
  // Stop pushing; a full idleTimeout passes without any tick drive.
  await sleep(1100)
  await h.tick() // body 2: stagnation > idleTimeoutMs → dispose
  assert.equal(run.disposed, true, 'stagnant session is disposed after idleTimeoutMs')
  d?.()
})

await gate('3. L3 短时 override 强杀生效', async () => {
  const h = makeHarness()
  // Default idleTimeoutMs is 600000; the 1000ms override must actually be
  // honored (otherwise this run would survive the whole test).
  const d = apply(h.ctx, { maxConcurrent: 1, idleTimeoutMs: 1000, idlePollMs: 1000 })
  const run = await h.ctx.subagents.start('a', {})
  run._session.push()
  await h.tick() // paused at the sleep yield
  await h.tick() // body 1: lastEventTime anchored to the session event time
  await sleep(1200)
  await h.tick() // body 2: idleMs > 1000 → force-kill
  assert.equal(run.disposed, true, '1000ms override kills a quiet run')
  d?.()
})

await gate('4. H1 多 run 隔离', async () => {
  const h = makeHarness()
  const d = apply(h.ctx, { maxConcurrent: 2, idleTimeoutMs: 1000, idlePollMs: 1000 })
  const runA = await h.ctx.subagents.start('a', {})
  const runB = await h.ctx.subagents.start('b', {})
  runA._session.push()
  runA._session.push()
  runB._session.push()
  runB._session.push()
  await h.tick() // paused at the sleep yield
  await h.tick() // body 1: both runs' per-run metadata initialized
  // B keeps progressing via an interval while the watchdog ticks on;
  // A stays quiet and must be reaped without touching B's metadata.
  const pusher = setInterval(() => runB._session.push(), 150)
  await sleep(1300)
  await h.tick() // body 2: A stale (>1000ms), B progressing
  clearInterval(pusher)
  await h.tick() // body 3: A already reaped; B still alive
  assert.equal(runA.disposed, true, 'quiet run A is disposed')
  assert.equal(runB.disposed, false, 'progressing run B survives — per-run metadata isolated')
  d?.()
})

console.log(`\n${passed}/4 progress gates passed`)
assert.equal(passed, 4)