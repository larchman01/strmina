import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Worker MapLibre izdamo kot .js: Android WebView .mjs ne servira kot JavaScript.
        assetFileNames: info =>
          info.names?.[0]?.endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: { port: 5173, host: true },
});
