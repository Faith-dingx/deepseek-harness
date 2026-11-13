import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

const SESSION_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const LAUNCH_RECORD_KEY = credentialKey('client-connection', 'browser-launch')

/** Mutable credential-record double for Connection authentication tests. */
export class RecordCredentials {
  readonly records = new Map<CredentialKey, CredentialRecord | undefined>()
  discardWrites = false
  reads = 0
  modifies = 0

  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    this.reads += 1
    return Promise.resolve(this.records.get(key))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    this.modifies += 1
    const next = await mutate(this.records.get(key))
    if (this.discardWrites) return undefined
    if (next !== undefined) this.records.set(key, next)
    return this.records.get(key)
  }

  /** Simulates wiping the home's stored credentials before a fresh activation. */
  deleteRecord(): Promise<void> {
    this.records.clear()
    return Promise.resolve()
  }

  /** The browser-session signing-secret record, for cookie-signing assertions. */
  get sessionRecord(): CredentialRecord | undefined {
    return this.records.get(SESSION_RECORD_KEY)
  }

  set sessionRecord(value: CredentialRecord | undefined) {
    this.records.set(SESSION_RECORD_KEY, value)
  }

  /** The browser-launch token record, for launch-token validation tests. */
  get launchRecord(): CredentialRecord | undefined {
    return this.records.get(LAUNCH_RECORD_KEY)
  }

  set launchRecord(value: CredentialRecord | undefined) {
    this.records.set(LAUNCH_RECORD_KEY, value)
  }
}

/** Provide the record operations Connection needs during authentication setup. */
export function provideBrowserCredentials(ctx: Context): void {
  ctx.provide('credentials', new RecordCredentials() as unknown as CredentialProvider)
}
