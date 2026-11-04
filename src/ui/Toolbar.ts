import type { IControl, Map as MapLibreMap } from 'maplibre-gl'
import type { Handwriting, HandwritingEventMap, HandwritingListener, Tool } from '../createHandwriting'
import type { PenTool } from '../pens'
import { isApplePlatform, modifierLabel, TOOL_ORDER, toolKey } from '../keyboard'
import { appendChildren } from './dom'
import { icon, type IconName } from './icons'
import {
  edgeOffset,
  isHorizontal,
  nearestEdge,
  popoverPosition,
  scrollToShow,
  TOOLBAR_MARGIN,
  toolbarPosition,
  tooltipPosition,
  type Rect,
} from './layout'
import { eraserPopover, penPopover, type PopoverContent } from './popover'
import { Tooltip, type TooltipText } from './tooltip'

type ToolButton = { tool: Tool; label: string; icon: IconName; description: string }

/** What a popover belongs to: a tool's settings */
type PopoverOwner = Tool

// The partial eraser is a mode in the eraser's popover. The order is the keys 1 to 5's
// (keyboard.ts TOOL_ORDER), also when the handle offers only some of the tools; the descriptions are the tooltips'
const TOOLS: ToolButton[] = [
  { tool: null, label: 'Move map', icon: 'hand', description: 'Drag to pan; pinch or scroll to zoom' },
  { tool: 'pen', label: 'Pen', icon: 'pen', description: 'Draw. Press again for color and width' },
  {
    tool: 'highlighter',
    label: 'Highlighter',
    icon: 'highlighter',
    description: 'Draw translucent lines. Press again for color and width',
  },
  { tool: 'eraser', label: 'Eraser', icon: 'eraser', description: 'Erase lines you touch. Press again for size' },
  {
    tool: 'lasso',
    label: 'Lasso',
    icon: 'lasso',
    description: 'Circle lines to select them, then move, scale or rotate',
  },
  // The laser pointer has no settings, like the lasso
  { tool: 'laser', label: 'Laser', icon: 'laser', description: 'Point at the map; the line fades and is not saved' },
]

/** The descriptions of the buttons that are not tools, by their labels */
const OTHER_DESCRIPTIONS: Record<string, string> = {
  Undo: 'Undo your last change',
  Redo: 'Redo what you undid',
  'Draw with pen only': 'Touch moves the map, and only a pen draws',
  'Move toolbar': 'Drag to another side of the map',
  'Collapse toolbar': 'Show the selected tool only',
  'Expand toolbar': 'Show every tool',
}

// A drag of the grip shorter than this is a click, and leaves the toolbar where it is
const DRAG_THRESHOLD = 4

function isPenTool(tool: Tool): tool is PenTool {
  return tool === 'pen' || tool === 'highlighter'
}

function button(className: string, label: string, name: IconName): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.setAttribute('aria-label', label)
  appendChildren(node, icon(name))
  return node
}

function rectIn(node: Element, container: Element): Rect {
  const r = node.getBoundingClientRect()
  const c = container.getBoundingClientRect()
  return { left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height }
}

/**
 * A floating toolbar for a handle: the hand and the handle's tools (getTools), undo and redo, per tool a popover with its
 * settings (press the selected tool again), and a toggle for pen-only input. It can be dragged to
 * any side of the map and collapsed; where it is goes to the handle's settings (setToolbar), so it is saved and
 * restored with the pens.
 *
 * `map.addControl(new HandwritingToolbar(handle))`. The toolbar floats over the map wherever its placement says,
 * whatever corner it is added to. It uses only the handle's functions and events; remove it with
 * map.removeControl before destroying the handle. Its styles are the package's `style.css` (ui/toolbar.css here), loaded by the user
 */
export class HandwritingToolbar implements IControl {
  private map: MapLibreMap | null = null
  // What MapLibre puts in its corner: the toolbar itself floats over the map container instead
  private anchor: HTMLElement | null = null
  private bar: HTMLElement | null = null
  // The part of the bar that scrolls when the bar is longer than the map
  private tools: HTMLElement | null = null
  private toolButtons = new Map<Tool, HTMLButtonElement>()
  private undoButton: HTMLButtonElement | null = null
  private redoButton: HTMLButtonElement | null = null
  private penOnlyButton: HTMLButtonElement | null = null
  private popover: HTMLElement | null = null
  private popoverContent: PopoverContent | null = null
  // null while no popover is open (the hand has none)
  private popoverTool: PopoverOwner = null
  // Where the tools were scrolled when the popover opened
  private popoverScroll = { left: 0, top: 0 }
  private tooltip: Tooltip | null = null
  private cleanups: (() => void)[] = []

  constructor(private handle: Handwriting) {}

  onAdd(map: MapLibreMap): HTMLElement {
    this.map = map
    const container = map.getContainer()
    const bar = document.createElement('div')
    bar.className = 'handwriting-toolbar'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', 'Handwriting tools')
    this.bar = bar

    const grip = button('handwriting-toolbar-grip', 'Move toolbar', 'grip')
    const tools = document.createElement('div')
    tools.className = 'handwriting-toolbar-tools'
    this.tools = tools
    // The hand and the tools the handle offers
    const offered = this.handle.getTools()
    for (const entry of TOOLS) {
      if (entry.tool !== null && !offered.includes(entry.tool)) continue
      const node = button('handwriting-toolbar-button', entry.label, entry.icon)
      node.dataset.tool = entry.tool ?? 'hand'
      node.addEventListener('click', () => this.onToolClick(entry.tool))
      this.toolButtons.set(entry.tool, node)
      appendChildren(tools, node)
    }
    const separator = document.createElement('span')
    separator.className = 'handwriting-toolbar-separator'
    this.undoButton = button('handwriting-toolbar-button handwriting-toolbar-history', 'Undo', 'undo')
    this.undoButton.addEventListener('click', () => this.handle.undo())
    this.redoButton = button('handwriting-toolbar-button handwriting-toolbar-history', 'Redo', 'redo')
    this.redoButton.addEventListener('click', () => this.handle.redo())
    this.penOnlyButton = button(
      'handwriting-toolbar-button handwriting-toolbar-pen-only',
      'Draw with pen only',
      'pen-tool',
    )
    this.penOnlyButton.addEventListener('click', () => this.handle.setPenOnly(!this.handle.getSettings().penOnly))
    appendChildren(tools, separator, this.undoButton, this.redoButton)
    // Pen-only input keeps touch from drawing: a toggle only where there is touch
    if (navigator.maxTouchPoints > 0) appendChildren(tools, this.penOnlyButton)
    const collapse = button('handwriting-toolbar-collapse', 'Collapse toolbar', 'collapse')
    collapse.addEventListener('click', () =>
      this.handle.setToolbar({ collapsed: !this.handle.getSettings().toolbar.collapsed }),
    )
    appendChildren(bar, grip, tools, collapse)

    const popover = document.createElement('div')
    popover.className = 'handwriting-popover'
    popover.setAttribute('role', 'dialog')
    popover.hidden = true
    this.popover = popover

    appendChildren(container, bar, popover)
    this.tooltip = new Tooltip(
      container,
      (button, size) => {
        const edge = this.handle.getSettings().toolbar.edge
        const box = { width: container.clientWidth, height: container.clientHeight }
        return tooltipPosition(edge, rectIn(button, container), rectIn(bar, container), size, box)
      },
      (button) => this.tooltipText(button),
    )
    for (const node of bar.querySelectorAll('button')) this.tooltip.attach(node)
    this.listenGrip(grip)
    this.listenTools(tools)
    this.listenHandle()
    this.listenDocument()
    const onResize = (): void => this.layout()
    map.on('resize', onResize)
    this.cleanups.push(() => map.off('resize', onResize))

    this.updateTools()
    this.updateHistory(this.handle.canUndo(), this.handle.canRedo())
    this.updatePens()
    this.updatePenOnly()
    this.layout()

    this.anchor = document.createElement('div')
    this.anchor.className = 'handwriting-toolbar-anchor'
    this.anchor.hidden = true
    return this.anchor
  }

  onRemove(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup()
    this.tooltip?.destroy()
    this.tooltip = null
    this.closePopover()
    this.bar?.remove()
    this.popover?.remove()
    this.anchor?.remove()
    this.bar = this.tools = this.popover = this.anchor = this.undoButton = this.redoButton = this.penOnlyButton = null
    this.popoverContent = null
    this.popoverTool = null
    this.toolButtons.clear()
    this.map = null
  }

  /** Adds a DOM listener that onRemove takes off again */
  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    listener: (event: E) => void,
    capture = false,
  ): void {
    const fn = listener as EventListener
    target.addEventListener(type, fn, capture)
    this.cleanups.push(() => target.removeEventListener(type, fn, capture))
  }

  private onHandle<K extends keyof HandwritingEventMap>(type: K, listener: HandwritingListener<K>): void {
    this.handle.on(type, listener)
    this.cleanups.push(() => this.handle.off(type, listener))
  }

  private listenHandle(): void {
    this.onHandle('toolchange', () => {
      this.updateTools()
      // A tool's popover belongs to that tool
      if (this.popoverTool !== this.handle.getTool()) this.closePopover()
      this.scrollToTool()
    })
    this.onHandle('history', (e) => this.updateHistory(e.canUndo, e.canRedo))
    this.onHandle('settingschange', () => {
      this.updatePens()
      this.updatePenOnly()
      this.popoverContent?.update()
      this.layout()
    })
  }

  private listenTools(tools: HTMLElement): void {
    // The popover is placed next to its button, which scrolling moves away. A scroll event comes a frame after the
    // scroll, so one made before the popover opened (a tap focusing a half hidden button scrolls it in, and the
    // tap's click then opens the popover) is told apart by the position the popover opened at
    this.listen(tools, 'scroll', () => {
      if (tools.scrollLeft === this.popoverScroll.left && tools.scrollTop === this.popoverScroll.top) return
      this.closePopover()
    })
    // A vertical wheel scrolls a horizontal bar sideways; passive: false so that the page does not scroll too
    const onWheel = (e: WheelEvent): void => {
      if (this.bar?.dataset.orientation !== 'horizontal' || e.deltaX !== 0 || e.deltaY === 0) return
      tools.scrollLeft += e.deltaY
      e.preventDefault()
    }
    tools.addEventListener('wheel', onWheel, { passive: false })
    this.cleanups.push(() => tools.removeEventListener('wheel', onWheel))
  }

  /** Scrolls the tools so that the selected tool's button is in view, scrolling nothing else on the page */
  private scrollToTool(): void {
    const node = this.toolButtons.get(this.handle.getTool())
    if (!this.tools || !node) return
    if (this.bar?.dataset.orientation === 'vertical') {
      this.tools.scrollTop = scrollToShow(
        node.offsetTop,
        node.offsetHeight,
        this.tools.scrollTop,
        this.tools.clientHeight,
      )
    } else {
      this.tools.scrollLeft = scrollToShow(
        node.offsetLeft,
        node.offsetWidth,
        this.tools.scrollLeft,
        this.tools.clientWidth,
      )
    }
  }

  private listenDocument(): void {
    // A press outside the toolbar and the popover closes the popover; the press still does what it does there
    this.listen(
      document,
      'pointerdown',
      (e: PointerEvent) => {
        const target = e.target as Node | null
        if (this.popover?.hidden || !target) return
        if (this.popover?.contains(target) || this.bar?.contains(target)) return
        this.closePopover()
      },
      true,
    )
    // Esc closes the popover. The handle's shortcuts listen on the window, after the document, and leave an Esc
    // prevented here alone, so the selection stays
    this.listen(document, 'keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !this.popover || this.popover.hidden) return
      e.preventDefault()
      this.closePopover()
    })
  }

  /** What the tooltip of `button` says; the keys only while the handle's shortcuts are on */
  private tooltipText(button: HTMLElement): TooltipText | null {
    const label = button.getAttribute('aria-label')
    if (!label) return null
    const keyboard = this.handle.isKeyboardEnabled()
    const entry = TOOLS.find((t) => this.toolButtons.get(t.tool) === button)
    if (entry) {
      // The laser pointer has its letter only: 1 to 5 are the first five tools
      const digit = TOOL_ORDER.indexOf(entry.tool) + 1
      const keys = digit > 0 ? `${toolKey(entry.tool)} / ${digit}` : toolKey(entry.tool)
      return { name: label, description: entry.description, keys: keyboard ? keys : undefined }
    }
    const description = OTHER_DESCRIPTIONS[label] ?? ''
    if (!keyboard) return { name: label, description }
    const mod = modifierLabel()
    if (button === this.undoButton) return { name: label, description, keys: `${mod}Z` }
    if (button === this.redoButton)
      return { name: label, description, keys: `${isApplePlatform() ? '⇧' : 'Shift+'}${mod}Z` }
    return { name: label, description }
  }

  private onToolClick(tool: Tool): void {
    if (this.handle.getTool() !== tool) {
      this.handle.setTool(tool)
      return
    }
    // The selected tool pressed again opens or closes its settings
    if (this.popover && !this.popover.hidden) this.closePopover()
    else this.openPopover(tool)
  }

  /** The button a popover opens from */
  private buttonOf(owner: PopoverOwner): HTMLButtonElement | null {
    return this.toolButtons.get(owner) ?? null
  }

  private openPopover(owner: PopoverOwner): void {
    if (!this.popover) return
    let content: PopoverContent
    if (isPenTool(owner)) content = penPopover(this.handle, owner)
    else if (owner === 'eraser') content = eraserPopover(this.handle)
    else return
    const label = `${this.toolButtons.get(owner)?.getAttribute('aria-label')} settings`
    content.update()
    this.popover.replaceChildren(content.element)
    this.popover.setAttribute('aria-label', label)
    this.popover.hidden = false
    this.popoverContent = content
    this.popoverTool = owner
    this.popoverScroll = { left: this.tools?.scrollLeft ?? 0, top: this.tools?.scrollTop ?? 0 }
    this.buttonOf(owner)?.setAttribute('aria-expanded', 'true')
    this.layout()
  }

  private closePopover(): void {
    if (!this.popover || this.popover.hidden) return
    this.popover.hidden = true
    this.popoverContent?.destroy()
    this.popover.replaceChildren()
    this.buttonOf(this.popoverTool)?.setAttribute('aria-expanded', 'false')
    this.popoverContent = null
    this.popoverTool = null
  }

  /** Dragging the grip moves the toolbar with the pointer; on release it goes to the nearest side of the map */
  private listenGrip(grip: HTMLButtonElement): void {
    let drag: { id: number; startX: number; startY: number; dx: number; dy: number; moved: boolean } | null = null
    this.listen(grip, 'pointerdown', (e: PointerEvent) => {
      if (!this.bar || !this.map || e.button !== 0) return
      const bar = rectIn(this.bar, this.map.getContainer())
      const container = this.map.getContainer().getBoundingClientRect()
      drag = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        dx: e.clientX - container.left - bar.left,
        dy: e.clientY - container.top - bar.top,
        moved: false,
      }
      grip.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    this.listen(grip, 'pointermove', (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id || !this.bar || !this.map) return
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD) return
      if (!drag.moved) {
        drag.moved = true
        this.closePopover()
        this.tooltip?.hide(false)
        this.bar.classList.add('handwriting-toolbar-dragging')
      }
      const container = this.map.getContainer().getBoundingClientRect()
      this.bar.style.left = `${e.clientX - container.left - drag.dx}px`
      this.bar.style.top = `${e.clientY - container.top - drag.dy}px`
    })
    const end = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return
      const moved = drag.moved
      drag = null
      if (!this.bar || !this.map) return
      this.bar.classList.remove('handwriting-toolbar-dragging')
      if (!moved) return
      const container = this.map.getContainer()
      const size = { width: container.clientWidth, height: container.clientHeight }
      const bar = rectIn(this.bar, container)
      const x = bar.left + bar.width / 2
      const y = bar.top + bar.height / 2
      const edge = nearestEdge(x, y, size)
      // The toolbar's length along whichever side it lands on
      const length = Math.max(bar.width, bar.height)
      this.handle.setToolbar({ edge, offset: edgeOffset(edge, x, y, size, length) })
      // Placed again even when the setting did not change, since the drag moved it
      this.layout()
    }
    this.listen(grip, 'pointerup', end)
    this.listen(grip, 'pointercancel', end)
  }

  private updateTools(): void {
    const tool = this.handle.getTool()
    for (const [entry, node] of this.toolButtons) {
      node.setAttribute('aria-pressed', String(entry === tool))
      if (isPenTool(entry) || entry === 'eraser') {
        node.setAttribute('aria-haspopup', 'dialog')
        node.setAttribute('aria-expanded', String(entry === this.popoverTool))
      }
    }
  }

  private updateHistory(canUndo: boolean, canRedo: boolean): void {
    if (this.undoButton) this.undoButton.disabled = !canUndo
    if (this.redoButton) this.redoButton.disabled = !canRedo
  }

  /** The pen-only toggle shows whether pen-only input is on */
  private updatePenOnly(): void {
    this.penOnlyButton?.setAttribute('aria-pressed', String(this.handle.getSettings().penOnly))
  }

  /** The pen buttons' tips take their pens' colors */
  private updatePens(): void {
    for (const tool of ['pen', 'highlighter'] as const) {
      this.toolButtons.get(tool)?.style.setProperty('--handwriting-pen-color', this.handle.getPen(tool).color)
    }
  }

  /** Puts the toolbar where its settings say and the open popover next to it */
  private layout(): void {
    if (!this.bar || !this.map || this.bar.classList.contains('handwriting-toolbar-dragging')) return
    const { edge, offset, collapsed } = this.handle.getSettings().toolbar
    this.bar.dataset.edge = edge
    this.bar.dataset.orientation = isHorizontal(edge) ? 'horizontal' : 'vertical'
    this.bar.dataset.collapsed = String(collapsed)
    const collapse = this.bar.querySelector('.handwriting-toolbar-collapse')
    collapse?.setAttribute('aria-label', collapsed ? 'Expand toolbar' : 'Collapse toolbar')
    collapse?.setAttribute('aria-expanded', String(!collapsed))
    const container = this.map.getContainer()
    const size = { width: container.clientWidth, height: container.clientHeight }
    // A bar longer than the map scrolls its tools instead of going off the map
    const horizontal = isHorizontal(edge)
    this.bar.style.maxWidth = horizontal ? `${size.width - 2 * TOOLBAR_MARGIN}px` : ''
    this.bar.style.maxHeight = horizontal ? '' : `${size.height - 2 * TOOLBAR_MARGIN}px`
    const position = toolbarPosition(edge, offset, size, { width: this.bar.offsetWidth, height: this.bar.offsetHeight })
    this.bar.style.left = `${position.left}px`
    this.bar.style.top = `${position.top}px`

    const anchor = this.buttonOf(this.popoverTool)
    if (!this.popover || this.popover.hidden || !anchor) return
    const at = popoverPosition(
      edge,
      rectIn(anchor, container),
      rectIn(this.bar, container),
      { width: this.popover.offsetWidth, height: this.popover.offsetHeight },
      size,
    )
    this.popover.style.left = `${at.left}px`
    this.popover.style.top = `${at.top}px`
  }
}
