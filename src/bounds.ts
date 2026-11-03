import type { Point } from './core/stroke'

/** Axis-aligned box in normalized Web Mercator coordinates */
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

export function boundsOf(points: Point[]): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const [x, y] of points) {
    bounds.minX = Math.min(bounds.minX, x)
    bounds.minY = Math.min(bounds.minY, y)
    bounds.maxX = Math.max(bounds.maxX, x)
    bounds.maxY = Math.max(bounds.maxY, y)
  }
  return bounds
}

export function union(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** The box grown by `x` on the left and right and by `y` on the top and bottom */
export function grow(b: Bounds, x: number, y: number = x): Bounds {
  return { minX: b.minX - x, minY: b.minY - y, maxX: b.maxX + x, maxY: b.maxY + y }
}

export function intersects(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY
}

export function contains(outer: Bounds, inner: Bounds): boolean {
  return outer.minX <= inner.minX && inner.maxX <= outer.maxX && outer.minY <= inner.minY && inner.maxY <= outer.maxY
}
