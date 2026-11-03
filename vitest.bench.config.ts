import { defineConfig } from 'vitest/config'

// The scale benchmark (npm run bench), kept out of npm test because it takes longer
export default defineConfig({
  define: { __HANDWRITING_DEBUG__: 'true' },
  test: {
    environment: 'node',
    include: ['tests/bench/**/*.test.ts'],
  },
})
