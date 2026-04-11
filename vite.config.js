import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        global: true,
        Buffer: true,
        process: true,
      },
    }),
  ],
  optimizeDeps: {
    include: [
      'js-sha3',
      '@perawallet/connect',
      '@walletconnect/client',
      '@walletconnect/types',
    ],
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
      include: [/js-sha3/, /node_modules/],
    },
  },
})