import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl'
import type { Bounds } from './bounds'
import type { Projector } from './DrawController'
import { mercatorPerPixelAt } from './mercator'
import type { ScreenProjector } from './SelectController'

/** Projector that converts a screen position to normalized Web Mercator coordinates through the map's camera */
export function createMapProjector(map: MapLibreMap): Projector {
  return (clientX: number, clientY: number) => {
    const rect = map.getCanvasContainer().getBoundingClientRect()
    // wrap() brings longitudes from world copies back into -180..180, so x stays within 0..1
    const lngLat = map.unproject([clientX - rect.left, clientY - rect.top]).wrap()
    const { x, y } = MercatorCoordinate.fromLngLat(lngLat)
    return [clamp01(x), clamp01(y)]
  }
}

/** Projector that converts normalized Web Mercator coordinates to a screen position through the map's camera */
export function createScreenProjector(map: MapLibreMap): ScreenProjector {
  return ([x, y]) => {
    const rect = map.getCanvasContainer().getBoundingClientRect()
    const { x: px, y: py } = map.project(new MercatorCoordinate(x, y).toLngLat())
    return [px + rect.left, py + rect.top]
  }
}

/** Size of one CSS px in normalized Web Mercator units at the map's current zoom */
export function mercatorPerPixel(map: MapLibreMap): number {
  return mercatorPerPixelAt(map.getZoom())
}

/**
 * The visible area in normalized Web Mercator coordinates. MapLibre's bounds enclose the four screen corners
 * (cut at the horizon when pitched), so with rotation the box is larger than the screen
 */
export function visibleBounds(map: MapLibreMap): Bounds {
  const lngLat = map.getBounds()
  const northWest = MercatorCoordinate.fromLngLat(lngLat.getNorthWest())
  const southEast = MercatorCoordinate.fromLngLat(lngLat.getSouthEast())
  return { minX: northWest.x, minY: northWest.y, maxX: southEast.x, maxY: southEast.y }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
