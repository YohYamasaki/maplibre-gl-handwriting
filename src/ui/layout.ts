// Where the toolbar and its popover go inside the map container. Pure geometry in CSS px, tested without a browser
import type { ToolbarEdge } from '../pens'

export type Size = { width: number; height: number }
export type Rect = { left: number; top: number; width: number; height: number }
export type Position = { left: number; top: number }

/** Gap between the toolbar and the side of the map it sits on */
export const TOOLBAR_MARGIN = 8

/** Whether the toolbar is laid out as a row (top and bottom) or a column (left and right) */
export function isHorizontal(edge: ToolbarEdge): boolean {
  return edge === 'top' || edge === 'bottom'
}

/** The side of the container closest to a point, e.g. where a dragged toolbar's center was dropped */
export function nearestEdge(x: number, y: number, container: Size): ToolbarEdge {
  const distances: [ToolbarEdge, number][] = [
    ['top', y],
    ['bottom', container.height - y],
    ['left', x],
    ['right', container.width - x],
  ]
  return distances.reduce((best, next) => (next[1] < best[1] ? next : best))[0]
}

/**
 * The offset (0 to 1) along `edge` that puts the center of a toolbar `length` px long at the point's position
 * along that edge, as far as the toolbar fits
 */
export function edgeOffset(edge: ToolbarEdge, x: number, y: number, container: Size, length: number): number {
  const along = isHorizontal(edge) ? x : y
  const span = (isHorizontal(edge) ? container.width : container.height) - 2 * TOOLBAR_MARGIN - length
  if (span <= 0) return 0.5
  return Math.min(1, Math.max(0, (along - TOOLBAR_MARGIN - length / 2) / span))
}

/** Top-left corner of the toolbar on `edge` at `offset`. A toolbar longer than the edge starts at the margin */
export function toolbarPosition(edge: ToolbarEdge, offset: number, container: Size, bar: Size): Position {
  const along = (space: number, length: number): number =>
    TOOLBAR_MARGIN + Math.max(0, space - 2 * TOOLBAR_MARGIN - length) * offset
  switch (edge) {
    case 'top':
      return { left: along(container.width, bar.width), top: TOOLBAR_MARGIN }
    case 'bottom':
      return { left: along(container.width, bar.width), top: container.height - TOOLBAR_MARGIN - bar.height }
    case 'left':
      return { left: TOOLBAR_MARGIN, top: along(container.height, bar.height) }
    case 'right':
      return { left: container.width - TOOLBAR_MARGIN - bar.width, top: along(container.height, bar.height) }
  }
}

/** Gap between the toolbar and a button's tooltip */
export const TOOLTIP_GAP = 6

/**
 * Top-left corner of a popover opened from `anchor` (a toolbar button): on the map side of the toolbar, centered
 * on the button, and kept inside the container
 */
export function popoverPosition(edge: ToolbarEdge, anchor: Rect, bar: Rect, popover: Size, container: Size): Position {
  return besideBar(edge, anchor, bar, popover, container, TOOLBAR_MARGIN)
}

/**
 * Top-left corner of the tooltip of `anchor` (a toolbar button): on the map side of the toolbar, TOOLTIP_GAP away,
 * centered on the button, and kept inside the container
 */
export function tooltipPosition(edge: ToolbarEdge, anchor: Rect, bar: Rect, tooltip: Size, container: Size): Position {
  return besideBar(edge, anchor, bar, tooltip, container, TOOLTIP_GAP)
}

/** A box `gap` px from the toolbar on its map side, centered on `anchor` and kept inside the container */
function besideBar(edge: ToolbarEdge, anchor: Rect, bar: Rect, box: Size, container: Size, gap: number): Position {
  const clamp = (value: number, length: number, space: number): number =>
    Math.max(TOOLBAR_MARGIN, Math.min(value, space - TOOLBAR_MARGIN - length))
  const centerX = clamp(anchor.left + anchor.width / 2 - box.width / 2, box.width, container.width)
  const centerY = clamp(anchor.top + anchor.height / 2 - box.height / 2, box.height, container.height)
  switch (edge) {
    case 'top':
      return { left: centerX, top: bar.top + bar.height + gap }
    case 'bottom':
      return { left: centerX, top: bar.top - gap - box.height }
    case 'left':
      return { left: bar.left + bar.width + gap, top: centerY }
    case 'right':
      return { left: bar.left - gap - box.width, top: centerY }
  }
}

/**
 * The scroll offset that shows an item at `start` and `length` px long in a view `view` px long scrolled to
 * `scroll`: unchanged when the item is in view, else the nearest one that puts the item at the view's edge
 */
export function scrollToShow(start: number, length: number, scroll: number, view: number): number {
  if (start < scroll) return start
  if (start + length > scroll + view) return start + length - view
  return scroll
}
