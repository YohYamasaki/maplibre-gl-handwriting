// The frame around the selection, its handles, its action bar and the lasso being drawn.
// Styled inline, like the eraser's cursor, so that they show without the package's style.css.
// Elements styled inline are hidden with style.display, never the hidden attribute: the browser's [hidden] rule loses
// to an inline display. Elements styled in toolbar.css (the tooltip, the popovers) use the hidden attribute, with a
// [hidden] { display: none } rule there that wins over their own display
import type { Point } from '../core/stroke'
import { HANDLE_RADIUS, rotateHandle, type ScreenProjector } from '../SelectController'
import type { Selection } from '../Selection'
import { appendChildren } from './dom'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** Drawn size of a handle, in CSS px; it grabs within HANDLE_RADIUS */
const HANDLE_SIZE = 10
/** Gap between the frame's lowest point and the action bar, in CSS px */
const BAR_GAP = 12

export type SelectionFrameOptions = {
  /** Called when Delete in the action bar is pressed */
  onDelete: () => void
  /** Called when Duplicate in the action bar is pressed */
  onDuplicate: () => void
  /** Called when Export in the action bar is pressed; the bar has no Export when omitted */
  onExport?: () => void
}

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
  return node
}

function barButton(label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.textContent = label
  node.className = `handwriting-selection-${label.toLowerCase()}`
  const style = node.style
  style.font = '13px system-ui, sans-serif'
  style.padding = '4px 10px'
  style.border = 'none'
  style.background = 'transparent'
  style.color = '#222'
  style.cursor = 'pointer'
  node.addEventListener('click', onClick)
  return node
}

/**
 * Draws the selection's frame, rotated and scaled with it, with corner handles (scale) and a handle above it
 * (rotate), and the lasso while one is drawn, in an SVG over the map that never takes pointer input: the select
 * controller hit-tests the same geometry. Below the frame, a bar with Delete, Duplicate and (when given
 * onExport) Export takes clicks
 */
export class SelectionFrame {
  private overlay: SVGSVGElement
  private outline: SVGPolygonElement
  private stem: SVGLineElement
  private handles: SVGRectElement[]
  private rotate: SVGCircleElement
  private lasso: SVGPolylineElement
  private bar: HTMLElement
  private unsubscribe: () => void

  constructor(
    private container: HTMLElement,
    private selection: Selection,
    private toScreen: ScreenProjector,
    options: SelectionFrameOptions,
  ) {
    this.overlay = svg('svg', { class: 'handwriting-selection', 'aria-hidden': 'true' })
    const style = this.overlay.style
    style.position = 'absolute'
    style.left = '0'
    style.top = '0'
    style.width = '100%'
    style.height = '100%'
    style.pointerEvents = 'none'
    style.overflow = 'visible'
    style.zIndex = '1'
    const line = { fill: 'none', stroke: '#1a73e8', 'stroke-width': '1.5' }
    this.lasso = svg('polyline', { ...line, 'stroke-dasharray': '4 4', 'stroke-linejoin': 'round' })
    this.outline = svg('polygon', { ...line, 'stroke-dasharray': '6 4' })
    this.stem = svg('line', line)
    const handle = { fill: '#fff', stroke: '#1a73e8', 'stroke-width': '1.5' }
    this.handles = [0, 1, 2, 3].map(() =>
      svg('rect', { ...handle, width: `${HANDLE_SIZE}`, height: `${HANDLE_SIZE}`, class: 'handwriting-selection-scale' }),
    )
    this.rotate = svg('circle', { ...handle, r: `${HANDLE_SIZE / 2}`, class: 'handwriting-selection-rotate' })
    appendChildren(this.overlay, this.lasso, this.outline, this.stem, ...this.handles, this.rotate)

    this.bar = document.createElement('div')
    this.bar.className = 'handwriting-selection-bar'
    const bar = this.bar.style
    bar.position = 'absolute'
    bar.left = '0'
    bar.top = '0'
    bar.background = '#fff'
    bar.borderRadius = '6px'
    bar.boxShadow = '0 1px 4px rgba(0, 0, 0, 0.3)'
    bar.zIndex = '2'
    appendChildren(this.bar, barButton('Delete', options.onDelete), barButton('Duplicate', options.onDuplicate))
    if (options.onExport) appendChildren(this.bar, barButton('Export', options.onExport))
    // The bar's clicks stay off the map
    this.bar.addEventListener('pointerdown', (e) => e.stopPropagation())

    appendChildren(container, this.overlay, this.bar)
    this.unsubscribe = selection.subscribe(() => this.update())
    this.showLasso(null)
    this.update()
  }

  /** Puts the frame where the selection is on screen now; call after the map moves */
  update(): void {
    const corners = this.selection.frame()
    const shown = corners !== null
    for (const node of [this.outline, this.stem, this.rotate, ...this.handles]) node.style.display = shown ? '' : 'none'
    this.bar.style.display = shown ? 'flex' : 'none'
    if (!corners) return
    const client = corners.map(this.toScreen)
    const box = this.container.getBoundingClientRect()
    const local = client.map(([x, y]): [number, number] => [x - box.left, y - box.top])
    this.outline.setAttribute('points', local.map((p) => p.join(',')).join(' '))
    local.forEach(([x, y], i) => {
      this.handles[i].setAttribute('x', `${x - HANDLE_SIZE / 2}`)
      this.handles[i].setAttribute('y', `${y - HANDLE_SIZE / 2}`)
    })
    const [rx, ry] = rotateHandle(local)
    this.rotate.setAttribute('cx', `${rx}`)
    this.rotate.setAttribute('cy', `${ry}`)
    this.stem.setAttribute('x1', `${(local[0][0] + local[1][0]) / 2}`)
    this.stem.setAttribute('y1', `${(local[0][1] + local[1][1]) / 2}`)
    this.stem.setAttribute('x2', `${rx}`)
    this.stem.setAttribute('y2', `${ry}`)
    const centerX = local.reduce((sum, [x]) => sum + x, 0) / 4
    const bottom = Math.max(...local.map(([, y]) => y))
    this.bar.style.transform = `translate(calc(${centerX}px - 50%), ${bottom + BAR_GAP}px)`
  }

  /** Draws the lasso through these client positions, or hides it */
  showLasso(points: Point[] | null): void {
    if (!points) {
      this.lasso.style.display = 'none'
      return
    }
    const box = this.container.getBoundingClientRect()
    this.lasso.setAttribute('points', points.map(([x, y]) => `${x - box.left},${y - box.top}`).join(' '))
    this.lasso.style.display = ''
  }

  destroy(): void {
    this.unsubscribe()
    this.overlay.remove()
    this.bar.remove()
  }
}
