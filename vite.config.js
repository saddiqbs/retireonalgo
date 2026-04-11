import { defineConfig } from 'vite'

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    exclude: ['@perawallet/connect'],
  },
})