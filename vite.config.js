import { defineConfig } from 'vite'

export default defineConfig({
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['@perawallet/connect'],
  },
  build: {
    commonjsOptions: {
      include: [/@perawallet/, /node_modules/],
    },
  },
  resolve: {
    alias: {
      'js-sha3': 'js-sha3/src/sha3.js',
    },
  },
})