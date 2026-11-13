/** Browser entry for the Web client. */

/**
 * Web application entry: thin bootstrap over the shell library. Everything —
 * module-table seeding, the boot page, and the UI-renderer handoff — lives
 * in @deepseek-ai/dsh-client-web; this file only finds the mount point.
 */

// Polyfill crypto.randomUUID for insecure origins (non-HTTPS / non-localhost
// access, e.g. http://<LAN-IP>:3080). In insecure contexts the Web Crypto
// `randomUUID` is unavailable, which broke workspace/settings UI. Backfill it
// with a RFC 4122 v4 UUID built from crypto.getRandomValues, which browsers
// do expose on insecure origins.
//
// The DOM lib types model `globalThis.crypto` as always present and
// `randomUUID` as always defined, so oxlint flags the defensive null checks
// below as "unnecessary" — but on an insecure origin (plain http on a LAN IP)
// `crypto` is genuinely absent at runtime, which is exactly the case this
// polyfill exists to cover. The checks are intentional; suppress the noise.
/* oxlint-disable no-unnecessary-condition, unbound-method -- runtime-insecure-origin polyfill */
if (typeof globalThis.crypto?.randomUUID !== 'function') {
  const cryptoObj: Crypto | undefined = globalThis.crypto
  const uuid = (): `${string}-${string}-${string}-${string}-${string}` => {
    const raw = new Uint8Array(16)
    // crypto.getRandomValues is available on insecure origins; fall back to
    // Math.random-derived filler only if even that is absent.
    const grv = globalThis.crypto?.getRandomValues
    if (grv) {
      grv.call(globalThis.crypto, raw)
    } else {
      for (let i = 0; i < 16; i++) raw[i] = Math.floor(Math.random() * 256)
    }
    const b6 = raw[6] ?? 0
    const b8 = raw[8] ?? 0
    raw[6] = (b6 & 0x0f) | 0x40
    raw[8] = (b8 & 0x3f) | 0x80
    const hex = Array.from(raw, b => b.toString(16).padStart(2, '0'))
    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
  }
  if (cryptoObj) {
    cryptoObj.randomUUID = uuid
  } else {
    ;(globalThis as Record<string, unknown>).crypto = { randomUUID: uuid }
  }
}
/* oxlint-enable no-unnecessary-condition, unbound-method */

import '@deepseek-ai/dsh-client-ui-theme/brand-font.css'
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

interface DesktopBootGlobal {
  dshDesktopBoot?: {
    failed(message: string): Promise<void>
    ready(): Promise<{ injections: Parameters<typeof applyIndexInjections>[0]; streamBaseUrl: string }>
  }
}
const desktop = (globalThis as DesktopBootGlobal).dshDesktopBoot
const reportFailure = (reason: unknown): void => {
  if (desktop === undefined) throw reason
  void desktop.failed(reason instanceof Error ? reason.message : String(reason)).catch(console.error)
}

try {
  const el = document.getElementById('root')
  if (el === null) throw new Error('web app: missing #root')
  const entry = new AppWebEntry(el)
  if (desktop !== undefined) {
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    if (gate === undefined) throw new Error('desktop web: boot readiness is missing')
    void desktop.ready().then(async ({ injections, streamBaseUrl }) => {
      const transport = globalThis as { __DSH_TRANSPORT__?: { ownsHost: boolean; streamBaseUrl: string } }
      transport.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => { resolve() }
        script.onerror = () => { reject(new Error(`desktop web: failed to load ${src}`)) }
        document.head.append(script)
      }))
      gate.resolve()
    }).catch((error: unknown) => { gate.reject(error) })
  }
  void entry.run(desktop === undefined ? undefined : reportFailure)
} catch (reason) {
  reportFailure(reason)
}
