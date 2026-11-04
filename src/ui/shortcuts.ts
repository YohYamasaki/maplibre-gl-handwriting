// The list of keyboard shortcuts that ? shows over the map. Styled inline, like the
// eraser's circle, so that it shows without the package's style.css
import type { Tool } from '../createHandwriting'
import { shortcutRows } from '../keyboard'
import { appendChildren } from './dom'

/**
 * A panel centered over the map listing the shortcuts. Its element exists only while it is open: a press
 * outside it, Esc (through KeyboardShortcuts) or destroy() removes it
 */
export class ShortcutList {
  private element: HTMLElement | null = null

  /** `tools`: the handle's tools, the only ones with a row */
  constructor(
    private container: HTMLElement,
    private tools: readonly NonNullable<Tool>[],
  ) {}

  get isOpen(): boolean {
    return this.element !== null
  }

  toggle(): void {
    if (this.element) this.close()
    else this.open()
  }

  /** Removes the list. Returns whether it was open */
  close(): boolean {
    if (!this.element) return false
    this.element.remove()
    this.element = null
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    return true
  }

  destroy(): void {
    this.close()
  }

  private open(): void {
    const node = document.createElement('div')
    node.className = 'handwriting-shortcuts'
    node.setAttribute('role', 'dialog')
    node.setAttribute('aria-label', 'Keyboard shortcuts')
    const style = node.style
    style.position = 'absolute'
    style.left = '50%'
    style.top = '50%'
    style.transform = 'translate(-50%, -50%)'
    style.maxWidth = 'calc(100% - 32px)'
    style.maxHeight = 'calc(100% - 32px)'
    style.overflow = 'auto'
    style.boxSizing = 'border-box'
    style.padding = '12px 16px'
    style.borderRadius = '8px'
    style.background = 'rgba(255, 255, 255, 0.97)'
    style.color = '#1f2328'
    style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.2)'
    style.font = '13px/1.5 system-ui, sans-serif'
    style.zIndex = '3'

    const title = document.createElement('div')
    title.textContent = 'Keyboard shortcuts'
    title.style.fontWeight = '600'
    title.style.marginBottom = '6px'
    const table = document.createElement('table')
    table.style.borderCollapse = 'collapse'
    for (const [keys, action] of shortcutRows(undefined, this.tools)) {
      const row = document.createElement('tr')
      const key = document.createElement('td')
      key.textContent = keys
      key.style.padding = '2px 16px 2px 0'
      key.style.whiteSpace = 'nowrap'
      key.style.fontFamily = 'ui-monospace, monospace'
      const what = document.createElement('td')
      what.textContent = action
      what.style.padding = '2px 0'
      appendChildren(row, key, what)
      appendChildren(table, row)
    }
    appendChildren(node, title, table)
    appendChildren(this.container, node)
    this.element = node
    document.addEventListener('pointerdown', this.onPointerDown, true)
  }

  // A press outside the list closes it; the press still does what it does there
  private onPointerDown = (e: PointerEvent): void => {
    const target = e.target as Node | null
    if (this.element && target && this.element.contains(target)) return
    this.close()
  }
}
