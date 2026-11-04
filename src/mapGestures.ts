import type { Map as MapLibreMap } from 'maplibre-gl'

/** The map gestures that would move the map under a pointer that draws, erases or selects */
export const POINTER_HANDLERS = [
  'dragPan',
  'dragRotate',
  'touchZoomRotate',
  'touchPitch',
  'boxZoom',
  'doubleClickZoom',
] as const

/**
 * The gestures given back to touch in pen-only input: one finger pans, two fingers pinch, rotate and pitch.
 * dragPan also pans with the mouse, so a handle takes touch back (setTouchFree(false)) while a mouse or pen presses
 * with a tool
 */
export const TOUCH_HANDLERS = ['dragPan', 'touchZoomRotate', 'touchPitch'] as const

type HandlerName = (typeof POINTER_HANDLERS)[number]

/** The parts of a MapLibre map the gesture claims touch */
export type GestureMap = Pick<MapLibreMap, HandlerName> & {
  getCanvas(): { style: { cursor: string; touchAction: string } }
  getCanvasContainer(): { style: { cursor: string } }
}

/** The cursor while a claim is held and none has set one */
export const CLAIM_CURSOR = 'crosshair'

/** One handle's hold on the map's gestures */
export type GestureClaim = {
  /**
   * Whether this claim lets touch move the map. The touch gestures the first claim turned off are on while every
   * claim held on the map lets them, and off otherwise
   */
  setTouchFree(free: boolean): void
  /**
   * Sets this claim's cursor (a CSS cursor) on the canvas and the canvas container, inline so that it wins over
   * MapLibre's stylesheet while the container holds the pointer. The map shows the cursor of the
   * claim that set one last
   */
  setCursor(cursor: string): void
  /** Releases this claim; releasing twice counts once */
  release(): void
}

type Holder = { touchFree: boolean; cursor: string | null }

type Claims = {
  /** In the order they last set a cursor, those that never did first */
  holders: Set<Holder>
  /** The gestures the first claim turned off, and the canvas's cursor and touch-action and the container's cursor before it */
  taken: HandlerName[]
  cursor: string
  containerCursor: string
  touchAction: string
  /** Whether the taken touch gestures are on now */
  touchOn: boolean
}

// Shared by every handle on the same map, so one handle letting go does not give the map back while another
// still holds a tool
const claimsByMap = new WeakMap<object, Claims>()

/** Turns the taken touch gestures on when every holder lets them, and off otherwise */
function updateTouch(map: GestureMap, claims: Claims): void {
  const on = claims.holders.size > 0 && [...claims.holders].every((holder) => holder.touchFree)
  if (on === claims.touchOn) return
  claims.touchOn = on
  for (const name of TOUCH_HANDLERS) {
    if (!claims.taken.includes(name)) continue
    if (on) map[name].enable()
    else map[name].disable()
  }
}

/** Shows the cursor of the holder that set one last, or the crosshair */
function updateCursor(map: GestureMap, claims: Claims): void {
  let cursor = CLAIM_CURSOR
  for (const holder of claims.holders) if (holder.cursor !== null) cursor = holder.cursor
  const canvas = map.getCanvas().style
  const container = map.getCanvasContainer().style
  if (canvas.cursor !== cursor) canvas.cursor = cursor
  if (container.cursor !== cursor) container.cursor = cursor
}

/**
 * Turns off the map's pointer gestures and sets a crosshair cursor while at least one claim on the map is held.
 * The canvas's touch-action is none meanwhile: with MapLibre's touch gestures off its stylesheet leaves it at auto,
 * and the browser then takes a touch or pen drag for scrolling and cancels its pointer mid-stroke. The last release
 * gives back only the gestures the first claim turned off, and the cursors and touch-action from before it
 */
export function claimMapGestures(map: GestureMap): GestureClaim {
  let claims = claimsByMap.get(map)
  if (!claims) {
    const taken = POINTER_HANDLERS.filter((name) => map[name].isEnabled())
    for (const name of taken) map[name].disable()
    const canvas = map.getCanvas()
    claims = {
      holders: new Set(),
      taken,
      cursor: canvas.style.cursor,
      containerCursor: map.getCanvasContainer().style.cursor,
      touchAction: canvas.style.touchAction,
      touchOn: false,
    }
    canvas.style.touchAction = 'none'
    claimsByMap.set(map, claims)
  }
  const held = claims
  const holder: Holder = { touchFree: false, cursor: null }
  held.holders.add(holder)
  updateTouch(map, held)
  updateCursor(map, held)
  let released = false
  return {
    setTouchFree(free) {
      if (released || holder.touchFree === free) return
      holder.touchFree = free
      updateTouch(map, held)
    },
    setCursor(cursor) {
      if (released) return
      holder.cursor = cursor
      // Moved to the end: the last to set a cursor shows it
      held.holders.delete(holder)
      held.holders.add(holder)
      updateCursor(map, held)
    },
    release() {
      if (released) return
      released = true
      held.holders.delete(holder)
      if (held.holders.size > 0) {
        updateTouch(map, held)
        updateCursor(map, held)
        return
      }
      claimsByMap.delete(map)
      // The taken touch gestures may be on already; enable() on an enabled handler does nothing
      for (const name of held.taken) map[name].enable()
      const canvas = map.getCanvas()
      canvas.style.cursor = held.cursor
      canvas.style.touchAction = held.touchAction
      map.getCanvasContainer().style.cursor = held.containerCursor
    },
  }
}
