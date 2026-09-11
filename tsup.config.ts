import { defineConfig } from 'tsup';

export default defineConfig({
  // The recorder runs once per shell command, so it is its own small bundle with no native deps.
  entry: { 'cli/index': 'src/cli/index.ts', 'cli/recorder': 'src/cli/recorder.ts' },
  splitting: false,
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  sourcemap: true,
  // better-sqlite3 is a native addon; it must stay external and be resolved at runtime.
  external: ['better-sqlite3'],
  banner: { js: '#!/usr/bin/env node' },
});
