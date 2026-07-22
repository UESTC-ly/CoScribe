import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      lib: { entry: resolve(rootDir, 'electron/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: false,
      lib: { entry: resolve(rootDir, 'electron/preload/index.ts') },
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: rootDir,
    plugins: [
      react(),
      viteStaticCopy({
        targets: [
          {
            src: resolve(rootDir, 'resources/ocr/*.tar'),
            dest: 'assets/ocr/models'
          },
          {
            src: resolve(rootDir, 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.{mjs,wasm}'),
            dest: 'assets/ocr/ort'
          }
        ]
      })
    ],
    build: {
      sourcemap: false,
      rollupOptions: { input: resolve(rootDir, 'index.html') }
    }
  }
})
