import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The tests see the debug code (decision 0096), as the dev page does
  define: { __HANDWRITING_DEBUG__: 'true' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // The scale benchmark runs on its own (npm run bench)
    exclude: ['tests/bench/**', 'examples/**'],
  },
})
