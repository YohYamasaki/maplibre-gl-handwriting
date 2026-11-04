// Review finding on 0044: lyon was given the width on screen at the mesh's zoom also below the drawing zoom. A dot
// made for a zoom far out became narrower than lyon draws (about 0.25 px) and got no triangles, and that mesh was kept
// for about 3 zoom levels in, so the dot stayed invisible even once it was over 1 px wide on screen again
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StrokeStore } from '../../src/core/stroke'
import { mercatorPerPixelAt } from '../../src/mercator'
import { StrokeScene } from '../../src/StrokeScene'
import { StrokeTessellator } from '../../src/StrokeTessellator'
import { DeferredBuilds } from '../support'

const root = join(import.meta.dirname, '../..')

it('a dot drawn at z15 shows at z12.9 after the view passed z10', async () => {
  const tessellator = await StrokeTessellator.load(
    readFileSync(join(root, 'tessellator/pkg/handwriting_tessellator_bg.wasm')),
  )
  const store = new StrokeStore({ order: 'custom' })
  const builds = new DeferredBuilds()
  const scene = new StrokeScene(store, tessellator, builds, 15)
  store.apply(
    {
      type: 'load',
      strokes: [{ id: 'me:1', author: 'me', color: '#336699', width: 6, zoom: 15, points: [[0.5, 0.5]], order: 1 }],
    },
    'remote',
  )
  let indices = 0
  for (const zoom of [15, 10, 12.9]) {
    const px = mercatorPerPixelAt(zoom)
    const view = { minX: 0.5 - 500 * px, maxX: 0.5 + 500 * px, minY: 0.5 - 350 * px, maxY: 0.5 + 350 * px }
    scene.frame(view, zoom)
    while (builds.pending.length > 0) scene.onBuilt(builds.deliver(0, tessellator))
    const draws = scene.frame(view, zoom)
    indices = [...draws.opaque, ...draws.translucent].reduce((sum, d) => sum + d.indexCount, 0)
  }
  expect(indices).toBeGreaterThan(0)
})
