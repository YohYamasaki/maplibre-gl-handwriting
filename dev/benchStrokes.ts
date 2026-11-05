// Strokes generated for load tests (decision 0089): never saved, never sent, drawn by a second handle of their own
import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl'
import type { StrokeData } from '../src/core/stroke'
import type { Bounds } from '../src/bounds'
import { mercatorPerPixelAt } from '../src/mercator'

/** Distance between two points of a generated stroke, in px at the zoom it is drawn at */
const STEP_PX = 3
const MIN_STEPS = 30
const MAX_STEPS = 150
/** Share of the strokes drawn with the translucent color */
const TRANSLUCENT_SHARE = 0.3
/** An opaque pen and a translucent highlighter, at the default widths (the colors are not the library's defaults) */
const OPAQUE = { color: '#48ff00', width: 4 }
const TRANSLUCENT = { color: '#413bff80', width: 16 }
/** Width of the band along each edge of a wide axis where a stroke turns back inward, in px */
const WALL_PX = 30
/** How far inside the bounds the point a stroke turns toward in the band lies, in px */
const STEER_INSET = 2 * WALL_PX
/** Largest turn toward that point per step, in radians */
const MAX_STEER = 0.25
/** Share of the turn rate kept from one step to the next */
const RATE_DECAY = 0.9
/** Largest random change of the turn rate per step, in radians */
const RATE_NOISE = 0.02
/** Largest turn rate away from the band, in radians per step */
const MAX_TURN_RATE = 0.1

/**
 * `count` strokes without pressure, each a random walk of 31 to 151 points STEP_PX apart at `zoom`, kept inside
 * `bounds` (and inside [0, 1]). IDs `bench:<n>` and orders 1..count. `rand` returns numbers in [0, 1), like Math.random.
 *
 * The direction turns smoothly: by a turn rate that drifts randomly (RATE_DECAY, RATE_NOISE, at most MAX_TURN_RATE).
 * An axis is wide when the bounds span at least 2 × WALL_PX on it. On a wide axis a stroke starts at least WALL_PX
 * from the edges, and within WALL_PX of an edge it turns by at most MAX_STEER per step toward the nearest point
 * STEER_INSET inside the bounds, so it bends away from the edge instead of sliding along it. A narrow axis is not
 * steered: there a stroke may run along the edge (only when the map shows far outside the world)
 */
export function generateBenchStrokes(count: number, bounds: Bounds, zoom: number, rand: () => number): StrokeData[] {
  const box = clampToWorld(bounds)
  const px = mercatorPerPixelAt(zoom)
  const step = STEP_PX * px
  const xAxis = axis(box.minX, box.maxX, px)
  const yAxis = axis(box.minY, box.maxY, px)
  const strokes: StrokeData[] = []
  for (let n = 1; n <= count; n++) {
    const steps = MIN_STEPS + Math.floor(rand() * (MAX_STEPS - MIN_STEPS + 1))
    let x = xAxis.startMin + rand() * (xAxis.startMax - xAxis.startMin)
    let y = yAxis.startMin + rand() * (yAxis.startMax - yAxis.startMin)
    let angle = rand() * 2 * Math.PI
    let rate = 0
    const points = [x, y]
    for (let i = 0; i < steps; i++) {
      if (inBand(xAxis, x) || inBand(yAxis, y)) {
        rate = 0
        const dx = towardInside(xAxis, x) - x
        const dy = towardInside(yAxis, y) - y
        if (dx !== 0 || dy !== 0) {
          angle += clamp(wrapAngle(Math.atan2(dy, dx) - angle), -MAX_STEER, MAX_STEER)
        }
      } else {
        rate = clamp(RATE_DECAY * rate + (rand() - 0.5) * 2 * RATE_NOISE, -MAX_TURN_RATE, MAX_TURN_RATE)
        angle += rate
      }
      x = clamp(x + Math.cos(angle) * step, box.minX, box.maxX)
      y = clamp(y + Math.sin(angle) * step, box.minY, box.maxY)
      points.push(x, y)
    }
    const pen = rand() < TRANSLUCENT_SHARE ? TRANSLUCENT : OPAQUE
    strokes.push({
      id: `bench:${n}`,
      author: 'bench',
      color: pen.color,
      width: pen.width,
      zoom,
      points: new Float64Array(points),
      order: n,
    })
  }
  return strokes
}

/** One axis of the bounds, in Mercator units */
interface Axis {
  min: number
  max: number
  /** Whether the strokes are steered away from its edges */
  wide: boolean
  /** Band along each edge where a stroke turns back */
  wall: number
  /** Range the steering aims into; a single point (the center) when the axis is too short for STEER_INSET */
  innerMin: number
  innerMax: number
  /** Range the strokes start in */
  startMin: number
  startMax: number
}

function axis(min: number, max: number, px: number): Axis {
  const wall = WALL_PX * px
  const inset = STEER_INSET * px
  const wide = max - min >= 2 * wall
  const center = (min + max) / 2
  const fits = max - min >= 2 * inset
  return {
    min,
    max,
    wide,
    wall,
    innerMin: fits ? min + inset : center,
    innerMax: fits ? max - inset : center,
    startMin: wide ? min + wall : min,
    startMax: wide ? max - wall : max,
  }
}

function inBand(a: Axis, v: number): boolean {
  return a.wide && (v - a.min <= a.wall || a.max - v <= a.wall)
}

/** The coordinate the steering aims at on this axis: the nearest one inside, or `v` itself on a narrow axis */
function towardInside(a: Axis, v: number): number {
  return a.wide ? clamp(v, a.innerMin, a.innerMax) : v
}

/** `angle` in [-π, π] */
function wrapAngle(angle: number): number {
  const turns = Math.round(angle / (2 * Math.PI))
  return angle - turns * 2 * Math.PI
}

/** The box the map shows at one zoom level less (twice as wide and tall, around the same center), cut to [0, 1] */
export function benchBounds(map: MapLibreMap): Bounds {
  const view = map.getBounds()
  const nw = MercatorCoordinate.fromLngLat(view.getNorthWest())
  const se = MercatorCoordinate.fromLngLat(view.getSouthEast())
  const cx = (nw.x + se.x) / 2
  const cy = (nw.y + se.y) / 2
  const w = se.x - nw.x
  const h = se.y - nw.y
  return clampToWorld({
    minX: cx - w,
    minY: cy - h,
    maxX: cx + w,
    maxY: cy + h,
  })
}

function clampToWorld(b: Bounds): Bounds {
  return {
    minX: clamp(b.minX, 0, 1),
    minY: clamp(b.minY, 0, 1),
    maxX: clamp(b.maxX, 0, 1),
    maxY: clamp(b.maxY, 0, 1),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
