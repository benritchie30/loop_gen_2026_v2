import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The UI reaches the backend at /ws on its own origin (see hooks/useWebSocket.js).
// `npm run dev` and `npm run preview` forward it to the Python server, like the
// deployed site's web server does. LOOP_PORT: the backend's port (default 8765).
const backend = {
  '/ws': { target: `ws://localhost:${process.env.LOOP_PORT || 8765}`, ws: true },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { proxy: backend },
  preview: { proxy: backend },
  test: {
    // Pure logic tests (no browser): src/**/*.test.js. `npm test`.
    include: ['src/**/*.test.js'],
    environment: 'node',
  },
})
