import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://127.0.0.1:3300' },
    // Local database dumps, worker logs and replay artifacts are not sources.
    watch: { ignored: ['**/.cache/**', '**/dist-server/**'] },
  },
});
