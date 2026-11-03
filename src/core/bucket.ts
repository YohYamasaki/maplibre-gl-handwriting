// Buckets: every stroke belongs to the map tile, at its drawing zoom rounded down to a multiple of
// BUCKET_ZOOM_STEP, that contains its first point. The client meshes strokes per bucket, and the server
// stores the bucket so it can send strokes tile by tile.
// Used by the client and the Worker, so it must not depend on DOM / MapLibre / Cloudflare APIs.
import type { Point } from './stroke'

/** A map tile, in the XYZ scheme MapLibre uses */
export type TileID = { z: number; x: number; y: number }

/** Bucket levels are 0, 3, 6, ... so that one level covers the zooms a mesh stays sharp over */
export const BUCKET_ZOOM_STEP = 3

/** Deepest bucket level. Matches the deepest zoom a stroke can be drawn at (LIMITS.maxZoom) */
export const MAX_BUCKET_LEVEL = 24

/** The bucket level for strokes drawn at `zoom` */
export function bucketLevel(zoom: number): number {
  return Math.min(MAX_BUCKET_LEVEL, Math.floor(Math.max(0, zoom) / BUCKET_ZOOM_STEP) * BUCKET_ZOOM_STEP)
}

/** The tile at level `z` that contains a point in normalized Web Mercator coordinates */
function tileAt([x, y]: Point, z: number): TileID {
  const tiles = 2 ** z
  // Points on the right or bottom edge of the world (x or y = 1) belong to the last tile
  const toTile = (v: number) => Math.min(tiles - 1, Math.max(0, Math.floor(v * tiles)))
  return { z, x: toTile(x), y: toTile(y) }
}

/** The bucket of a stroke drawn at `zoom` whose first point is `first` */
export function bucketOf(first: Point, zoom: number): TileID {
  return tileAt(first, bucketLevel(zoom))
}

export function tileKey({ z, x, y }: TileID): string {
  return `${z}/${x}/${y}`
}

/** The tile at level `z` (at most tile.z) that contains `tile` */
export function ancestorAt(tile: TileID, z: number): TileID {
  const shift = tile.z - z
  return { z, x: tile.x >> shift, y: tile.y >> shift }
}
