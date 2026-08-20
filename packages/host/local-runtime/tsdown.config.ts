import { defineConfig } from 'tsdown'

/** Node-only local Runtime foundation and its package invariant companion. */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/legacy-import.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
