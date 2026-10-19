import { defineConfig } from 'vitest/config';

/**
 * Files with timing bounds run after everything else, one file at a time, so a busy machine running the rest
 * of the suite in parallel can't push them over (their bounds measure the code, not the scheduler).
 */
const TIMED = ['tests/planAhead.test.ts', 'tests/trends.test.ts', 'tests/monthsAheadApi.test.ts', 'tests/forecastApi.test.ts'];

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: TIMED, sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'timed', include: TIMED, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
