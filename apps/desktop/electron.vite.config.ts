import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
