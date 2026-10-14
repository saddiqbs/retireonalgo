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
  // @txnlab/use-wallet dynamically imports each wallet adapter at connect time.
  // Vite needs them pre-bundled, otherwise the dynamic import fails with
  // "Failed to fetch dynamically imported module".
  optimizeDeps: {
    include: [
      '@perawallet/connect',
      '@blockshake/defly-connect',
      'lute-connect',
      '@agoralabs-sh/avm-web-provider',
    ],
  },
})