// Scale benchmark: a room of a few thousand strokes drawn at many zooms, viewed through a fixed sequence of
// zooms, pans, a long new stroke and erases, with the real lyon tessellator. Records counters that grow with
// the structure of the code rather than with the machine (vertices, copied points, draw calls, kept bytes),
// writes them to bench-result.json in the harness state (decision 0049), and checks them against limits.json here once
// the user has
// approved the limits there. Wall-clock times are recorded for reference only
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { StrokeStore, type Point, type StrokeData } from '../../src/core/stroke'
import type { Bounds } from '../../src/bounds'
import { mercatorPerPixelAt } from '../../src/mercator'
import { StrokeScene, type SceneStats } from '../../src/StrokeScene'
import { StrokeTessellator } from '../../src/StrokeTessellator'
import { buildBucketMesh, type BuildJob } from '../../src/TessellationWorker'
import { random } from '../support'

const root = join(import.meta.dirname, '../..')
const SCREEN = { width: 1000, height: 700 }
const CENTER: Point = [0.8892, 0.3672]
// Share of the room drawn with the marker
const MARKER_SHARE = 0.3

type Limits = { approved: boolean; limits: Record<string, number> }

/** The harness state, as .claude/hooks/repo.mjs finds it: HARNESS_STATE_DIR, the git dir, or .claude/state */
function stateDir(): string {
  if (process.env.HARNESS_STATE_DIR) return process.env.HARNESS_STATE_DIR
  const gitDir = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir'], {
    encoding: 'utf8',
  })
  return gitDir.status === 0 ? join(gitDir.stdout.trim(), 'claude-harness') : join(root, '.claude/state')
}

/** Strokes drawn at `zoom`, spread over `screens` screens (at that zoom) around the center */
function makeStrokes(
  rand: () => number,
  count: number,
  zooms: [number, number],
  screens: number,
  start: number,
): StrokeData[] {
  return Array.from({ length: count }, (_, i) => {
    const zoom = zooms[0] + rand() * (zooms[1] - zooms[0])
    const px = mercatorPerPixelAt(zoom)
    let p: Point = [
      CENTER[0] + (rand() - 0.5) * SCREEN.width * px * screens,
      CENTER[1] + (rand() - 0.5) * SCREEN.height * px * screens,
    ]
    let heading = rand() * Math.PI * 2
    const points: Point[] = [p]
    const n = 30 + Math.floor(rand() * 120)
    for (let k = 0; k < n; k++) {
      heading += (rand() - 0.5) * 0.6
      p = [p[0] + Math.cos(heading) * 3 * px, p[1] + Math.sin(heading) * 3 * px]
      points.push(p)
    }
    // Some are marker strokes, which are drawn in order rather than by depth (ADR 0024)
    const color = rand() < MARKER_SHARE ? '#33669980' : '#336699'
    return { id: `s${start + i}`, author: 'bench', color, width: 8, zoom, points, order: start + i + 1 }
  })
}

it('scale benchmark', async () => {
  const tessellator = await StrokeTessellator.load(
    readFileSync(join(root, 'tessellator/pkg/handwriting_tessellator_bg.wasm')),
  )
  const rand = random(7)
  const store = new StrokeStore({ order: 'custom' })
  const jobs: BuildJob[] = []
  let zoom = 12
  let center: Point = [...CENTER]
  const scene = new StrokeScene(store, tessellator, { build: (job) => jobs.push(job) }, zoom)
  const view = (): Bounds => {
    const px = mercatorPerPixelAt(zoom)
    return {
      minX: center[0] - (SCREEN.width / 2) * px,
      maxX: center[0] + (SCREEN.width / 2) * px,
      minY: center[1] - (SCREEN.height / 2) * px,
      maxY: center[1] + (SCREEN.height / 2) * px,
    }
  }

  // Per-frame maxima, and the worst frame time
  const perFrame = { drawCalls: 0, bucketsScanned: 0, mainThreadVertices: 0, buildPoints: 0 }
  let frames = 0
  let worstFrameMs = 0
  let previous: SceneStats = scene.stats()
  /** One frame: the scene's work, then every build it asked for (a worker that keeps up) */
  const frame = (): void => {
    const started = performance.now()
    scene.frame(view(), zoom)
    worstFrameMs = Math.max(worstFrameMs, performance.now() - started)
    const now = scene.stats()
    perFrame.drawCalls = Math.max(perFrame.drawCalls, now.drawCalls)
    perFrame.bucketsScanned = Math.max(perFrame.bucketsScanned, now.bucketsScanned)
    perFrame.mainThreadVertices = Math.max(
      perFrame.mainThreadVertices,
      now.mainThreadVertices - previous.mainThreadVertices,
    )
    perFrame.buildPoints = Math.max(perFrame.buildPoints, now.buildPoints - previous.buildPoints)
    previous = now
    frames++
    for (const job of jobs.splice(0)) scene.onBuilt(buildBucketMesh(tessellator, job).result)
  }

  // A room of 3000 strokes, 30% of them marker strokes: a city drawn at z12–14, a dense spot at z16–18,
  // and large strokes at z5–8
  const strokes = [
    ...makeStrokes(rand, 1500, [12, 14], 6, 0),
    ...makeStrokes(rand, 1000, [16, 18], 8, 1500),
    ...makeStrokes(rand, 500, [5, 8], 2, 2500),
  ]
  store.apply({ type: 'load', strokes }, 'remote')
  frame()
  frame()

  // Zoom in to 18, pan around, zoom out to 6
  for (; zoom < 18; zoom += 0.25) frame()
  for (let i = 0; i < 10; i++) {
    center = [center[0] + (SCREEN.width / 2) * mercatorPerPixelAt(zoom), center[1]]
    frame()
  }
  for (; zoom > 6; zoom -= 0.5) frame()

  // Draw a long stroke at z12, a frame every few points
  zoom = 12
  center = [...CENTER]
  frame()
  const id = 'me:0'
  store.apply({ type: 'begin', id, author: 'me', color: '#cc3300', width: 8, zoom }, 'local')
  let p: Point = [...CENTER]
  for (let i = 0; i < 2000; i += 5) {
    const pts = Array.from(
      { length: 5 },
      (): Point =>
        (p = [
          p[0] + (rand() - 0.3) * 2 * mercatorPerPixelAt(zoom),
          p[1] + (rand() - 0.5) * 2 * mercatorPerPixelAt(zoom),
        ]),
    )
    store.apply({ type: 'points', id, pts }, 'local')
    frame()
  }
  store.apply({ type: 'end', id }, 'local')
  frame()

  // Erase 50 strokes, a frame after each
  for (const stroke of strokes.slice(0, 50)) {
    store.apply({ type: 'remove', id: stroke.id }, 'local')
    frame()
  }

  const end = scene.stats()
  const result = {
    room: { strokes: strokes.length, points: strokes.reduce((sum, s) => sum + s.points.length, 0) },
    frames,
    perFrameMax: perFrame,
    total: {
      mainThreadVertices: end.mainThreadVertices,
      builds: end.builds,
      buildPoints: end.buildPoints,
      planRebuilds: end.planRebuilds,
    },
    retainedAtEnd: {
      strokes: end.strokes,
      buckets: end.buckets,
      meshes: end.meshes,
      meshVertices: end.meshVertices,
      meshBytesAllocated: end.meshBytesAllocated,
      meshBytesUsed: end.meshBytesUsed,
    },
    // For reference only: depends on the machine
    worstFrameMs: Math.round(worstFrameMs * 10) / 10,
  }
  const state = stateDir()
  mkdirSync(state, { recursive: true })
  writeFileSync(join(state, 'bench-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))

  const { approved, limits }: Limits = JSON.parse(readFileSync(join(import.meta.dirname, 'limits.json'), 'utf8'))
  if (!approved) return
  const flat: Record<string, number> = {
    ...Object.fromEntries(Object.entries(result.perFrameMax).map(([k, v]) => [`perFrameMax.${k}`, v])),
    ...Object.fromEntries(Object.entries(result.total).map(([k, v]) => [`total.${k}`, v])),
    ...Object.fromEntries(Object.entries(result.retainedAtEnd).map(([k, v]) => [`retainedAtEnd.${k}`, v])),
  }
  const over = Object.entries(limits).filter(([key, limit]) => flat[key] > limit)
  expect(over.map(([key, limit]) => `${key}: ${flat[key]} > ${limit}`)).toEqual([])
}, 600_000)
