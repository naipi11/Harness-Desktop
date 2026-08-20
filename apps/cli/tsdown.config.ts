import { defineConfig } from 'tsdown'

/**
 * The CLI ships `harness` as its primary entry and `dsh` as its compatible
 * entry. The root tsdown builds only `lib/types/index.js`, so this override
 * points at both entry declarations plus the browser transport used by the
 * production-shaped process-exit regression; shared runner modules bundle with them.
 * Declarations come from `tsc -b` (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/dsh-bin.js', 'lib/types/browser.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
