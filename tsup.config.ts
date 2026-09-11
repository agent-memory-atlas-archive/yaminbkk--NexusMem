import { defineConfig } from 'tsup';

export default defineConfig({
  // The recorder and the agent hook each run once per event, so they are their own small bundles with no native deps.
  entry: {
    'cli/index': 'src/cli/index.ts',
    'cli/recorder': 'src/cli/recorder.ts',
    'cli/agent-hook': 'src/adapters/claude-code/hook-entry.ts',
  },
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
