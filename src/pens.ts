/** The tools that draw strokes, each with a pen of its own */
export type PenTool = 'pen' | 'highlighter'

/** Style of the strokes a pen draws. Switching pens switches all of it */
export type Pen = {
  /** #rrggbb */
  color: string
  /** 0.13 to 1. Below 1 the stroke is translucent */
  opacity: number
  /** CSS px at the zoom the stroke is drawn at, 0.5 to 64; the width scales with the map */
  width: number
  /**
   * Whether pen pressure varies the width: with a pen (pointerType 'pen'), each point's width is `width` times the
   * coefficient the pressure curve gives (HandwritingSettings.pressure). Mouse and touch always draw at `width`
   */
  pressure: boolean
}

/**
 * How pen pressure p (0 to 1) becomes a width coefficient: min + (1 - min) * p^gamma, after smoothing p over the
 * pointer events. Shared by every pen that has pressure on
 */
export type PressureCurve = {
  /** The coefficient at no pressure, 0.05 to 1: the thinnest a line gets, as a part of the pen's width */
  min: number
  /** The curve's exponent, 0.2 to 5. Below 1 a light touch already draws wide */
  gamma: number
}

/**
 * 'stroke' erases every stroke the eraser touches as a whole. 'partial' erases only the part of a stroke within
 * reach and leaves the rest as new strokes; a stroke without an order yet is left alone
 */
export type EraserMode = 'stroke' | 'partial'

/** The eraser tool's reach and mode (setEraser) */
export type EraserSettings = {
  /** How far from the pointer the eraser reaches past a stroke's edge, in CSS px, 1 to 64 */
  radius: number
  mode: EraserMode
}

/** The laser pointer's lines. Every laser line, drawn here or received through the laser channel, is drawn in this color */
export type LaserSettings = {
  /** #rrggbb */
  color: string
}

/** The side of the map a toolbar sits on: horizontal on top and bottom, vertical on left and right */
export type ToolbarEdge = 'top' | 'bottom' | 'left' | 'right'

/** Where the toolbar (HandwritingToolbar) sits. The handle only keeps it, so that it is saved with the rest */
export type ToolbarSettings = {
  edge: ToolbarEdge
  /** Position along the edge, 0 (left or top end) to 1 (right or bottom end) */
  offset: number
  /** Only the selected tool is shown */
  collapsed: boolean
}

/** Everything a user of the app can change and may want to keep, e.g. in localStorage */
export type HandwritingSettings = {
  pens: Record<PenTool, Pen>
  /** The colors offered for every pen, #rrggbb; always 5 of them */
  palette: string[]
  eraser: EraserSettings
  pressure: PressureCurve
  toolbar: ToolbarSettings
  /** Set only through the defaults */
  laser: LaserSettings
  /**
   * Pen-only input: while it is on, touch no longer draws or erases but moves the map (one finger pans, two fingers
   * pinch), so a palm resting on the screen draws nothing; pen and mouse draw and erase with the tool. Off by
   * default, so a device without a pen can draw with touch
   */
  penOnly: boolean
}

/** Initial settings: any field left out keeps the library's default. getSettings() output fits as is */
export type HandwritingDefaults = {
  pens?: Partial<Record<PenTool, Partial<Pen>>>
  palette?: string[]
  eraser?: Partial<EraserSettings>
  pressure?: Partial<PressureCurve>
  toolbar?: Partial<ToolbarSettings>
  laser?: Partial<LaserSettings>
  penOnly?: boolean
}

export const PEN_TOOLS: readonly PenTool[] = ['pen', 'highlighter']
export const PALETTE_SIZE = 5
/** The protocol needs a stroke's alpha to be at least 0x20 (13%) */
export const MIN_OPACITY = 0.13
export const MIN_WIDTH = 0.5
export const MAX_WIDTH = 64
export const MIN_PRESSURE_MIN = 0.05
export const MIN_PRESSURE_GAMMA = 0.2
export const MAX_PRESSURE_GAMMA = 5
export const MIN_ERASER_RADIUS = 1
export const MAX_ERASER_RADIUS = 64
export const ERASER_MODES: readonly EraserMode[] = ['stroke', 'partial']
export const TOOLBAR_EDGES: readonly ToolbarEdge[] = ['top', 'bottom', 'left', 'right']

export const DEFAULT_SETTINGS: HandwritingSettings = {
  pens: {
    pen: { color: '#000000', opacity: 1, width: 4, pressure: true },
    highlighter: { color: '#ffeb3b', opacity: 0.5, width: 16, pressure: false },
  },
  // Black, red, blue, green, yellow
  palette: ['#000000', '#e53935', '#1e88e5', '#43a047', '#ffeb3b'],
  eraser: { radius: 6, mode: 'stroke' },
  pressure: { min: 0.25, gamma: 0.7 },
  toolbar: { edge: 'bottom', offset: 0.5, collapsed: false },
  laser: { color: '#ff3b30' },
  penOnly: false,
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/** The color a stroke is sent with: #rrggbb when opaque, #rrggbbaa otherwise */
export function strokeColor(pen: Pen): string {
  const alpha = Math.round(pen.opacity * 255)
  return alpha >= 255 ? pen.color : pen.color + alpha.toString(16).padStart(2, '0')
}

function checkColor(color: unknown, what: string): string {
  if (typeof color !== 'string' || !HEX_COLOR.test(color))
    throw new RangeError(`${what} must be #rrggbb, got ${String(color)}`)
  return color.toLowerCase()
}

function clampNumber(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || Number.isNaN(value))
    throw new RangeError(`${what} must be a number, got ${String(value)}`)
  return Math.min(max, Math.max(min, value))
}

/** A pen with the changed fields checked: colors must be #rrggbb, numbers are clamped to their ranges */
function mergePen(pen: Pen, change: Partial<Pen>): Pen {
  const next = { ...pen }
  if (change.color !== undefined) next.color = checkColor(change.color, 'color')
  if (change.opacity !== undefined) next.opacity = clampNumber(change.opacity, MIN_OPACITY, 1, 'opacity')
  if (change.width !== undefined) next.width = clampNumber(change.width, MIN_WIDTH, MAX_WIDTH, 'width')
  if (change.pressure !== undefined) next.pressure = Boolean(change.pressure)
  return next
}

function checkPalette(colors: unknown): string[] {
  if (!Array.isArray(colors) || colors.length !== PALETTE_SIZE) {
    throw new RangeError(`the palette must have ${PALETTE_SIZE} colors`)
  }
  return colors.map((color) => checkColor(color, 'a palette color'))
}

/**
 * An eraser with the changed fields checked: the radius is clamped, the mode must be one of ERASER_MODES, and
 * 'partial' only while the partial eraser is enabled
 */
function mergeEraser(eraser: EraserSettings, change: Partial<EraserSettings>, partialEraser: boolean): EraserSettings {
  const next = { ...eraser }
  if (change.radius !== undefined)
    next.radius = clampNumber(change.radius, MIN_ERASER_RADIUS, MAX_ERASER_RADIUS, 'eraser radius')
  if (change.mode !== undefined) {
    if (!ERASER_MODES.includes(change.mode))
      throw new RangeError(`eraser mode must be one of ${ERASER_MODES.join(', ')}, got ${String(change.mode)}`)
    if (change.mode === 'partial' && !partialEraser) {
      throw new RangeError("eraser mode 'partial' needs experimental: { partialEraser: true }")
    }
    next.mode = change.mode
  }
  return next
}

/** A toolbar placement with the changed fields checked: the edge must be one of the four, the offset is clamped */
function mergeToolbar(toolbar: ToolbarSettings, change: Partial<ToolbarSettings>): ToolbarSettings {
  const next = { ...toolbar }
  if (change.edge !== undefined) {
    if (!TOOLBAR_EDGES.includes(change.edge))
      throw new RangeError(`toolbar edge must be one of ${TOOLBAR_EDGES.join(', ')}, got ${String(change.edge)}`)
    next.edge = change.edge
  }
  if (change.offset !== undefined) next.offset = clampNumber(change.offset, 0, 1, 'toolbar offset')
  if (change.collapsed !== undefined) next.collapsed = Boolean(change.collapsed)
  return next
}

function copySettings(settings: HandwritingSettings): HandwritingSettings {
  return {
    pens: { pen: { ...settings.pens.pen }, highlighter: { ...settings.pens.highlighter } },
    palette: [...settings.palette],
    eraser: { ...settings.eraser },
    pressure: { ...settings.pressure },
    toolbar: { ...settings.toolbar },
    laser: { ...settings.laser },
    penOnly: settings.penOnly,
  }
}

function samePen(a: Pen, b: Pen): boolean {
  return a.color === b.color && a.opacity === b.opacity && a.width === b.width && a.pressure === b.pressure
}

/**
 * The pens, the palette, the eraser, the pressure curve, the toolbar placement, the laser and pen-only input of one handle. The
 * pressure curve and the laser color are set only through the defaults. Every change is checked; `onChange` is called after each
 * call that changed something, so a caller that saves getSettings() there and passes it back as defaults gets
 * the same settings
 */
export class PenSettings {
  private settings: HandwritingSettings

  /**
   * `partialEraser` enables the eraser mode 'partial'. While it is off, a default mode 'partial'
   * becomes 'stroke', so settings saved with it still load, and setEraser({ mode: 'partial' }) throws a RangeError
   */
  constructor(
    defaults: HandwritingDefaults = {},
    private onChange: (changed: { pen?: PenTool }) => void = () => {},
    private partialEraser = false,
  ) {
    const settings = copySettings(DEFAULT_SETTINGS)
    for (const tool of PEN_TOOLS) {
      const change = defaults.pens?.[tool]
      if (change) settings.pens[tool] = mergePen(settings.pens[tool], change)
    }
    if (defaults.palette !== undefined) settings.palette = checkPalette(defaults.palette)
    if (defaults.eraser) {
      const eraser =
        !partialEraser && defaults.eraser.mode === 'partial'
          ? { ...defaults.eraser, mode: 'stroke' as const }
          : defaults.eraser
      settings.eraser = mergeEraser(settings.eraser, eraser, partialEraser)
    }
    if (defaults.pressure?.min !== undefined) {
      settings.pressure.min = clampNumber(defaults.pressure.min, MIN_PRESSURE_MIN, 1, 'pressure min')
    }
    if (defaults.pressure?.gamma !== undefined) {
      settings.pressure.gamma = clampNumber(
        defaults.pressure.gamma,
        MIN_PRESSURE_GAMMA,
        MAX_PRESSURE_GAMMA,
        'pressure gamma',
      )
    }
    if (defaults.toolbar) settings.toolbar = mergeToolbar(settings.toolbar, defaults.toolbar)
    if (defaults.laser?.color !== undefined) settings.laser.color = checkColor(defaults.laser.color, 'laser color')
    if (defaults.penOnly !== undefined) settings.penOnly = Boolean(defaults.penOnly)
    this.settings = settings
  }

  get(): HandwritingSettings {
    return copySettings(this.settings)
  }

  pen(tool: PenTool): Pen {
    return { ...this.settings.pens[tool] }
  }

  pressureCurve(): PressureCurve {
    return { ...this.settings.pressure }
  }

  eraserRadius(): number {
    return this.settings.eraser.radius
  }

  eraserMode(): EraserMode {
    return this.settings.eraser.mode
  }

  penOnly(): boolean {
    return this.settings.penOnly
  }

  laserColor(): string {
    return this.settings.laser.color
  }

  setPen(tool: PenTool, change: Partial<Pen>): void {
    const next = mergePen(this.settings.pens[tool], change)
    if (samePen(next, this.settings.pens[tool])) return
    this.settings.pens[tool] = next
    this.onChange({ pen: tool })
  }

  setPalette(colors: string[]): void {
    const next = checkPalette(colors)
    if (next.every((color, i) => color === this.settings.palette[i])) return
    this.settings.palette = next
    this.onChange({})
  }

  setEraser(change: Partial<EraserSettings>): void {
    const next = mergeEraser(this.settings.eraser, change, this.partialEraser)
    if (next.radius === this.settings.eraser.radius && next.mode === this.settings.eraser.mode) return
    this.settings.eraser = next
    this.onChange({})
  }

  setToolbar(change: Partial<ToolbarSettings>): void {
    const next = mergeToolbar(this.settings.toolbar, change)
    const now = this.settings.toolbar
    if (next.edge === now.edge && next.offset === now.offset && next.collapsed === now.collapsed) return
    this.settings.toolbar = next
    this.onChange({})
  }

  setPenOnly(enabled: boolean): void {
    const next = Boolean(enabled)
    if (next === this.settings.penOnly) return
    this.settings.penOnly = next
    this.onChange({})
  }
}

/**
 * Checks settings the caller kept, e.g. getSettings() output saved in localStorage, before they are passed back as
 * `defaults`: returns them when createHandwriting would take them, and throws otherwise (a TypeError when `value`
 * is not an object, a RangeError for a field out of shape, e.g. one saved by an older version). An eraser mode
 * 'partial' passes, as createHandwriting turns it into 'stroke' while the partial eraser is off
 */
export function parseDefaults(value: unknown): HandwritingDefaults {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(
      `the defaults must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`,
    )
  }
  const defaults = value as HandwritingDefaults
  new PenSettings(defaults, undefined, true)
  return defaults
}
