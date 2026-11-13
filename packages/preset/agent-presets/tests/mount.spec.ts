/**
 * The discovery plugin registers what the user root holds into the 0.2.2
 * preset registry: a healthy composition joins the roster beside the shipped
 * presets, a rotted one surfaces as a broken roster row, and a directory
 * claiming an already-declared id loses to that declaration.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Discovery from '../src/index.ts'
import { COMPOSITION_FILE } from '../src/discovery.ts'
import { contribution, declare, harness } from '../../agent-preset-registry/tests/harness.ts'

const previousDshHome = process.env.DSH_HOME

afterEach(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
})

/** A throwaway `DSH_HOME` holding one authored preset under `.agent-presets`. */
async function userHome(id: string, composition: string, metadata?: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-agent-presets-home-'))
  process.env.DSH_HOME = home
  const directory = join(home, '.agent-presets', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, COMPOSITION_FILE), composition)
  if (metadata !== undefined) await writeFile(join(directory, 'preset.yml'), metadata)
  return home
}

describe('user preset registration', () => {
  it('registers a user-dir preset into the shared registry', async () => {
    await userHome('local-probe', '- id: noop\n  name: no-such-plugin-for-test\n  disabled: true\n', 'name: Local Probe\n')
    const ctx = await harness()
    await ctx.plugin(Discovery)

    const probe = (await ctx.agentPresets.list()).find(row => row.id === 'local-probe')
    expect(probe).toMatchObject({ id: 'local-probe', name: 'Local Probe' })
    expect(probe?.broken).toBeUndefined()
  })

  it('surfaces a rotted user composition as a broken roster row', async () => {
    await userHome('rotted-probe', '- id: gone\n  name: no-such-plugin-for-test\n')
    const ctx = await harness()
    await ctx.plugin(Discovery)

    const probe = (await ctx.agentPresets.list()).find(row => row.id === 'rotted-probe')
    expect(probe?.broken).toMatch(/no-such-plugin-for-test/)
  })

  it('skips an unparsable composition without failing the plugin', async () => {
    await userHome('broken-probe', '- id: x\n  name: [unclosed\n')
    const ctx = await harness()
    await ctx.plugin(Discovery)

    expect((await ctx.agentPresets.list()).find(row => row.id === 'broken-probe')).toBeUndefined()
  })

  it('lets an already-declared id win over a user directory', async () => {
    await userHome('standard', '- id: noop\n  name: no-such-plugin-for-test\n  disabled: true\n')
    const ctx = await harness()
    await declare(ctx, contribution('standard'))
    await ctx.plugin(Discovery)

    expect((await ctx.agentPresets.list()).filter(row => row.id === 'standard')).toHaveLength(1)
  })

  it('scans nothing when the user root is absent', async () => {
    await mkdtemp(join(tmpdir(), 'dsh-agent-presets-home-')).then(home => { process.env.DSH_HOME = home })
    const ctx = await harness()
    await ctx.plugin(Discovery)

    expect(await ctx.agentPresets.list()).toEqual([])
  })
})
