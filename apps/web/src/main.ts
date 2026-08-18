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

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const el = document.getElementById('root')
if (el === null) throw new Error('web app: missing #root')
void new AppWebEntry(el).run()
