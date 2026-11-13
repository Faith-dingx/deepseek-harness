/** Restore the executable bit stripped from node-pty's prebuilt helper. */

import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// This script runs as a package postinstall, so it can be reached through a
// linked copy whose own node_modules does not hold node-pty. Resolve it from
// this package first, then from the install root that owns the dependency.
function resolvePtyRoot() {
  const candidates = []
  try {
    candidates.push(import.meta.resolve('node-pty'))
  } catch {
    // Not resolvable from this package's tree; try the install root below.
  }
  for (const base of [process.cwd(), join(process.cwd(), 'node_modules')]) {
    try {
      candidates.push(createRequire(join(base, 'noop.js')).resolve('node-pty'))
    } catch {
      // Keep trying the remaining bases.
    }
  }
  for (const entry of candidates) {
    const packageRoot = dirname(dirname(fileURLToPath(entry)))
    if (existsSync(packageRoot)) return packageRoot
  }
  return undefined
}

const packageRoot = resolvePtyRoot()
if (packageRoot === undefined) {
  // Nothing to restore: node-pty is not installed in this tree, so the helper
  // it would own does not exist either. Never fail an install over this.
  console.warn('ensure-spawn-helper: node-pty is not installed here; nothing to restore')
  process.exit(0)
}

const candidates = [
  join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  join(packageRoot, 'build', 'Release', 'spawn-helper'),
]

for (const helper of candidates) {
  if (existsSync(helper)) chmodSync(helper, 0o755)
}
