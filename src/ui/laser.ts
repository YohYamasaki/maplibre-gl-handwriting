// Laser lines drawn over the whole map, labels included: a Canvas 2D over the map's canvas, redrawn
// every frame while any laser point is alive, and not at all otherwise
import { MercatorCoordinate, type Map as MapLibreMap } from 'maplibre-gl'
import type { LaserChannel } from '../core/laser'
import { LaserTrails } from '../LaserTrails'

/** Width of the newest part of a line, in CSS px; older parts are thinner, down to 0 when they go */
export const LASER_WIDTH = 6
/** Every line is filled once at this opacity, so where its pieces overlap is no darker */
const LASER_OPACITY = 0.8

/**
 * Shows the laser lines of a channel, its own and those received, each point fading out LASER_LIFETIME after it
 * came. Lives in the map's canvas container and never takes pointer input
 */
export class LaserOverlay {
  readonly element: HTMLCanvasElement
  private context: CanvasRenderingContext2D | null
  private trails = new LaserTrails()
  private frame = 0
  private unsubscribe: () => void
  // The canvas size in CSS px and the pixel ratio it was sized for
  private size = { width: 0, height: 0, ratio: 0 }

  constructor(
    private map: MapLibreMap,
    channel: LaserChannel,
    private color: () => string,
  ) {
    const canvas = document.createElement('canvas')
    canvas.className = 'handwriting-laser'
    canvas.setAttribute('aria-hidden', 'true')
    const style = canvas.style
    style.position = 'absolute'
    style.left = '0'
    style.top = '0'
    style.pointerEvents = 'none'
    style.zIndex = '1'
    this.element = canvas
    this.context = canvas.getContext('2d')
    map.getCanvasContainer().appendChild(canvas)
    map.on('resize', this.resize)
    this.resize()
    this.unsubscribe = channel.subscribe((op) => {
      this.trails.add(op.source, op.trail, op.pts, performance.now())
      this.schedule()
    })
  }

  destroy(): void {
    this.unsubscribe()
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.map.off('resize', this.resize)
    this.trails.clear()
    this.element.remove()
  }

  /** Sizes the canvas to the map, in device pixels; does nothing while the size is the same */
  private resize = (): void => {
    const container = this.map.getContainer()
    const width = container.clientWidth
    const height = container.clientHeight
    const ratio = window.devicePixelRatio || 1
    if (width === this.size.width && height === this.size.height && ratio === this.size.ratio) return
    this.size = { width, height, ratio }
    const canvas = this.element
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    // Resizing cleared the canvas; draw again what is alive
    if (this.trails.size > 0) this.schedule()
  }

  private schedule(): void {
    this.frame ||= requestAnimationFrame(this.draw)
  }

  /** Draws the points alive now, and goes on the next frame while any are left */
  private draw = (): void => {
    this.frame = 0
    this.trails.prune(performance.now())
    // The pixel ratio changes without a resize when the window moves to another screen
    this.resize()
    const ctx = this.context
    if (!ctx) return
    const { width, height, ratio } = this.size
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)
    if (this.trails.size === 0) return
    ctx.globalAlpha = LASER_OPACITY
    ctx.fillStyle = this.color()
    const now = performance.now()
    this.trails.forEach(now, (pts, ages) => {
      const screen = pts.map(([x, y]) => this.map.project(new MercatorCoordinate(x, y).toLngLat()))
      const radii = ages.map((age) => (LASER_WIDTH / 2) * (1 - age))
      ctx.beginPath()
      traceTrail(ctx, screen, radii)
      ctx.fill()
    })
    this.schedule()
  }
}

/** The parts of a line's path that canvas paths and test doubles both have */
type PathSink = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'arc' | 'closePath'>

/**
 * Adds a line's outline to the current path: a circle of radius radii[i] at each point and, between two points, the
 * trapezoid joining their circles' diameters across the segment. Every shape winds the same way, so filling the
 * path once with the nonzero rule paints their union, each pixel once
 */
export function traceTrail(ctx: PathSink, pts: { x: number; y: number }[], radii: number[]): void {
  for (let i = 0; i < pts.length; i++) {
    const { x, y } = pts[i]
    const r = radii[i]
    if (r <= 0) continue
    ctx.moveTo(x + r, y)
    // Clockwise on screen (y down)
    ctx.arc(x, y, r, 0, 2 * Math.PI)
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length === 0) continue
    // Unit normal to the segment
    const nx = -(b.y - a.y) / length
    const ny = (b.x - a.x) / length
    const ra = Math.max(0, radii[i])
    const rb = Math.max(0, radii[i + 1])
    // a - n, b - n, b + n, a + n: clockwise on screen, like the circles
    ctx.moveTo(a.x - nx * ra, a.y - ny * ra)
    ctx.lineTo(b.x - nx * rb, b.y - ny * rb)
    ctx.lineTo(b.x + nx * rb, b.y + ny * rb)
    ctx.lineTo(a.x + nx * ra, a.y + ny * ra)
    ctx.closePath()
  }
}
