// lyon drops points that lie too close together. When it dropped the whole last curve of the frozen piece, the
// tessellator once threw (when pieces ended flat at a seam) and the scene stopped drawing until the input
// changed. Pieces now end in round caps; this draws such a stroke through the real scene and lyon and
// checks every frame still succeeds
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StrokeStore } from '../../src/core/stroke'
import { mercatorPerPixelAt } from '../../src/mercator'
import { StrokeScene } from '../../src/StrokeScene'
import { StrokeTessellator } from '../../src/StrokeTessellator'

const root = join(import.meta.dirname, '../..')

it('drawing a stroke whose frozen piece lost its last curve to lyon never throws', async () => {
  const tessellator = await StrokeTessellator.load(
    readFileSync(join(root, 'tessellator/pkg/handwriting_tessellator_bg.wasm')),
  )
  const zoom = 12
  const px = mercatorPerPixelAt(zoom)
  const store = new StrokeStore({ order: 'custom' })
  const scene = new StrokeScene(store, tessellator, { build: () => {} }, zoom)
  const view = { minX: 0.5 - 500 * px, maxX: 0.5 + 500 * px, minY: 0.5 - 350 * px, maxY: 0.5 + 350 * px }
  const id = 'me:1'
  store.apply({ type: 'begin', id, author: 'me', color: '#336699', width: 8, zoom }, 'local')
  const points: [number, number][] = [
    ...Array.from({ length: 31 }, (_, i): [number, number] => [i, 0]),
    [29.855, 0.106],
    [29.977, 0.076],
    [29.87, -0.104],
  ]
  for (const [x, y] of points) {
    store.apply({ type: 'points', id, pts: Float64Array.of(0.5 + x / 2097152, 0.5 + y / 2097152) }, 'local')
    expect(() => scene.frame(view, zoom)).not.toThrow()
  }
  expect(scene.inspect().active.get(id)).toBeDefined()
})
