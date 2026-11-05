// A stroke being drawn is tessellated in pieces (frozen + tail). With butt ends lyon squared each end against the
// piece's last flattened edge rather than the curve's tangent, so on a curve a wedge-shaped crack opened on the outer
// side of the bend at every seam (the background showed through, for opaque strokes too). Every piece now ends in
// round caps, which overlap where pieces meet; a translucent stroke is still painted once there by its single depth.
// This checks, through the real scene and lyon, that every point of the first seam's circle is covered by a triangle
// of one of the two pieces, on the shapes that broke earlier seam schemes
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StrokeStore, type Point } from '../../src/core/stroke'
import { GEOMETRY_FLOATS } from '../../src/MeshBuffer'
import { mercatorPerPixelAt } from '../../src/mercator'
import { quantizePressure } from '../../src/pressure'
import { StrokeScene } from '../../src/StrokeScene'
import type { MeshBuffer } from '../../src/MeshBuffer'
import { StrokeTessellator } from '../../src/StrokeTessellator'

const root = join(import.meta.dirname, '../..')
const zoom = 12
const px = mercatorPerPixelAt(zoom)
const defaultOrigin: Point = [0.5003, 0.5003]

type Px = [number, number]

/**
 * Draws a stroke through `path(i)` (in px from `origin`), one point per frame, until the first piece is frozen and a
 * few more points are drawn, or until `path` returns undefined. With `pressure`, each point has the width coefficient
 * `pressure(i)`. Returns the triangles of the frozen part and of the tail, in px around the first seam's sample, and
 * the width coefficient there (1 without pressure)
 */
async function drawUntilSeam(
  path: (i: number) => Px | undefined,
  width: number,
  origin = defaultOrigin,
  pressure?: (i: number) => number,
): Promise<{ frozen: Px[][]; tail: Px[][]; coefficient: number }> {
  const tessellator = await StrokeTessellator.load(
    readFileSync(join(root, 'tessellator/pkg/handwriting_tessellator_bg.wasm')),
  )
  const store = new StrokeStore({ order: 'custom' })
  const scene = new StrokeScene(store, tessellator, { build: () => {} }, zoom)
  const view = {
    minX: origin[0] - 500 * px,
    maxX: origin[0] + 500 * px,
    minY: origin[1] - 350 * px,
    maxY: origin[1] + 350 * px,
  }
  const id = 'me:1'
  store.apply({ type: 'begin', id, author: 'me', color: '#33669980', width, zoom }, 'local')
  let afterFreeze = -1
  for (let i = 0; afterFreeze < 4; i++) {
    const p = path(i)
    if (!p) break
    const ps = pressure ? { ps: Float32Array.of(quantizePressure(pressure(i))) } : {}
    store.apply(
      { type: 'points', id, pts: Float64Array.of(origin[0] + p[0] * px, origin[1] + p[1] * px), ...ps },
      'local',
    )
    scene.frame(view, zoom)
    if (afterFreeze >= 0 || scene.inspect().active.get(id)!.frozenTo > 0) afterFreeze++
    if (i > 1000) throw new Error('the stroke never froze a piece')
  }
  const hot = scene.inspect().active.get(id)!
  if (hot.frozenTo === 0) throw new Error('the stroke never froze a piece')
  const tile = hot.frozen.tile
  const seam = hot.samples.points[hot.frozenTo]
  const local = [(seam[0] * 2 ** tile.z - tile.x) * 8192, (seam[1] * 2 ** tile.z - tile.y) * 8192]
  // Each vertex on screen, in px around the seam: its position in tile units plus the normal times half the width
  const unitsPerPx = (8192 * 2 ** tile.z) / (512 * 2 ** zoom)
  const trianglesOf = (mesh: MeshBuffer): Px[][] => {
    const triangles: Px[][] = []
    const g = mesh.geometry
    const F = GEOMETRY_FLOATS
    const at = (v: number): Px => [
      (g[F * v] - local[0]) / unitsPerPx + (g[F * v + 2] * width) / 2,
      (g[F * v + 1] - local[1]) / unitsPerPx + (g[F * v + 3] * width) / 2,
    ]
    for (let i = 0; i < mesh.indexCount; i += 3)
      triangles.push([at(mesh.indices[i]), at(mesh.indices[i + 1]), at(mesh.indices[i + 2])])
    return triangles
  }
  const coefficient = hot.samples.pressure?.[hot.frozenTo] ?? 1
  return { frozen: trianglesOf(hot.frozen), tail: trianglesOf(hot.tail), coefficient }
}

/** Whether `point` is inside one of `triangles` (edges count as inside) */
function covered(triangles: Px[][], [x, y]: Px): boolean {
  return triangles.some(([a, b, c]) => {
    const side = (p: Px, q: Px): number => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])
    const [d1, d2, d3] = [side(a, b), side(b, c), side(c, a)]
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  })
}

/** Grid points of the seam's circle that no triangle covers */
function uncovered(triangles: Px[][], width: number): Px[] {
  // Up to 95% of the half width, and no further than the tolerance inside the edge: the round edge is flattened to
  // within 1/8 px, which on a thin line is a large part of the half width
  const radius = Math.min(0.95 * (width / 2), width / 2 - 1 / 8)
  const step = Math.min(0.1, radius / 20)
  const missed: Px[] = []
  for (let x = -radius; x <= radius; x += step) {
    for (let y = -radius; y <= radius; y += step) {
      if (x * x + y * y <= radius * radius && !covered(triangles, [x, y])) missed.push([x, y])
    }
  }
  return missed
}

// Points 3 px apart: an ordinary hand-drawn line
const straight = (i: number): Px => [3 * i, 0]
const bend = (i: number): Px => [20 * Math.cos((i * 3) / 20), 20 * Math.sin((i * 3) / 20)]
const bendBack = (i: number): Px => [20 * Math.cos((i * 3) / 20), -20 * Math.sin((i * 3) / 20)]
// Straight out, then straight back at sample 33, the first seam (FREEZE_SEGMENTS + 1 samples in, minus 1)
const turnBack = (i: number): Px => (i <= 32 ? [3 * i, 0] : [3 * 32 - 3 * (i - 32), 0.3 * (i - 32)])
// Found by a review of an earlier seam scheme: lyon dropped the earlier piece's last point (width 0.5 px)
const droppedEnd: Px[] = [
  ...Array.from({ length: 31 }, (_, i): Px => [-0.817513706 - (30 - i), 0.894033885 + (30 - i)]),
  [0, 0],
  [-0.132887475, -0.145579366],
  [2.903939123, 0.158846715],
  [1.722899832, 2.609555218],
]
// Found by a Codex review of an earlier seam scheme: the whole tail was closer to the earlier piece's end than
// lyon's point removal distance (width 0.5 px, at 0.5, 0.5)
const collapsedTail: Px[] = [
  ...Array.from({ length: 31 }, (_, i): Px => [0.17 - (30 - i), 0.15]),
  [0.15, -0.1],
  [0, 0],
  [0.1, -0.13],
]
// Found by a Codex review of an earlier seam scheme: lyon dropped the whole last curve of the frozen piece
// (width 8 px, at 0.5, 0.5)
const decimatedEnd: Px[] = [
  ...Array.from({ length: 31 }, (_, i): Px => [i, 0]),
  [29.855, 0.106],
  [29.977, 0.076],
  [29.85, 0.04],
]
const decimatedEndThenOn: Px[] = [...decimatedEnd, [31, 0]]

describe('the frozen part and the tail of a stroke being drawn cover the whole circle at their seam', () => {
  // `alone`: whether each piece covers the circle on its own. Where lyon drops the earlier piece's last point, that
  // piece ends (and its cap is centered) up to the tolerance short of the seam's sample, which on a 0.5 px line is
  // as much as the circle checked; there only both pieces together are held to it
  for (const [name, path, width, origin, alone] of [
    ['straight', straight, 8, defaultOrigin, true],
    ['a circle of radius 20 px', bend, 8, defaultOrigin, true],
    ['the same circle the other way round', bendBack, 8, defaultOrigin, true],
    ['turning straight back', turnBack, 8, defaultOrigin, true],
    [
      "lyon dropping the earlier piece's last point",
      (i: number): Px | undefined => droppedEnd[i],
      0.5,
      defaultOrigin,
      false,
    ],
    ['a tail shorter than lyon keeps', (i: number): Px | undefined => collapsedTail[i], 0.5, [0.5, 0.5] as Point, true],
    [
      "lyon dropping the earlier piece's whole last curve",
      (i: number): Px | undefined => decimatedEnd[i],
      8,
      [0.5, 0.5] as Point,
      true,
    ],
    ['the same, then going on', (i: number): Px | undefined => decimatedEndThenOn[i], 8, [0.5, 0.5] as Point, true],
  ] as const) {
    it(name, async () => {
      const { frozen, tail } = await drawUntilSeam(path, width, origin)
      // Each piece ends in a round cap there, so each covers the whole circle on its own
      const pieces: [string, Px[][]][] = alone
        ? [
            ['frozen part', frozen],
            ['tail', tail],
          ]
        : [['two pieces', [...frozen, ...tail]]]
      for (const [piece, triangles] of pieces) {
        const missed = uncovered(triangles, width)
        expect(
          missed.length,
          `points at the seam outside every triangle of the ${piece}: ${missed.slice(0, 20).join(' ')}`,
        ).toBe(0)
      }
    })
  }

  // With pen pressure both pieces end in a cap of the seam sample's coefficient times the width,
  // so each covers that smaller circle on its own
  for (const [name, path] of [
    ['straight', straight],
    ['a circle of radius 20 px', bend],
    ['turning straight back', turnBack],
  ] as const) {
    it(`with pen pressure: ${name}`, async () => {
      const width = 12
      const { frozen, tail, coefficient } = await drawUntilSeam(
        path,
        width,
        defaultOrigin,
        (i) => 0.6 + 0.35 * Math.sin(i / 4),
      )
      expect(coefficient, 'a width coefficient below 1 at the seam').toBeLessThan(1)
      for (const [piece, triangles] of [
        ['frozen part', frozen],
        ['tail', tail],
      ] as const) {
        const missed = uncovered(triangles, width * coefficient)
        expect(
          missed.length,
          `points at the seam outside every triangle of the ${piece}: ${missed.slice(0, 20).join(' ')}`,
        ).toBe(0)
      }
    })
  }

  it('finds a point left uncovered when a piece is missing', async () => {
    // The check itself: without the triangles that have a vertex inside the circle, points there are uncovered
    const { frozen, tail } = await drawUntilSeam(bend, 8)
    const triangles = [...frozen, ...tail]
    const holed = triangles.filter((t) => !t.some(([x, y]) => Math.hypot(x, y) < 4))
    expect(uncovered(holed, 8).length).toBeGreaterThan(0)
  })
})
