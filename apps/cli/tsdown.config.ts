import { defineConfig } from 'tsdown'

/**
 * The CLI ships `harness` as its primary entry and `dsh` as its compatible
 * entry. The root tsdown builds only `lib/types/index.js`, so this override
 * points at both entry declarations; their shared runner and mode modules bundle with them.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/dsh-bin.js', 'lib/types/standalone-launcher.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  outputOptions: { chunkFileNames: '[name].js' },
  fixedExtension: false,
  dts: false,
  clean: false,
})
