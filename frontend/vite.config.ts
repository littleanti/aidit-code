import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend dev server (Fastify) runs on :3001. Proxy REST + SSE routes to it
// so the browser talks to a single origin in dev (CSP connect-src 'self').
const BACKEND = 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target: BACKEND, changeOrigin: true },
      '/posts': { target: BACKEND, changeOrigin: true },
      '/users': { target: BACKEND, changeOrigin: true },
      '/runtime': { target: BACKEND, changeOrigin: true },
      '/metrics': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
    },
  },
});
