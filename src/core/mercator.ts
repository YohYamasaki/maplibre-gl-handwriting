// Web Mercator units. No DOM / MapLibre dependency, so the Worker and the parts that run without a browser can use it

/** MapLibre's world size at zoom 0, in px */
const TILE_SIZE = 512

/** Size of one CSS px in normalized Web Mercator units at `zoom` */
export function mercatorPerPixelAt(zoom: number): number {
  return 1 / (TILE_SIZE * 2 ** zoom)
}
