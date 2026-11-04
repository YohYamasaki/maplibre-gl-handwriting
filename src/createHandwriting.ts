import type { Map as MapLibreMap } from 'maplibre-gl'
import { LaserChannel } from './core/laser'
import type { StrokeStore } from './core/stroke'
import { DrawController } from './DrawController'
import { EraseController } from './EraseController'
import { LaserController } from './LaserController'
import { registerDebugLayer, registerDebugPrediction } from './debug'
import { registerExperimental, type ExperimentalFeatures } from './experimental'
import { changeToolSize, KeyboardShortcuts } from './keyboard'
import { CLAIM_CURSOR, claimMapGestures, type GestureClaim } from './mapGestures'
import { createMapProjector, createScreenProjector, mercatorPerPixel } from './mapProjector'
import { PenOnlyInput } from './penOnly'
import { Prediction } from './Prediction'
import {
  PenSettings,
  strokeColor,
  type EraserSettings,
  type HandwritingDefaults,
  type HandwritingSettings,
  type Pen,
  type PenTool,
  type ToolbarSettings,
} from './pens'
import { SelectController } from './SelectController'
import { Selection } from './Selection'
import { deleteSelected, duplicateSelected, exportGeoJSON } from './selectionActions'
import { StrokeIndex } from './StrokeIndex'
import { holdsLayer, StrokeLayer } from './StrokeLayer'
import { StrokeTessellator } from './StrokeTessellator'
import { EraserCursor } from './ui/cursor'
import { LaserOverlay } from './ui/laser'
import { SelectionFrame } from './ui/selection'
import { ShortcutList } from './ui/shortcuts'
import { UndoHistory } from './UndoHistory'

/** What pointer input on the map does. null leaves it to the map (pan, zoom, rotate) */
export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'laser' | null

/** Identity of a stroke that is about to start */
export type StrokeIdentity = { id: string; author: string }

export type HandwritingOptions = {
  /**
   * The strokes to draw and to edit. The handle draws every stroke in it and loads nothing itself: put the strokes
   * in the store, e.g. with a load op, or connect a sync layer to it. Its order mode decides who
   * gives strokes their place in the drawing order
   */
  store: StrokeStore
  /**
   * Called on every pointerdown with a drawing tool. Returns the new stroke's ID and author, or null to ignore
   * the input. Also called for the ID of each piece the partial eraser leaves of a stroke (the piece keeps the
   * stroke's author); null leaves that stroke uncut. When omitted, strokes get crypto.randomUUID() and `author`
   */
  startStroke?: () => StrokeIdentity | null
  /** Author of new strokes when startStroke is omitted */
  author?: string
  /** ID of the map layer that draws the strokes. Default 'handwriting' */
  layerId?: string
  /**
   * The layer is inserted before this layer, or on top when omitted. While the style has no layer with this ID, the
   * layer is not put on top: it waits, and is inserted before that layer once it appears
   */
  beforeId?: string
  /**
   * Initial pens, palette, eraser, toolbar placement, laser color and pen-only input, e.g. the settings the app
   * saved from getSettings(). Fields left out keep the defaults: pen black 4px, highlighter yellow 50% 16px, eraser
   * 6px, toolbar at the bottom center, laser #ff3b30, pen-only input off
   */
  defaults?: HandwritingDefaults
  /**
   * Keyboard shortcuts on the page: H or 1 move map, P or 2 pen, M or 3 highlighter, E or 4
   * eraser, L or 5 lasso, K laser pointer, Space held to move the map, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z or Ctrl+Y
   * redo, Delete or Backspace and Cmd/Ctrl+D delete and duplicate the selection, Esc clears it, [ and ] change the
   * pen's width or the eraser's radius, ? lists them. Ignored while typing in a form field. Default false; see setKeyboard
   */
  keyboard?: boolean
  /**
   * Features still being worked on, off by default. `partialEraser` enables the eraser mode
   * 'partial': while it is off, setEraser({ mode: 'partial' }) throws a RangeError, a default mode 'partial'
   * becomes 'stroke', and the toolbar offers no mode switch
   */
  experimental?: ExperimentalFeatures
  /**
   * Where the laser pointer's lines go and come from: the lines drawn with the laser tool are
   * emitted on it as local, and every line on it is shown for a moment. Connect the sync layer to the same channel
   * to share them. When omitted, the handle makes a channel of its own
   */
  laser?: LaserChannel
  /** Where to fetch the WebAssembly module from, instead of next to this script */
  wasmUrl?: string | URL
  /** Where to load the tessellation worker script from, instead of next to this script */
  workerUrl?: string | URL
  /**
   * What Export in the selection's bar does with the selected strokes' GeoJSON (see exportGeoJSON). When omitted,
   * it downloads strokes.geojson; null leaves Export out of the bar
   */
  onExport?: ((geojson: string) => void) | null
}

/** Event payloads, by event name */
export type HandwritingEventMap = {
  /** canUndo or canRedo may have changed */
  history: { canUndo: boolean; canRedo: boolean }
  toolchange: { tool: Tool }
  penchange: { tool: PenTool; pen: Pen }
  /** Any setting changed: a pen, the palette, the eraser, the toolbar placement or pen-only input. Save `settings` to restore them as `defaults` */
  settingschange: { settings: HandwritingSettings }
}

export type HandwritingListener<K extends keyof HandwritingEventMap> = (event: HandwritingEventMap[K]) => void

/** What createHandwriting returns */
export type Handwriting = {
  /**
   * Resolves once the WebAssembly module is loaded. The layer is added then, or once the style has loaded, and again
   * after each style.load that leaves it out, such as setStyle without a diff
   */
  readonly ready: Promise<void>
  setTool(tool: Tool): void
  getTool(): Tool
  /**
   * Changes the given fields of a pen. The next stroke drawn with it uses them. Throws a RangeError for a color
   * that is not #rrggbb; numbers are clamped to their ranges
   */
  setPen(tool: PenTool, pen: Partial<Pen>): void
  getPen(tool: PenTool): Pen
  /** Replaces the palette: 5 colors, #rrggbb */
  setPalette(colors: string[]): void
  setEraser(eraser: Partial<EraserSettings>): void
  /**
   * Changes where the toolbar sits. HandwritingToolbar calls it when it is moved or collapsed; the handle only
   * keeps the value and reports it in settingschange. Throws a RangeError for an unknown edge
   */
  setToolbar(toolbar: Partial<ToolbarSettings>): void
  /**
   * Turns pen-only input on or off: while it is on, touch moves the map instead of drawing or erasing (see
   * HandwritingSettings.penOnly). Turning it on ends a touch that is drawing or erasing at that moment
   */
  setPenOnly(enabled: boolean): void
  getSettings(): HandwritingSettings
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
  /**
   * The strokes with these IDs, or the selected ones when omitted, as a GeoJSON (RFC 7946) FeatureCollection
   * string: one LineString (or Point) per stroke, in WGS84 [lng, lat], in drawing order. IDs not in the store and
   * strokes without an order yet are skipped
   */
  exportGeoJSON(ids?: Iterable<string>): string
  /** Forgets the undo history, e.g. when a new connection can no longer undo the previous one's erases */
  clearHistory(): void
  /**
   * Turns the keyboard shortcuts (HandwritingOptions.keyboard) on or off. They listen on the window, so with two
   * handles on a page, turn them on for one only
   */
  setKeyboard(enabled: boolean): void
  isKeyboardEnabled(): boolean
  on<K extends keyof HandwritingEventMap>(type: K, listener: HandwritingListener<K>): void
  off<K extends keyof HandwritingEventMap>(type: K, listener: HandwritingListener<K>): void
  /**
   * Removes the layer and every listener, and gives the map back the gestures the tools took. Also frees the layer's
   * worker and GPU resources when the layer is no longer on the map's style, e.g. after map.remove()
   */
  destroy(): void
}

/** How many actions undo can go back */
const UNDO_LIMIT = 50
/** How far a duplicate is moved from the strokes it copies, right and down, in CSS px */
const DUPLICATE_OFFSET = 16

/**
 * Adds a layer that draws the strokes of `options.store` to the map and turns pointer input on the map into
 * stroke ops for the selected tool. The store is the caller's: the sync layer connects to it, not to the handle.
 *
 * The tip of a stroke being drawn reaches the screen sooner on a map made with
 * `canvasContextAttributes: { desynchronized: true }`, where the browser supports it
 */
export function createHandwriting(map: MapLibreMap, options: HandwritingOptions): Handwriting {
  const { store } = options
  const layerId = options.layerId ?? 'handwriting'
  let tool: Tool = null
  const listeners = new Map<keyof HandwritingEventMap, Set<(event: never) => void>>()
  let destroyed = false
  // This handle's claim on the map's pointer gestures, while a tool is selected
  let gestures: GestureClaim | null = null

  function emit<K extends keyof HandwritingEventMap>(type: K, event: HandwritingEventMap[K]): void {
    for (const listener of [...(listeners.get(type) ?? [])]) (listener as HandwritingListener<K>)(event)
  }

  const settings = new PenSettings(options.defaults, (changed) => {
    // A touch drawing or erasing when pen-only input turns on ends there, as when a pen lands
    if (settings.penOnly() && !penOnlyWas) releaseTouches(penOnly.pressedTouches())
    penOnlyWas = settings.penOnly()
    if (changed.pen) emit('penchange', { tool: changed.pen, pen: settings.pen(changed.pen) })
    emit('settingschange', { settings: settings.get() })
    updateTouch()
  }, options.experimental?.partialEraser === true)
  const penOnly = new PenOnlyInput(() => settings.penOnly())
  let penOnlyWas = settings.penOnly()

  const history = new UndoHistory(store, UNDO_LIMIT, () =>
    emit('history', { canUndo: history.canUndo, canRedo: history.canRedo }),
  )

  const element = map.getCanvasContainer()
  const project = createMapProjector(map)
  const index = new StrokeIndex(store)
  const newIdentity = (): StrokeIdentity | null =>
    options.startStroke ? options.startStroke() : { id: crypto.randomUUID(), author: options.author ?? '' }
  // The browser's predicted points after the tip of the stroke being drawn, drawn but never applied to the store
  const prediction = new Prediction()
  const draw = new DrawController(element, store, project, {
      startStroke: (e) => {
        if ((tool !== 'pen' && tool !== 'highlighter') || !penOnly.accepts(e)) return null
        const identity = newIdentity()
        if (!identity) return null
        const pen = settings.pen(tool)
        return {
          id: identity.id,
          author: identity.author,
          color: strokeColor(pen),
          width: pen.width,
          pressure: pen.pressure ? settings.pressureCurve() : null,
        }
      },
      getZoom: () => map.getZoom(),
      onStroke: (stroke) => history.record({ type: 'draw', strokes: [stroke] }),
      prediction,
    })
  const erase = new EraseController(element, store, project, index, {
      isEnabled: (e) => tool === 'eraser' && penOnly.accepts(e),
      radius: () => settings.eraserRadius(),
      pixelSize: () => mercatorPerPixel(map),
      mode: () => settings.eraserMode(),
      newPieceId: () => newIdentity()?.id ?? null,
      onErase: (strokes) => history.record({ type: 'erase', strokes }),
      onCut: (cuts) => history.record({ type: 'split', cuts }),
    })
  const selection = new Selection(store)
  const toScreen = createScreenProjector(map)
  const select = new SelectController(element, store, project, toScreen, index, selection, {
    isEnabled: (e) => tool === 'lasso' && penOnly.accepts(e),
    pixelSize: () => mercatorPerPixel(map),
    onLasso: (points) => frame.showLasso(points),
    onTransform: (ids, matrix) => history.record({ type: 'transform', ids, matrix }),
    onCursor: (cursor) => gestures?.setCursor(cursor),
  })
  const deleteSelection = (): void => {
    const strokes = deleteSelected(store, selection)
    if (strokes.length > 0) history.record({ type: 'erase', strokes })
  }
  const duplicateSelection = (): void => {
    const strokes = duplicateSelected(store, selection, newIdentity, DUPLICATE_OFFSET * mercatorPerPixel(map))
    if (strokes.length > 0) history.record({ type: 'draw', strokes })
  }
  const frame = new SelectionFrame(map.getContainer(), selection, toScreen, {
    onDelete: deleteSelection,
    onDuplicate: duplicateSelection,
    ...(options.onExport === null
      ? {}
      : { onExport: (): void => (options.onExport ?? downloadGeoJSON)(exportGeoJSON(store, selection.ids)) }),
  })
  const updateFrame = (): void => {
    frame.update()
    // The frame moved with the map, maybe under a pointer at rest
    select.updateCursor()
  }
  map.on('move', updateFrame)
  const laserChannel = options.laser ?? new LaserChannel()
  const laser = new LaserController(element, laserChannel, project, {
    isEnabled: (e) => tool === 'laser' && penOnly.accepts(e),
  })
  const laserOverlay = new LaserOverlay(map, laserChannel, () => settings.laserColor())
  const controllers = [draw, erase, select, laser]
  const cursor = new EraserCursor(element)

  /** Ends the gesture of each controller driven by one of these touch pointers; the stroke stays as far as it got */
  function releaseTouches(touches: number[]): void {
    for (const controller of controllers) {
      const pointer = controller.pointer
      if (pointer !== null && touches.includes(pointer)) controller.end()
    }
  }

  // Registered before the controllers' listeners, so pen-only input sees a pointer before they decide on it
  const onPointerDown = (e: PointerEvent): void => {
    const toolSelected = tool !== null
    // A touch already drawing or erasing when the pen lands is let go of, so the pen's own pointerdown, which the
    // controllers see next, starts its gesture
    releaseTouches(penOnly.down(e, toolSelected))
    // A pen or mouse pressed with a tool turns the touch gestures off (updateTouch) before its compatibility
    // mousedown reaches MapLibre, whose dragPan pans with the mouse too. The capture makes sure its release
    // arrives here
    if (toolSelected && e.pointerType !== 'touch') element.setPointerCapture(e.pointerId)
    updateTouch()
    showCursor(e)
  }
  const onPointerUp = (e: PointerEvent): void => {
    penOnly.up(e)
    updateTouch()
  }
  /** The eraser's circle follows a pen or mouse while the eraser is selected */
  const showCursor = (e: PointerEvent): void => {
    if (tool === 'eraser' && e.pointerType !== 'touch') cursor.show(e.clientX, e.clientY, settings.eraserRadius())
    else cursor.hide()
  }
  const hideCursor = (): void => cursor.hide()
  const pointerListeners: [string, (e: PointerEvent) => void][] = [
    ['pointerdown', onPointerDown],
    ['pointerup', onPointerUp],
    ['pointercancel', onPointerUp],
    ['lostpointercapture', onPointerUp],
    ['pointermove', showCursor],
    ['pointerleave', hideCursor],
  ]
  for (const [type, listener] of pointerListeners) element.addEventListener(type, listener as EventListener)
  for (const controller of controllers) controller.enable()

  let layer: StrokeLayer | null = null
  // Whether addLayer listens for styledata, waiting for the style to get the layer options.beforeId names
  let waitingForBefore = false
  /**
   * Adds the layer to the style when it is not there: once the module has loaded, and on every style.load, since a
   * style rebuilt without a diff leaves the layer out (and calls no onRemove: the layer's next onAdd frees what it
   * held). Before the style has loaded, map.addLayer throws, and the next style.load adds the layer
   */
  const addLayer = (): void => {
    // After map.remove() the map has no style, and map.addLayer would make an empty one. The ID taken, by this layer or
    // another, the style cannot take the layer either
    if (destroyed || !layer || !map.style || map.getLayer(layerId)) return
    const { beforeId } = options
    // Never on top while the style lacks the layer to go before: each styledata looks for it again
    const missing = beforeId ? !map.getLayer(beforeId) : false
    if (missing !== waitingForBefore) {
      if (missing) map.on('styledata', addLayer)
      else map.off('styledata', addLayer)
      waitingForBefore = missing
    }
    if (missing) return
    try {
      map.addLayer(layer, beforeId)
    } catch {
      // The style has not loaded yet; its style.load adds the layer
    }
  }
  map.on('style.load', addLayer)
  const ready = StrokeTessellator.load(options.wasmUrl).then((tessellator) => {
    if (destroyed) return
    layer = new StrokeLayer(store, tessellator, {
      id: layerId,
      wasmUrl: options.wasmUrl,
      workerUrl: options.workerUrl,
      selection,
      prediction,
    })
    if (__HANDWRITING_DEBUG__) registerDebugLayer(handle, layer)
    addLayer()
  })

  /** Holds a claim on the map's pointer gestures while a tool is selected (shared with other handles on the map) */
  function updateMapGestures(): void {
    if (tool !== null && !gestures) {
      gestures = claimMapGestures(map)
      updateTouch()
    } else if (tool === null && gestures) {
      gestures.release()
      gestures = null
    }
  }

  /** Lets touch move the map while pen-only input applies and no pen or mouse is pressed with a tool */
  function updateTouch(): void {
    gestures?.setTouchFree(penOnly.touchFree)
  }

  /** Selects a tool. The selection belongs to the lasso and goes with it, unless Space only holds the hand */
  function selectTool(next: Tool, keepSelection: boolean): void {
    if (destroyed || next === tool) return
    // A drag in progress belongs to the tool it started with: it ends here, and its rest does nothing
    for (const controller of controllers) controller.end()
    tool = next
    if (tool !== 'eraser') cursor.hide()
    if (tool !== 'lasso' && !keepSelection) selection.clear()
    updateMapGestures()
    // Drawing tools show a crosshair; the lasso the arrow, until a hover over the frame says otherwise
    gestures?.setCursor(tool === 'lasso' ? 'default' : CLAIM_CURSOR)
    // A pointer already resting on the frame (kept while Space held the hand) gets the frame's cursor at once
    if (tool === 'lasso') select.updateCursor()
    emit('toolchange', { tool })
  }

  const container = map.getContainer()
  const shortcutList = new ShortcutList(container)
  const shortcuts = new KeyboardShortcuts({
    getTool: () => tool,
    setTool: (next) => {
      // A tool chosen while Space holds the hand takes the selection away too
      if (next !== 'lasso') selection.clear()
      selectTool(next, false)
    },
    holdHand: () => selectTool(null, true),
    undo: () => handle.undo(),
    redo: () => handle.redo(),
    hasSelection: () => selection.size > 0,
    deleteSelection,
    duplicateSelection,
    clearSelection: () => selection.clear(),
    changeSize: (delta) => changeToolSize(settings, tool, delta),
    toggleList: () => shortcutList.toggle(),
    closeList: () => shortcutList.close(),
    isInMap: (target) => target instanceof Node && container.contains(target),
  }, window)
  function setKeyboard(enabled: boolean): void {
    if (!destroyed) shortcuts.setEnabled(enabled)
  }

  const handle: Handwriting = {
    ready,
    setTool: (next) => selectTool(next, false),
    getTool: () => tool,
    setPen(which, pen) {
      if (!destroyed) settings.setPen(which, pen)
    },
    getPen: (which) => settings.pen(which),
    setPalette(colors) {
      if (!destroyed) settings.setPalette(colors)
    },
    setEraser(eraser) {
      if (!destroyed) settings.setEraser(eraser)
    },
    setToolbar(toolbar) {
      if (!destroyed) settings.setToolbar(toolbar)
    },
    setPenOnly(enabled) {
      if (!destroyed) settings.setPenOnly(enabled)
    },
    getSettings: () => settings.get(),
    // A partial erase in progress hides strokes the history may act on: put them back first
    undo: () => {
      erase.cancelCuts()
      history.undo()
    },
    redo: () => {
      erase.cancelCuts()
      history.redo()
    },
    canUndo: () => history.canUndo,
    canRedo: () => history.canRedo,
    clearHistory: () => history.clear(),
    setKeyboard,
    isKeyboardEnabled: () => shortcuts.enabled,
    exportGeoJSON: (ids) => exportGeoJSON(store, ids ?? selection.ids),
    on(type, listener) {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(listener as (event: never) => void)
    },
    off(type, listener) {
      listeners.get(type)?.delete(listener as (event: never) => void)
    },
    destroy() {
      if (destroyed) return
      setKeyboard(false)
      shortcutList.destroy()
      tool = null
      updateMapGestures()
      destroyed = true
      for (const controller of controllers) controller.disable()
      for (const [type, listener] of pointerListeners) element.removeEventListener(type, listener as EventListener)
      cursor.destroy()
      laserOverlay.destroy()
      frame.destroy()
      map.off('move', updateFrame)
      selection.destroy()
      index.destroy()
      map.off('style.load', addLayer)
      map.off('styledata', addLayer)
      // On the map's style, removeLayer frees the layer through onRemove. Off it (map.remove(), or a style rebuilt
      // without it while beforeId is missing) no onRemove comes, and dispose frees it; a layer of another with the
      // same ID stays
      if (layer && holdsLayer(map, layer)) map.removeLayer(layerId)
      else layer?.dispose()
      if (__HANDWRITING_DEBUG__) registerDebugLayer(handle, null)
      listeners.clear()
    },
  }
  if (__HANDWRITING_DEBUG__) registerDebugPrediction(handle, prediction)
  registerExperimental(handle, options.experimental)
  setKeyboard(options.keyboard ?? false)
  return handle
}

/** Saves `geojson` as strokes.geojson through the browser's download */
function downloadGeoJSON(geojson: string): void {
  const url = URL.createObjectURL(new Blob([geojson], { type: 'application/geo+json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'strokes.geojson'
  link.click()
  // The navigation the click starts resolved the URL to its Blob when it parsed it, so the URL can go now
  URL.revokeObjectURL(url)
}
