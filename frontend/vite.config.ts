import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Backend dev server (Fastify). Proxy REST + SSE routes to it so the browser
// talks to a single origin in dev (CSP connect-src 'self'). Target is env-driven
// (VITE_PROXY_TARGET / BACKEND_URL) so the backend can run internal-only on any port.
const BACKEND = process.env.VITE_PROXY_TARGET || process.env.BACKEND_URL || 'http://localhost:3001';

// Some backend API prefixes (/posts, /users) collide with SPA client routes
// (e.g. /posts/:id is the Thread page). A full-document navigation to such a
// route would otherwise be proxied to the backend and render raw JSON. So we
// bypass the proxy for HTML document navigations (serve the SPA index.html) and
// only proxy real API requests (fetch/XHR/EventSource send Accept: */*, json,
// or text/event-stream — never text/html as the primary type).
const apiProxy = {
  target: BACKEND,
  changeOrigin: true,
  bypass(req: { headers: Record<string, string | string[] | undefined>; method?: string }) {
    const accept = String(req.headers['accept'] ?? '');
    if (req.method === 'GET' && accept.includes('text/html')) {
      return '/index.html';
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': apiProxy,
      '/posts': apiProxy,
      '/users': apiProxy,
      '/runtime': apiProxy,
      '/metrics': apiProxy,
      '/health': apiProxy,
    },
  },
});
