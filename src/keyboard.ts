import type { Tool } from './createHandwriting'
import type { PenSettings } from './pens'

// The keyboard shortcuts of a handle (decisions 0081, 0082). createHandwriting gives KeyboardShortcuts the window to
// listen on while they are enabled; it looks at nothing of the DOM beyond the event's fields

/** The fields of a KeyboardEvent the shortcuts look at */
export type KeyEventLike = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat: boolean
  defaultPrevented: boolean
  target: EventTarget | null
  preventDefault(): void
}

/** What the shortcuts do, given by the handle */
export type KeyboardActions = {
  getTool(): Tool
  setTool(tool: Tool): void
  /** Selects the hand while Space is held, keeping the lasso's selection */
  holdHand(): void
  undo(): void
  redo(): void
  hasSelection(): boolean
  deleteSelection(): void
  duplicateSelection(): void
  clearSelection(): void
  /** Changes the current pen's width, or the eraser's radius, by `delta` CSS px; the settings clamp it */
  changeSize(delta: number): void
  /** Shows the shortcut list, or closes it when it is open */
  toggleList(): void
  /** Closes the shortcut list. Returns whether it was open */
  closeList(): boolean
  /** Whether `target` is inside the map's container */
  isInMap(target: EventTarget | null): boolean
}

/** The tool each letter selects, compared with `e.key` lowercased (decision 0081) */
export const TOOL_KEYS: readonly { key: string; tool: Tool }[] = [
  { key: 'h', tool: null },
  { key: 'p', tool: 'pen' },
  { key: 'm', tool: 'highlighter' },
  { key: 'e', tool: 'eraser' },
  { key: 'l', tool: 'lasso' },
  // The laser pointer (decision 0079); it has no number, 1 to 5 stay the first five tools
  { key: 'k', tool: 'laser' },
]

/** The tools in the toolbar's order, selected by 1 to 5 */
export const TOOL_ORDER: readonly Tool[] = [null, 'pen', 'highlighter', 'eraser', 'lasso']

/** The letter that selects `tool`, uppercase, for the tooltips and the shortcut list */
export function toolKey(tool: Tool): string {
  return (TOOL_KEYS.find((entry) => entry.tool === tool)?.key ?? '').toUpperCase()
}

/** Whether this is a Mac or an iPad/iPhone, where the shortcuts use Cmd */
export function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}

/** The name of the shortcut modifier: ⌘ on Apple platforms, Ctrl elsewhere */
export function modifierLabel(apple = isApplePlatform()): string {
  return apple ? '⌘' : 'Ctrl+'
}

/** The rows of the shortcut list: the keys as shown, and what they do */
export function shortcutRows(apple = isApplePlatform()): [string, string][] {
  const mod = modifierLabel(apple)
  const shift = apple ? '⇧' : 'Shift+'
  return [
    [`${toolKey(null)} / 1`, 'Move map'],
    [`${toolKey('pen')} / 2`, 'Pen'],
    [`${toolKey('highlighter')} / 3`, 'Highlighter'],
    [`${toolKey('eraser')} / 4`, 'Eraser'],
    [`${toolKey('lasso')} / 5`, 'Lasso'],
    [toolKey('laser'), 'Laser pointer'],
    ['Space (hold)', 'Move map while held'],
    [`${mod}Z`, 'Undo'],
    [apple ? `${shift}${mod}Z` : `${shift}${mod}Z / Ctrl+Y`, 'Redo'],
    ['Delete / Backspace', 'Delete the selection'],
    [`${mod}D`, 'Duplicate the selection'],
    ['Esc', 'Close the popover or this list, or clear the selection'],
    ['[ / ]', 'Thinner / thicker pen, smaller / larger eraser'],
    ['?', 'Show or hide this list'],
  ]
}

/**
 * What [ and ] do: changes the width of the selected pen or highlighter, or the eraser's radius, by `delta` CSS px.
 * The settings clamp it to its range; other tools have no size
 */
export function changeToolSize(settings: PenSettings, tool: Tool, delta: number): void {
  if (tool === 'pen' || tool === 'highlighter') settings.setPen(tool, { width: settings.pen(tool).width + delta })
  else if (tool === 'eraser') settings.setEraser({ radius: settings.eraserRadius() + delta })
}

/** Whether `target` is a field the user types in, where no shortcut applies */
function isTyping(target: EventTarget | null): boolean {
  const node = target as { isContentEditable?: boolean; tagName?: string } | null
  if (!node) return false
  return node.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName ?? '')
}

/**
 * Whether a character key is taken: not with Ctrl or Cmd, which belong to the browser's and the system's own
 * shortcuts, except Ctrl with Alt, which is AltGr on Windows layouts that type [ ] that way. Shift is not looked at
 */
function isPlain(e: KeyEventLike): boolean {
  if (e.metaKey) return false
  return !e.ctrlKey || e.altKey
}

/** Turns the key events on `target` (the window) into the actions of a handle while enabled (decision 0081) */
export class KeyboardShortcuts {
  // The tool that Space put away, given back when Space is released
  private spaceTool: Tool = null
  // Whether the Space being held was taken, so its keyup is taken too and does not press a focused button
  private spaceDown = false
  private on = false

  constructor(
    private actions: KeyboardActions,
    private target: EventTarget,
  ) {}

  get enabled(): boolean {
    return this.on
  }

  /** Starts or stops listening. Stopping gives back the tool Space holds and closes the shortcut list */
  setEnabled(enabled: boolean): void {
    if (enabled === this.on) return
    this.on = enabled
    if (enabled) {
      this.target.addEventListener('keydown', this.onKeydown)
      this.target.addEventListener('keyup', this.onKeyup)
      this.target.addEventListener('blur', this.onBlur)
      return
    }
    this.target.removeEventListener('keydown', this.onKeydown)
    this.target.removeEventListener('keyup', this.onKeyup)
    this.target.removeEventListener('blur', this.onBlur)
    this.restore()
    this.actions.closeList()
  }

  private onKeydown = (e: Event): void => this.keydown(e as unknown as KeyEventLike)
  private onKeyup = (e: Event): void => this.keyup(e as unknown as KeyEventLike)
  private onBlur = (): void => this.restore()

  keydown(e: KeyEventLike): void {
    if (e.defaultPrevented || isTyping(e.target)) return
    const a = this.actions
    if (e.key === 'Escape') {
      if (a.closeList()) e.preventDefault()
      else if (a.hasSelection()) {
        a.clearSelection()
        e.preventDefault()
      }
      return
    }
    const mod = (e.metaKey || e.ctrlKey) && !e.altKey
    const key = e.key.toLowerCase()
    if (mod) {
      if (key === 'z' && e.shiftKey) a.redo()
      else if (key === 'z') a.undo()
      else if (key === 'y' && e.ctrlKey) a.redo()
      // Held down, Cmd+D makes one copy, not one per auto-repeat; undo and redo repeat, as elsewhere
      else if (key === 'd' && a.hasSelection()) {
        if (!e.repeat) a.duplicateSelection()
      }
      else return
      e.preventDefault()
      return
    }
    if (!isPlain(e)) return
    if (e.key === ' ') {
      this.onSpaceDown(e)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (!a.hasSelection()) return
      e.preventDefault()
      a.deleteSelection()
      return
    }
    if (e.key === '[' || e.key === ']') {
      e.preventDefault()
      a.changeSize(e.key === '[' ? -1 : 1)
      return
    }
    if (e.key === '?') {
      e.preventDefault()
      if (!e.repeat) a.toggleList()
      return
    }
    const digit = Number(e.key)
    const tool = e.key.length === 1 && digit >= 1 && digit <= TOOL_ORDER.length
      ? { tool: TOOL_ORDER[digit - 1] }
      : TOOL_KEYS.find((entry) => entry.key === key)
    if (!tool) return
    e.preventDefault()
    if (e.repeat) return
    this.spaceTool = null
    a.setTool(tool.tool)
  }

  keyup(e: KeyEventLike): void {
    if (e.key !== ' ' || !this.spaceDown) return
    this.spaceDown = false
    e.preventDefault()
    this.restore()
  }

  /** Gives back the tool Space put away, e.g. when the window loses focus while Space is held */
  restore(): void {
    this.spaceDown = false
    const tool = this.spaceTool
    this.spaceTool = null
    if (tool !== null && this.actions.getTool() === null) this.actions.setTool(tool)
  }

  private onSpaceDown(e: KeyEventLike): void {
    const target = e.target as { tagName?: string } | null
    // Space on a button elsewhere on the page presses that button
    if (target?.tagName === 'BUTTON' && !this.actions.isInMap(e.target)) return
    e.preventDefault()
    this.spaceDown = true
    if (e.repeat || this.actions.getTool() === null || this.spaceTool !== null) return
    this.spaceTool = this.actions.getTool()
    this.actions.holdHand()
  }
}
