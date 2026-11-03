import { defineConfig } from 'vite'

export default defineConfig({
  // Pre-bundling would move the package's tessellation worker and WebAssembly module away from the URLs it finds them at
  optimizeDeps: { exclude: ['maplibre-gl-handwriting'] },
})
