import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [react(), nodePolyfills({
    globals: {
      global: true,
      Buffer: true,
      process: true,
    },
  }), cloudflare()],
  build: {
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
})