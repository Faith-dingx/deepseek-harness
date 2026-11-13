/**
 * Boot-time discovery of locally authored agent presets.
 *
 * 0.1.5 owned the whole preset roster — filesystem discovery, mounting, and
 * the remote API — inside this package. 0.2.2 moved the registry into
 * `dsh-agent-preset-registry`, moved the shipped preset declarations into the
 * web bundle's `presets/*.patch.yml` files, and dropped the scan of locally
 * authored presets. This plugin restores exactly that lost piece: it scans
 * the harness home's `USER_PRESET_DIR` (plus any configured extra roots) at
 * boot and registers every discovered composition into the same `agentPresets`
 * registry the shipped presets use, so a locally authored preset is
 * indistinguishable from a bundled one on the roster.
 *
 * Registration, not re-reading: the 0.1.5 roster re-scanned its roots on
 * every read, which the 0.2.2 registry's push-based definitions cannot
 * express. A preset authored while the process runs becomes visible on the
 * next restart.
 * @module @deepseek-ai/dsh-agent-presets
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { load } from 'js-yaml'
import z from '@deepseek-ai/schemastery'
import { discoverPresets, USER_PRESET_DIR } from './discovery.ts'
import type { PresetRoot } from './preset.ts'

/** Plugin config: extra roots to scan, and whether the harness-home user root is scanned. */
export interface Config {
  /** Extra scanned roots in precedence order; an earlier root wins a duplicate id. */
  roots: PresetRoot[]
  /**
   * Append the harness home's `USER_PRESET_DIR` (`$DSH_HOME/.agent-presets`)
   * as a `user` root, after every configured root. False scans only `roots`.
   */
  includeUserRoot: boolean
}

/**
 * Scans preset roots and registers what they hold into the preset registry.
 *
 * A broken composition (unparsable YAML, missing composition file) stays off
 * the roster with a warning: the registry only shows rows it was handed, and
 * an unparsable file has no rows to hand it. A parseable composition naming a
 * plugin that cannot load IS registered — the registry reports it as a broken
 * roster row, preserving the 0.1.5 behavior of surfacing a rotted preset
 * rather than silently skipping it.
 */
export default class AgentPresetsDiscovery {
  static inject = ['agentPresets']

  /** Runtime schema for the discovery roots. */
  static Config: z<Config> = z.object({
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  constructor(private readonly ctx: Context, public config: Config) {}

  async* [Service.init]() {
    const baseUrl = this.ctx.baseUrl
    if (baseUrl === undefined) {
      // Self-contained misconfiguration, so it fails at load: without a base
      // neither the health check nor the registry's mount can resolve a row
      // naming a package, and the silent alternative is user presets that
      // read as healthy and fail at first session.
      throw new Error(
        'agent-presets: discovery needs `ctx.baseUrl` to resolve the plugins a composition names; '
        + 'compose it under a Loader, or set the base on the context this plugin is applied to',
      )
    }
    // The user root comes LAST so a configured root wins a duplicate id, and
    // a user directory claiming a shipped preset's name loses to the shipped
    // declaration through the duplicate-id guard in `register`.
    const roots: PresetRoot[] = [
      ...this.config.roots,
      ...this.config.includeUserRoot
        ? [{ path: join(resolveDshHome(), USER_PRESET_DIR), trust: 'user' } satisfies PresetRoot]
        : [],
    ]
    const found = await discoverPresets(roots, baseUrl)
    const disposers: Array<() => Promise<void>> = []
    for (const preset of found) {
      try {
        // The loader's own YAML dialect (`entryListSchema`, carrying `!!js`),
        // so the rows handed to the registry read exactly as declared.
        const rows = load(await readFile(preset.path, 'utf8'), { schema: entryListSchema })
        disposers.push(await this.ctx.agentPresets.register({
          id: preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
          ...(preset.order === undefined ? {} : { order: preset.order }),
          plugins: rows as PresetDefinition['plugins'],
        }))
      } catch (error) {
        // An unparsable or missing composition has no rows to hand the
        // registry, and a duplicate id (a user directory claiming a shipped
        // or configured preset's name) must not take the whole discovery
        // plugin down: the earlier root's declaration wins, matching root
        // precedence. A parseable composition naming a plugin that cannot
        // load IS registered — the registry reports it as a broken roster
        // row, surfacing the rot rather than silently skipping it.
        this.ctx.logger.warn(`agent preset ${preset.id}: not registered: ${(error as Error).message}`)
      }
    }
    yield async () => {
      for (const dispose of disposers.splice(0)) await dispose()
    }
  }
}
