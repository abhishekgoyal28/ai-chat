import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dashboard is served by chat-app at /admin. In development, `npm run dev`
 * serves it on :5173 and proxies the APIs to locally running services.
 */
const APP = process.env.AIC_APP_URL ?? 'http://localhost:3000';
const SOCKET = process.env.AIC_SOCKET_URL ?? 'http://localhost:3001';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true, chunkSizeWarningLimit: 900 },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': APP,
      '/v1': APP,
      '/socket.io': { target: SOCKET, ws: true },
    },
  },
});
