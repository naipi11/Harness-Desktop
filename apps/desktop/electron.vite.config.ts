import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const productMetadataSource = fileURLToPath(
  new URL('../../packages/boot/app-boot/src/product-metadata.ts', import.meta.url),
)

export default defineConfig({
  main: {
    // Keep the source launch independent of app-boot's generated lib output.
    plugins: [externalizeDepsPlugin({ exclude: ['@deepseek-ai/dsh-app-boot'] })],
    resolve: {
      alias: {
        '@deepseek-ai/dsh-app-boot/product-metadata': productMetadataSource,
      },
    },
    build: {
      rollupOptions: {
        input: 'src/main/index.ts',
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.ts',
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs',
          inlineDynamicImports: true,
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
  },
})
