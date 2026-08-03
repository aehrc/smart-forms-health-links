import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 5273,
    // The camera API requires a secure context. localhost counts as secure,
    // but testing a scan from a phone needs HTTPS or a tunnel.
    host: true
  }
});
