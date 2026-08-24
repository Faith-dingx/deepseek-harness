import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  sourcemap: true,
  // tsdown defaults to .mjs/.d.mts under "type": "module"; the package's
  // main/types (lib/index.js, lib/index.d.ts) and repo conventions expect .js.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})