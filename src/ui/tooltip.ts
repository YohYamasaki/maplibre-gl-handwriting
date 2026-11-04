// The tooltips of the toolbar's buttons: a name, a short description and the keys
import { appendChildren } from './dom'
import type { Position, Size } from './layout'

/** What a button's tooltip says */
export type TooltipText = { name: string; description: string; keys?: string }

/** How long a mouse or the keyboard focus rests on a button before its tooltip shows, in ms */
export const TOOLTIP_DELAY_MS = 1000
/** After a tooltip hides as the mouse leaves its button, the next button's shows at once within this time, in ms */
const TOOLTIP_WARM_MS = 300

let nextId = 0

/**
 * One tooltip element shared by the buttons of a toolbar. It shows for a mouse resting on a button or for the
 * keyboard focus (:focus-visible), never for touch or a pen, and hides on a press, when the pointer leaves, and
 * when the toolbar is dragged
 */
export class Tooltip {
  readonly element: HTMLElement
  private timer: ReturnType<typeof setTimeout> | null = null
  private warmTimer: ReturnType<typeof setTimeout> | null = null
  // The button the tooltip shows for, or waits to show for
  private current: HTMLElement | null = null
  private cleanups: (() => void)[] = []

  /**
   * `place` gives the tooltip's top-left corner in `container` for the button and the tooltip's size;
   * `text` what it says for a button, asked each time it shows
   */
  constructor(
    private container: HTMLElement,
    private place: (button: HTMLElement, size: Size) => Position,
    private text: (button: HTMLElement) => TooltipText | null,
  ) {
    const node = document.createElement('div')
    node.className = 'handwriting-tooltip'
    node.id = `handwriting-tooltip-${++nextId}`
    node.setAttribute('role', 'tooltip')
    node.hidden = true
    this.element = node
    appendChildren(container, node)
  }

  /** Shows the tooltip for `button` as the mouse and the focus come to it */
  attach(button: HTMLElement): void {
    button.setAttribute('aria-describedby', this.element.id)
    this.listen(button, 'pointerenter', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.schedule(button)
    })
    this.listen(button, 'pointerleave', () => this.leave(button))
    this.listen(button, 'pointerdown', () => this.hide(false))
    this.listen(button, 'focus', () => {
      if (button.matches(':focus-visible')) this.schedule(button)
    })
    this.listen(button, 'blur', () => this.leave(button))
  }

  /** Hides the tooltip. `warm` lets the next button's tooltip show at once */
  hide(warm: boolean): void {
    this.clearTimer()
    const shown = !this.element.hidden
    this.element.hidden = true
    this.current = null
    if (this.warmTimer !== null) clearTimeout(this.warmTimer)
    this.warmTimer = warm && shown ? setTimeout(() => (this.warmTimer = null), TOOLTIP_WARM_MS) : null
  }

  destroy(): void {
    this.hide(false)
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.element.remove()
  }

  private listen<E extends Event>(target: EventTarget, type: string, listener: (event: E) => void): void {
    const fn = listener as EventListener
    target.addEventListener(type, fn)
    this.cleanups.push(() => target.removeEventListener(type, fn))
  }

  private leave(button: HTMLElement): void {
    if (this.current === button) this.hide(true)
  }

  private schedule(button: HTMLElement): void {
    if (this.current === button) return
    const warm = !this.element.hidden || this.warmTimer !== null
    this.hide(false)
    this.current = button
    if (warm) this.show(button)
    else this.timer = setTimeout(() => this.show(button), TOOLTIP_DELAY_MS)
  }

  private show(button: HTMLElement): void {
    this.clearTimer()
    const text = this.text(button)
    if (!text || !button.isConnected) return
    const name = document.createElement('span')
    name.className = 'handwriting-tooltip-name'
    name.textContent = text.name
    const description = document.createElement('span')
    description.className = 'handwriting-tooltip-description'
    description.textContent = text.description
    const parts: Node[] = [name, description]
    if (text.keys) {
      const keys = document.createElement('kbd')
      keys.className = 'handwriting-tooltip-keys'
      keys.textContent = text.keys
      appendChildren(name, keys)
    }
    this.element.replaceChildren(...parts)
    this.element.hidden = false
    const at = this.place(button, { width: this.element.offsetWidth, height: this.element.offsetHeight })
    this.element.style.left = `${at.left}px`
    this.element.style.top = `${at.top}px`
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
