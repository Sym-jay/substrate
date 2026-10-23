import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The control API: local by default, or set API_URL to use a deployed one.
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://localhost:8080', changeOrigin: true, ws: true },
    },
  },
})
