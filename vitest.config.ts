import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import application from './vite.config.ts';

// Release snapshots and local evidence under .cache are archived copies, not
// additional test suites. Keep npm test scoped to the maintained source trees.
export default mergeConfig(application, defineConfig({
  test: {
    include: ['{src,server,shared,scripts}/**/*.{test,spec}.{ts,tsx,js,mjs,cjs,mts,cts}'],
    exclude: [...configDefaults.exclude, '**/.cache/**', '**/dist-server/**'],
  },
}));
