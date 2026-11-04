// Draws the strokes with Canvas2D on a canvas over the map instead of the WebGL layers, to compare the two (decision
// 0089). Pressure and pitch are not drawn; the map's rotation is. Debug only: every frame tests the bounding box of
// every stroke of the stores
import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl'
import type { Point, StrokeData, StrokeOp, StrokeStore } from '../src/core/stroke'
import { mercatorPerPixelAt } from '../src/mercator'

/** What the map shows: its center (normalized Web Mercator), zoom, bearing (degrees) and size (CSS px) */
export type StrokeView = {
  center: Point
  zoom: number
  bearing: number
  width: number
  height: number
  /** Device px per CSS px */
  pixelRatio: number
}

/** The arguments of CanvasRenderingContext2D.setTransform: a, b, c, d, e, f */
export type CanvasTransform = [number, number, number, number, number, number]

/**
 * The transform from a stroke's path coordinates (px at the stroke's zoom, from its first point) to device px on
 * the canvas. The path stays small numbers so that the float32 math of Canvas2D keeps its precision
 */
export function strokeTransform(stroke: Pick<StrokeData, 'points' | 'zoom'>, view: StrokeView): CanvasTransform {
  const { pixelRatio } = view
  const scale = 2 ** (view.zoom - stroke.zoom) * pixelRatio
  // MapLibre's bearing turns the map counterclockwise on screen
  const angle = (-view.bearing * Math.PI) / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const devicePxPerMercator = pixelRatio / mercatorPerPixelAt(view.zoom)
  const [x0, y0] = stroke.points[0]
  const dx = (x0 - view.center[0]) * devicePxPerMercator
  const dy = (y0 - view.center[1]) * devicePxPerMercator
  return [
    scale * cos,
    scale * sin,
    -scale * sin,
    scale * cos,
    cos * dx - sin * dy + (view.width * pixelRatio) / 2,
    sin * dx + cos * dy + (view.height * pixelRatio) / 2,
  ]
}

/** A stroke's path for the number of points it had when the path was made, and its box grown by half its width */
type CachedPath = {
  stroke: StrokeData
  count: number
  path: Path2D
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export class Canvas2DStrokes {
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  /** One cache per store, by stroke ID */
  private readonly caches: Map<string, CachedPath>[]
  private readonly unsubscribes: (() => void)[]
  /** Layers this hid, to show again on destroy */
  private readonly hidden = new Set<string>()

  /**
   * Draws the strokes of `stores`, each over the ones before it, and hides the layers `layerIds` while it lives.
   * `onTime` gets the time each frame's drawing took, in ms
   */
  constructor(
    private readonly map: MapLibreMap,
    private readonly stores: StrokeStore[],
    private readonly layerIds: string[],
    private readonly onTime: (ms: number) => void,
  ) {
    this.canvas = document.createElement('canvas')
    Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' })
    const mapCanvas = map.getCanvas()
    mapCanvas.parentElement?.insertBefore(this.canvas, mapCanvas.nextSibling)
    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('Canvas2D is not available')
    this.context = context
    this.caches = stores.map(() => new Map())
    this.unsubscribes = stores.map((store, i) => store.subscribe((op) => this.onOp(this.caches[i], op)))
    map.on('render', this.draw)
    map.triggerRepaint()
  }

  destroy(): void {
    this.map.off('render', this.draw)
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    for (const cache of this.caches) cache.clear()
    this.canvas.remove()
    for (const id of this.hidden) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'visible')
    this.hidden.clear()
    this.map.triggerRepaint()
  }

  /** Drops the paths an op changed; growing strokes are caught by their number of points */
  private onOp(cache: Map<string, CachedPath>, op: StrokeOp): void {
    switch (op.type) {
      case 'remove':
      case 'split':
        cache.delete(op.id)
        break
      case 'transform':
        for (const id of op.ids) cache.delete(id)
        break
      case 'replace':
        for (const stroke of op.strokes) cache.delete(stroke.id)
        break
      case 'reset':
        cache.clear()
        break
    }
    this.map.triggerRepaint()
  }

  private readonly draw = (): void => {
    const start = performance.now()
    this.hideLayers()
    const view = this.view()
    const { canvas, context } = this
    const width = Math.round(view.width * view.pixelRatio)
    const height = Math.round(view.height * view.pixelRatio)
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
      canvas.style.width = `${view.width}px`
      canvas.style.height = `${view.height}px`
    }
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, width, height)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    // A box around the rotated screen, in normalized Web Mercator
    const radius = (Math.hypot(view.width, view.height) / 2) * mercatorPerPixelAt(view.zoom)
    const [cx, cy] = view.center
    this.stores.forEach((store, i) => {
      const visible: CachedPath[] = []
      let sorted = true
      for (const stroke of store.values()) {
        if (stroke.points.length === 0) continue
        const entry = this.pathOf(this.caches[i], stroke)
        if (
          entry.maxX < cx - radius ||
          entry.minX > cx + radius ||
          entry.maxY < cy - radius ||
          entry.minY > cy + radius
        ) {
          continue
        }
        if (visible.length > 0 && orderOf(visible[visible.length - 1].stroke) > orderOf(stroke)) sorted = false
        visible.push(entry)
      }
      // Later strokes over earlier ones; strokes not saved yet on top
      if (!sorted) visible.sort((a, b) => compareOrder(a.stroke, b.stroke))
      for (const { stroke, path } of visible) {
        context.setTransform(...strokeTransform(stroke, view))
        context.lineWidth = stroke.width
        context.strokeStyle = stroke.color
        context.stroke(path)
      }
    })
    this.onTime(performance.now() - start)
  }

  private view(): StrokeView {
    const center = MercatorCoordinate.fromLngLat(this.map.getCenter())
    const container = this.map.getContainer()
    return {
      center: [center.x, center.y],
      zoom: this.map.getZoom(),
      bearing: this.map.getBearing(),
      width: container.clientWidth,
      height: container.clientHeight,
      pixelRatio: window.devicePixelRatio || 1,
    }
  }

  /** Hides the WebGL layers; also called on every frame, for layers added since */
  hideLayers(): void {
    for (const id of this.layerIds) {
      if (!this.map.getLayer(id) || this.map.getLayoutProperty(id, 'visibility') === 'none') continue
      this.map.setLayoutProperty(id, 'visibility', 'none')
      this.hidden.add(id)
    }
  }

  private pathOf(cache: Map<string, CachedPath>, stroke: StrokeData): CachedPath {
    const cached = cache.get(stroke.id)
    if (cached && cached.stroke === stroke && cached.count === stroke.points.length) return cached
    const unit = mercatorPerPixelAt(stroke.zoom)
    const [x0, y0] = stroke.points[0]
    const path = new Path2D()
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    stroke.points.forEach(([x, y], i) => {
      const px = (x - x0) / unit
      const py = (y - y0) / unit
      if (i === 0) path.moveTo(px, py)
      path.lineTo(px, py)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    })
    const half = (stroke.width * unit) / 2
    const entry = {
      stroke,
      count: stroke.points.length,
      path,
      minX: minX - half,
      minY: minY - half,
      maxX: maxX + half,
      maxY: maxY + half,
    }
    cache.set(stroke.id, entry)
    return entry
  }
}

function orderOf(stroke: StrokeData): number {
  return stroke.order ?? Infinity
}

/** Keeps strokes not saved yet in the store's order (Infinity - Infinity is NaN) */
function compareOrder(a: StrokeData, b: StrokeData): number {
  const difference = orderOf(a) - orderOf(b)
  return Number.isNaN(difference) ? 0 : difference
}
