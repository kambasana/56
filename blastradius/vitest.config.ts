import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Tests must never touch the network; http tests use injected transports.
    env: { BLASTRADIUS_OFFLINE: '1' },
  },
});
