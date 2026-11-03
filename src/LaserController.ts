import type { LaserChannel } from './core/laser'
import type { Projector } from './DrawController'

export type LaserOptions = {
  /** Whether this pointerdown draws a laser line: the laser tool is selected and the pointer is accepted */
  isEnabled: (e: PointerEvent) => boolean
}

/**
 * Turns Pointer Events on an element into laser ops of this screen (source '') and emits them on the channel as
 * local (decision 0078). Nothing is stored and nothing goes into the undo history
 */
export class LaserController {
  // The line being drawn
  private drawing: { trail: number; pointerId: number } | null = null

  constructor(
    private element: HTMLElement,
    private channel: LaserChannel,
    private project: Projector,
    private options: LaserOptions,
  ) {}

  enable(): void {
    this.element.addEventListener('pointerdown', this.onPointerDown)
    this.element.addEventListener('pointermove', this.onPointerMove)
    this.element.addEventListener('pointerup', this.onPointerUp)
    this.element.addEventListener('pointercancel', this.onPointerUp)
  }

  disable(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown)
    this.element.removeEventListener('pointermove', this.onPointerMove)
    this.element.removeEventListener('pointerup', this.onPointerUp)
    this.element.removeEventListener('pointercancel', this.onPointerUp)
    this.end()
  }

  /** The pointer drawing the line, if any */
  get pointer(): number | null {
    return this.drawing?.pointerId ?? null
  }

  /** Stops the line being drawn, if any; the rest of its drag is ignored. What was drawn fades as usual */
  end(): void {
    this.drawing = null
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.drawing || e.button !== 0) return
    // Leave the event alone so the map's own gestures can handle it
    if (!this.options.isEnabled(e)) return
    this.element.setPointerCapture(e.pointerId)
    const trail = this.channel.nextTrail()
    this.drawing = { trail, pointerId: e.pointerId }
    this.channel.emit({ source: '', trail, pts: [this.project(e.clientX, e.clientY)] }, 'local')
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.drawing.pointerId) return
    // Also pick up the fine-grained input accumulated since the previous pointermove
    const events = e.getCoalescedEvents?.() ?? []
    const moves = events.length > 0 ? events : [e]
    const pts = moves.map((ev) => this.project(ev.clientX, ev.clientY))
    this.channel.emit({ source: '', trail: this.drawing.trail, pts }, 'local')
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.drawing || e.pointerId !== this.drawing.pointerId) return
    this.drawing = null
  }
}
