import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false, // types stay under lib/types (tsc-managed); this only refreshes the runtime lib/*.js
  sourcemap: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
