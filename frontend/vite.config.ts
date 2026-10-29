import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: '/dashboard/' matches how src/api/server.js serves the built
// output (see DASHBOARD_DIR in server.js) — the original public/ SPA
// keeps living at '/', untouched, so existing tests keep passing.
export default defineConfig({
  // Relative assets work when the build is hosted at the site root (static
  // hosts) and under /dashboard/ (the Node server).
  base: './',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3100',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
