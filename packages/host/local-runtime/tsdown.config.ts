import { defineConfig } from 'tsdown'

/** Node-only local Runtime foundation and its package invariant companion. */
export default defineConfig([
  {
    entry: [
      'lib/types/index.js',
      'lib/types/invariant.js',
      'lib/types/legacy-import.js',
      'lib/types/runtime-control.js',
      'lib/types/runtime.js',
      'lib/types/idle-lifecycle.js',
      'lib/types/harness-home-provider.js',
      'lib/types/control-service.js',
      'lib/types/runtime-client.js',
      'lib/types/bin.js',
    ],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
