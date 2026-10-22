import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file starts in-memory PGlite databases and runs the migrations. With several
    // files in parallel on a small machine, a cold start alone can take more than the 5 s default.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
