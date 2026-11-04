// The settings shown when the selected tool's button is pressed again: a pen's width, color, opacity and pressure, or
// the eraser's mode and size. They read and change the settings only through the handle
import type { Handwriting } from '../createHandwriting'
import { experimentalOf } from '../experimental'
import {
  MAX_ERASER_RADIUS,
  MAX_WIDTH,
  MIN_ERASER_RADIUS,
  MIN_OPACITY,
  MIN_WIDTH,
  type EraserMode,
  type PenTool,
} from '../pens'
import { appendChildren } from './dom'
import { icon } from './icons'

/**
 * The content of a popover: `update` redraws it from the handle's current settings; `destroy` cancels what is
 * pending (a long press), once the popover is closed
 */
export type PopoverContent = { element: HTMLElement; update(): void; destroy(): void }

/** How long a palette color is held down before the pen's color is stored in its place */
export const LONG_PRESS_MS = 500

const SVG_NS = 'http://www.w3.org/2000/svg'
// The preview line is drawn at the pen's width, up to what fits in it
const PREVIEW_MAX_WIDTH = 40

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  return node
}

type Slider = { row: HTMLElement; input: HTMLInputElement; set(value: number): void }

/** A labeled range input with its value shown next to it */
function slider(
  label: string,
  range: { min: number; max: number; step: number },
  format: (value: number) => string,
  onInput: (value: number) => void,
): Slider {
  const row = element('label', 'handwriting-popover-row')
  const name = element('span', 'handwriting-popover-label')
  name.textContent = label
  const input = element('input', 'handwriting-popover-slider')
  input.type = 'range'
  input.min = String(range.min)
  input.max = String(range.max)
  input.step = String(range.step)
  const output = element('output', 'handwriting-popover-value')
  input.addEventListener('input', () => onInput(Number(input.value)))
  appendChildren(row, name, input, output)
  return {
    row,
    input,
    set(value) {
      // Leaves the input alone while it is being dragged to the same value, so the thumb does not jump
      if (Number(input.value) !== value) input.value = String(value)
      output.textContent = format(value)
    },
  }
}

/** A checkbox with a label and a hint under it */
function toggle(
  label: string,
  hint: string,
  onChange: (checked: boolean) => void,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = element('label', 'handwriting-popover-toggle')
  const input = element('input', 'handwriting-popover-checkbox')
  input.type = 'checkbox'
  input.addEventListener('change', () => onChange(input.checked))
  const text = element('span', 'handwriting-popover-toggle-text')
  const name = element('span', 'handwriting-popover-label')
  name.textContent = label
  const note = element('span', 'handwriting-popover-hint')
  note.textContent = hint
  appendChildren(text, name, note)
  appendChildren(row, input, text)
  return { row, input }
}

/**
 * Width, palette, other color, opacity and pen pressure of one pen. A palette color sets the pen's color; holding it down for
 * LONG_PRESS_MS stores the pen's current color in that slot instead (e.g. one just chosen with the picker)
 */
export function penPopover(handle: Handwriting, tool: PenTool): PopoverContent {
  const root = element('div', 'handwriting-popover-content')
  root.dataset.tool = tool

  const preview = document.createElementNS(SVG_NS, 'svg')
  preview.classList.add('handwriting-popover-preview')
  preview.setAttribute('viewBox', '0 0 200 56')
  preview.setAttribute('aria-hidden', 'true')
  const line = document.createElementNS(SVG_NS, 'path')
  line.setAttribute('d', 'M20 36 C 60 8, 110 52, 180 20')
  line.setAttribute('fill', 'none')
  line.setAttribute('stroke-linecap', 'round')
  line.setAttribute('stroke-linejoin', 'round')
  appendChildren(preview, line)

  const width = slider(
    'Width',
    { min: MIN_WIDTH, max: MAX_WIDTH, step: 0.5 },
    (v) => `${v}px`,
    (v) => handle.setPen(tool, { width: v }),
  )
  width.input.name = 'width'
  const opacity = slider(
    'Opacity',
    { min: Math.round(MIN_OPACITY * 100), max: 100, step: 1 },
    (v) => `${v}%`,
    (v) => handle.setPen(tool, { opacity: v / 100 }),
  )
  opacity.input.name = 'opacity'

  const palette = element('div', 'handwriting-palette')
  palette.setAttribute('role', 'group')
  palette.setAttribute('aria-label', 'Colors')
  const swatches: HTMLButtonElement[] = []
  const cancels: (() => void)[] = []
  for (let i = 0; i < handle.getSettings().palette.length; i++) {
    const swatch = element('button', 'handwriting-swatch')
    swatch.type = 'button'
    let timer: ReturnType<typeof setTimeout> | null = null
    let held = false
    const cancel = (): void => {
      if (timer !== null) clearTimeout(timer)
      timer = null
    }
    swatch.addEventListener('pointerdown', () => {
      held = false
      cancel()
      timer = setTimeout(() => {
        timer = null
        held = true
        const colors = handle.getSettings().palette
        colors[i] = handle.getPen(tool).color
        handle.setPalette(colors)
      }, LONG_PRESS_MS)
    })
    cancels.push(cancel)
    for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) swatch.addEventListener(type, cancel)
    // A long touch would otherwise open the context menu
    swatch.addEventListener('contextmenu', (e) => e.preventDefault())
    swatch.addEventListener('click', () => {
      // The click that ends a long press only stores the color
      if (held) {
        held = false
        return
      }
      handle.setPen(tool, { color: handle.getSettings().palette[i] })
    })
    swatches.push(swatch)
  }
  const other = element('label', 'handwriting-swatch handwriting-swatch-other')
  other.title = 'Other color'
  const picker = element('input', 'handwriting-picker')
  picker.type = 'color'
  picker.setAttribute('aria-label', 'Other color')
  picker.addEventListener('input', () => handle.setPen(tool, { color: picker.value }))
  appendChildren(other, icon('plus'), picker)
  appendChildren(palette, ...swatches, other)

  // Pen pressure on or off for this pen
  const pressure = toggle('Pen pressure', 'A pen draws thinner when pressed lightly', (checked) =>
    handle.setPen(tool, { pressure: checked }),
  )
  pressure.input.name = 'pressure'

  appendChildren(root, preview, width.row, palette, opacity.row, pressure.row)

  return {
    element: root,
    update() {
      const pen = handle.getPen(tool)
      const colors = handle.getSettings().palette
      line.setAttribute('stroke', pen.color)
      line.setAttribute('stroke-opacity', String(pen.opacity))
      line.setAttribute('stroke-width', String(Math.min(pen.width, PREVIEW_MAX_WIDTH)))
      width.set(pen.width)
      opacity.set(Math.round(pen.opacity * 100))
      pressure.input.checked = pen.pressure
      swatches.forEach((swatch, i) => {
        swatch.style.setProperty('--handwriting-swatch', colors[i])
        swatch.setAttribute('aria-label', colors[i])
        swatch.setAttribute('aria-pressed', String(colors[i] === pen.color))
      })
      const custom = !colors.includes(pen.color)
      other.classList.toggle('handwriting-swatch-selected', custom)
      other.style.setProperty('--handwriting-swatch', custom ? pen.color : 'transparent')
      picker.value = pen.color
    },
    destroy() {
      for (const cancel of cancels) cancel()
    },
  }
}

/** The eraser's modes, as the switch in its popover names them */
const ERASER_MODE_LABELS: [EraserMode, string][] = [
  ['stroke', 'Whole stroke'],
  ['partial', 'Partial'],
]

/** The eraser's mode and size, with a circle of that size */
export function eraserPopover(handle: Handwriting): PopoverContent {
  const root = element('div', 'handwriting-popover-content')
  root.dataset.tool = 'eraser'
  const modes = element('div', 'handwriting-segments')
  modes.setAttribute('role', 'group')
  modes.setAttribute('aria-label', 'Erase')
  const modeButtons = ERASER_MODE_LABELS.map(([mode, label]) => {
    const button = element('button', 'handwriting-segment')
    button.type = 'button'
    button.textContent = label
    button.dataset.mode = mode
    button.addEventListener('click', () => handle.setEraser({ mode }))
    return button
  })
  appendChildren(modes, ...modeButtons)
  const preview = element('div', 'handwriting-popover-eraser')
  const circle = element('span', 'handwriting-eraser-circle')
  appendChildren(preview, circle)
  const size = slider(
    'Size',
    { min: MIN_ERASER_RADIUS, max: MAX_ERASER_RADIUS, step: 1 },
    (v) => `${v}px`,
    (v) => handle.setEraser({ radius: v }),
  )
  size.input.name = 'radius'
  // The mode switch only while the partial eraser is enabled
  if (experimentalOf(handle).partialEraser) appendChildren(root, modes)
  appendChildren(root, preview, size.row)
  return {
    element: root,
    update() {
      const { radius, mode } = handle.getSettings().eraser
      for (const button of modeButtons) button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
      circle.style.width = circle.style.height = `${2 * radius}px`
      size.set(radius)
    },
    destroy() {},
  }
}
