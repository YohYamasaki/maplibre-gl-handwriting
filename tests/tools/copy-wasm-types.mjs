// Copies the wasm-bindgen declarations next to the emitted ones, so the relative imports in dist/types resolve
// (tsc does not emit a .d.ts it did not compile)
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const target = join(root, 'dist/types/tessellator/pkg')
mkdirSync(target, { recursive: true })
for (const file of ['handwriting_tessellator.d.ts', 'handwriting_tessellator_bg.wasm.d.ts']) {
  copyFileSync(join(root, 'tessellator/pkg', file), join(target, file))
}
