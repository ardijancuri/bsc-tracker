import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

// Managed worktrees can share node_modules through a junction. Vite rewrites
// font URLs to that real path, which must be allowed independently of the app.
const manropeDirectory = dirname(realpathSync(createRequire(import.meta.url).resolve('@fontsource/manrope/package.json')));

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': process.env.VITE_API_PROXY || 'http://127.0.0.1:3302' },
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), manropeDirectory],
      deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/.cache/fresh/pg/**',
      '**/.cache/fresh/identities.json', '**/.cache/fresh/memberships.json', '**/.cache/fresh/*-preservation.json',
      '**/.cache/fresh/private/**',
      '**/.cache/fresh/*.log', '**/.cache/fresh/*.pid', '**/.cache/fresh/known_hosts'] },
    // Local database dumps, worker logs and replay artifacts are not sources.
    watch: { ignored: ['**/.cache/**', '**/dist-server/**'] },
  },
});
