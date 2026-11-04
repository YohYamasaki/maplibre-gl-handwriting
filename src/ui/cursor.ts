// The eraser's reach drawn around the pointer. Styled inline so that it shows without the
// package's style.css; setting element.style is allowed under a CSP that forbids inline style attributes.
// Elements styled inline are hidden with style.display, never the hidden attribute: the browser's [hidden] rule loses
// to an inline display. Elements styled in toolbar.css (the tooltip, the popovers) use the hidden attribute, with a
// [hidden] { display: none } rule there that wins over their own display

/**
 * A circle the size of the eraser, centered on a hovering pen or mouse. Lives in the map's canvas container and
 * never takes pointer input
 */
export class EraserCursor {
  readonly element: HTMLElement

  constructor(private container: HTMLElement) {
    const node = document.createElement('div')
    node.className = 'handwriting-eraser-cursor'
    node.setAttribute('aria-hidden', 'true')
    const style = node.style
    style.position = 'absolute'
    style.left = '0'
    style.top = '0'
    style.boxSizing = 'border-box'
    style.borderRadius = '50%'
    // Dark ring with a light halo, so it shows on any map
    style.border = '1.5px solid rgba(0, 0, 0, 0.7)'
    style.boxShadow = '0 0 0 1px rgba(255, 255, 255, 0.8)'
    style.pointerEvents = 'none'
    style.zIndex = '1'
    style.display = 'none'
    this.element = node
    container.appendChild(node)
  }

  /** Shows the circle of `radius` CSS px centered on the client position */
  show(clientX: number, clientY: number, radius: number): void {
    const box = this.container.getBoundingClientRect()
    const style = this.element.style
    const size = `${2 * radius}px`
    if (style.width !== size) style.width = style.height = size
    style.transform = `translate(${clientX - box.left - radius}px, ${clientY - box.top - radius}px)`
    style.display = ''
  }

  hide(): void {
    this.element.style.display = 'none'
  }

  destroy(): void {
    this.element.remove()
  }
}
