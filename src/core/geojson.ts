// Strokes as GeoJSON (RFC 7946) for GIS tools such as QGIS. The caller chooses which strokes to pass
import { mercatorPerPixelAt } from './mercator'
import type { StrokeData } from './stroke'

/** Decimal places kept in coordinates: 1e-9 degrees is about 0.1 mm, well below 1 px at zoom 24 (about 4.7 mm) */
const COORDINATE_DIGITS = 9
const COORDINATE_SCALE = 10 ** COORDINATE_DIGITS
/** The Earth's circumference at the equator in Web Mercator, in metres */
const EQUATOR_METRES = 40075016.686

type Position = [lng: number, lat: number]

/** The properties of each Feature. pressure is there only for a stroke drawn with pressure, one per coordinate */
export type StrokeFeatureProperties = {
  id: string
  author: string
  /** The stroke's place in the drawing order, or null for a stroke without an order yet */
  order: number | null
  /** #rrggbb */
  color: string
  /** 0 to 1, from the alpha of a #rrggbbaa color; 1 for #rrggbb */
  opacity: number
  /** Width in CSS px at the zoom it was drawn at */
  width_px: number
  zoom: number
  /** Width on the ground, in metres, at the latitude of the stroke's first point */
  width_m: number
  pressure?: number[]
}

/**
 * A FeatureCollection, as a JSON string, with one Feature per stroke that has points: a LineString of the
 * stroke's sample points in WGS84 [lng, lat] rounded to 9 decimals, without the points that rounding made equal to
 * the one before, or a Point when one is left. Features are in drawing order (strokes without an order last),
 * then by id. A stroke whose points are spilled (null) is left out: StrokeStore.read gives them back
 */
export function strokesToGeoJSON(strokes: Iterable<StrokeData>): string {
  const sorted = [...strokes].sort(byDrawingOrder)
  const features: unknown[] = []
  for (const stroke of sorted) {
    const feature = strokeFeature(stroke)
    if (feature) features.push(feature)
  }
  return JSON.stringify({ type: 'FeatureCollection', features })
}

function byDrawingOrder(a: StrokeData, b: StrokeData): number {
  const ao = a.order ?? Infinity
  const bo = b.order ?? Infinity
  if (ao !== bo) return ao < bo ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function strokeFeature(stroke: StrokeData): unknown {
  const coordinates: Position[] = []
  const pressure: number[] = []
  const { points } = stroke
  if (!points) return null
  for (let i = 0; 2 * i + 1 < points.length; i++) {
    const position = toPosition(points[2 * i], points[2 * i + 1])
    const last = coordinates[coordinates.length - 1]
    if (last && last[0] === position[0] && last[1] === position[1]) continue
    coordinates.push(position)
    if (stroke.pressure) pressure.push(shortestFloat32(stroke.pressure[i]))
  }
  if (coordinates.length === 0) return null
  const geometry =
    coordinates.length === 1 ? { type: 'Point', coordinates: coordinates[0] } : { type: 'LineString', coordinates }
  const properties: StrokeFeatureProperties = {
    id: stroke.id,
    author: stroke.author,
    order: stroke.order ?? null,
    color: stroke.color.slice(0, 7),
    opacity: opacityOf(stroke.color),
    width_px: stroke.width,
    zoom: stroke.zoom,
    width_m: widthInMetres(stroke),
    ...(stroke.pressure ? { pressure } : {}),
  }
  return { type: 'Feature', geometry, properties }
}

/** Normalized Web Mercator (0 to 1, y down) to WGS84 degrees, rounded */
function toPosition(x: number, y: number): Position {
  const lng = 360 * x - 180
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI
  return [round(lng), round(lat)]
}

function round(value: number): number {
  // + 0 turns -0 into 0
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE + 0
}

/**
 * The number with the fewest significant digits that rounds to the same float32 as `value`, a width coefficient kept
 * in a Float32Array: 0.502 rather than 0.5019999742507935
 */
function shortestFloat32(value: number): number {
  for (let digits = 1; digits <= 9; digits++) {
    const shorter = Number(value.toPrecision(digits))
    if (Math.fround(shorter) === value) return shorter
  }
  return value
}

/** The alpha of #rrggbbaa as 0 to 1, or 1 for #rrggbb */
function opacityOf(color: string): number {
  return color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1
}

function widthInMetres(stroke: StrokeData): number {
  const y = stroke.points![1]
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y)))
  return stroke.width * mercatorPerPixelAt(stroke.zoom) * EQUATOR_METRES * Math.cos(lat)
}
