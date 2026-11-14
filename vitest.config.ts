import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['test/**/*.spec.ts'],
    // The stdio spec spawns the server through tsx; give it room on a loaded machine.
    testTimeout: 30_000,
  },
});
