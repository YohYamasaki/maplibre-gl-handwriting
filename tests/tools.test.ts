// The tools a handle offers (HandwritingOptions.tools), without a browser: setTool, getTools, the keyboard shortcuts
// on the window and the tools given to the shortcut list; and the IDs the tools give the strokes they make when
// startStroke is omitted, where crypto.randomUUID is missing. createHandwriting's DOM parts are stand-ins here
import { MercatorCoordinate, type LngLat } from 'maplibre-gl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrokeStore } from '../src/core/stroke'
import { createHandwriting, type Tool } from '../src/createHandwriting'
import { POINTER_HANDLERS } from '../src/mapGestures'
import { mercatorPerPixelAt } from '../src/mercator'
import { StrokeTessellator } from '../src/StrokeTessellator'
import { FakeWorker, handwritingMap, type HandwritingMap } from './layerFakes'
import { fakeWriter, UUID_V4 } from './support'

const lists = vi.hoisted(() => ({ tools: [] as unknown[] }))

vi.mock('../src/ui/cursor', () => ({
  EraserCursor: class {
    show(): void {}
    hide(): void {}
    destroy(): void {}
  },
}))
vi.mock('../src/ui/selection', () => ({
  SelectionFrame: class {
    update(): void {}
    showLasso(): void {}
    destroy(): void {}
  },
}))
vi.mock('../src/ui/laser', () => ({
  LaserOverlay: class {
    destroy(): void {}
  },
}))
// The list's rows come from shortcutRows (tests/keyboard.test.ts); here, the tools it is given
vi.mock('../src/ui/shortcuts', () => ({
  ShortcutList: class {
    constructor(_container: unknown, tools: unknown) {
      lists.tools.push(tools)
    }
    toggle(): void {}
    close(): boolean {
      return false
    }
    destroy(): void {}
  },
}))

/** A keydown on the window, as the browser dispatches it */
function keydown(key: string, ctrlKey = false): Event {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key,
    ctrlKey,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
  })
  window.dispatchEvent(event)
  return event
}

function create(tools?: readonly NonNullable<Tool>[]): ReturnType<typeof createHandwriting> {
  return createHandwriting(handwritingMap(), { store: new StrokeStore(), tools, keyboard: true })
}

beforeEach(() => {
  FakeWorker.reset()
  lists.tools = []
  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('window', new EventTarget())
  vi.spyOn(StrokeTessellator, 'load').mockReturnValue(new Promise(() => {}))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HandwritingOptions.tools', () => {
  it('offers every tool by default', () => {
    const handle = create()
    expect(handle.getTools()).toEqual(['pen', 'highlighter', 'eraser', 'lasso', 'laser'])
    handle.destroy()
  })

  it('throws a RangeError from setTool for a tool left out, and still takes the hand', () => {
    const handle = create(['pen', 'eraser'])
    expect(handle.getTools()).toEqual(['pen', 'eraser'])
    expect(() => handle.setTool('laser')).toThrow(RangeError)
    expect(() => handle.setTool('highlighter')).toThrow(RangeError)
    expect(handle.getTool()).toBeNull()
    handle.setTool(null)
    expect(handle.getTool()).toBeNull()
    handle.destroy()
  })

  it('throws a RangeError from createHandwriting for an unknown tool', () => {
    expect(() => create(['pen', 'marker' as NonNullable<Tool>])).toThrow(RangeError)
  })

  it('leaves the keys of the tools left out to the page, and gives the shortcut list only the tools offered', () => {
    const handle = create(['pen'])
    const laser = keydown('k')
    expect(laser.defaultPrevented).toBe(false)
    expect(handle.getTool()).toBeNull()
    expect(keydown('3').defaultPrevented).toBe(false)
    expect(lists.tools).toEqual([['pen']])
    handle.destroy()
  })

  it('keeps its tools when the array given is changed afterwards, and getTools hands out a copy', () => {
    const tools: NonNullable<Tool>[] = ['pen']
    const handle = create(tools)
    tools.push('laser')
    handle.getTools().push('eraser')
    expect(handle.getTools()).toEqual(['pen'])
    expect(() => handle.setTool('laser')).toThrow(RangeError)
    handle.destroy()
  })
})

// One CSS px at the map's zoom (12), in Web Mercator units: client (x, y) is [0.5 + x px, 0.5 + y px]
const PX = mercatorPerPixelAt(12)

/** handwritingMap with what the tools use of it: the camera, the container's box and cursor, the map's gestures */
function drawingMap(): HandwritingMap {
  const map = handwritingMap()
  const gesture = (): object => ({ isEnabled: () => true, enable() {}, disable() {} })
  Object.assign(map.getCanvasContainer(), { style: { cursor: '' }, getBoundingClientRect: () => ({ left: 0, top: 0 }) })
  const canvas = { style: { cursor: '', touchAction: '' } }
  return Object.assign(map, {
    ...Object.fromEntries(POINTER_HANDLERS.map((name) => [name, gesture()])),
    getCanvas: () => canvas,
    unproject: ([x, y]: [number, number]) => new MercatorCoordinate(0.5 + x * PX, 0.5 + y * PX).toLngLat(),
    project: (lngLat: LngLat) => {
      const { x, y } = MercatorCoordinate.fromLngLat(lngLat)
      return { x: (x - 0.5) / PX, y: (y - 0.5) / PX }
    },
  })
}

describe('the IDs of a handle without startStroke, where crypto.randomUUID is missing (not a secure context)', () => {
  function setup(): {
    store: StrokeStore
    handle: ReturnType<typeof createHandwriting>
    pointer: (type: string, x: number, y: number) => void
    drag: (path: [number, number][]) => void
  } {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    const map = drawingMap()
    const store = new StrokeStore()
    const handle = createHandwriting(map, { store, keyboard: true, experimental: { partialEraser: true } })
    const element = map.getCanvasContainer()
    const pointer = (type: string, x: number, y: number): void =>
      void element.dispatchEvent(
        Object.assign(new Event(type), {
          pointerId: 1,
          pointerType: 'pen',
          button: 0,
          pressure: 0.5,
          clientX: x,
          clientY: y,
        }),
      )
    const drag = (path: [number, number][]): void => {
      pointer('pointerdown', ...path[0]!)
      for (const point of path.slice(1)) pointer('pointermove', ...point)
      pointer('pointerup', ...path[path.length - 1]!)
    }
    return { store, handle, pointer, drag }
  }

  /** A pen stroke from client (10, 10) to (60, 10), and its ID */
  function drawLine(
    handle: ReturnType<typeof createHandwriting>,
    drag: (path: [number, number][]) => void,
    store: StrokeStore,
  ): string {
    handle.setTool('pen')
    drag(Array.from({ length: 11 }, (_, i): [number, number] => [10 + 5 * i, 10]))
    const ids = [...store.values()].map((stroke) => stroke.id)
    expect(ids).toHaveLength(1)
    return ids[0]!
  }

  it('gives a pen stroke a UUID v4', () => {
    const { store, handle, drag } = setup()
    expect(crypto.randomUUID).toBeUndefined()
    const id = drawLine(handle, drag, store)
    expect(id).toMatch(UUID_V4)
    expect(store.get(id)!.points.length).toBeGreaterThan(1)
    handle.destroy()
  })

  it('gives the two pieces the partial eraser leaves UUID v4', () => {
    const { store, handle, drag } = setup()
    const id = drawLine(handle, drag, store)
    handle.setEraser({ mode: 'partial' })
    handle.setTool('eraser')
    drag([
      [35, -10],
      [35, 30],
    ])
    const pieces = [...store.values()].map((stroke) => stroke.id)
    expect(pieces).toHaveLength(2)
    expect(pieces).not.toContain(id)
    for (const piece of pieces) expect(piece).toMatch(UUID_V4)
    handle.destroy()
  })

  it('gives the duplicate of a stroke the lasso selected a UUID v4', () => {
    const { store, handle, drag } = setup()
    const id = drawLine(handle, drag, store)
    handle.setTool('lasso')
    drag([
      [0, -10],
      [100, -10],
      [100, 30],
      [0, 30],
    ])
    expect(keydown('d', true).defaultPrevented).toBe(true)
    const copies = [...store.values()].map((stroke) => stroke.id).filter((other) => other !== id)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatch(UUID_V4)
    handle.destroy()
  })
})

describe('touchstart while a tool is selected', () => {
  /** A touchstart on the map's canvas container, as iOS dispatches it, with one changed touch */
  function touchstart(element: EventTarget, touchType: 'stylus' | 'direct'): Event {
    const event = Object.assign(new Event('touchstart', { cancelable: true }), {
      changedTouches: [{ identifier: 3, touchType }],
    })
    element.dispatchEvent(event)
    return event
  }

  beforeEach(() => {
    vi.stubGlobal('HTMLElement', class {})
  })

  /** A focused element and the document around it */
  function focus(): { blur: ReturnType<typeof vi.fn> } {
    const active = Object.assign(new (globalThis as unknown as { HTMLElement: new () => object }).HTMLElement(), {
      blur: vi.fn(),
    })
    vi.stubGlobal('document', { activeElement: active, body: {} })
    return active
  }

  it('prevents the default of a touch a tool takes, and lets go of the focus then only', () => {
    const map = drawingMap()
    const element = map.getCanvasContainer()
    const handle = createHandwriting(map, { store: new StrokeStore() })
    const active = focus()

    expect(touchstart(element, 'stylus').defaultPrevented).toBe(false)
    expect(active.blur).not.toHaveBeenCalled()

    handle.setTool('pen')
    expect(touchstart(element, 'stylus').defaultPrevented).toBe(true)
    expect(active.blur).toHaveBeenCalledTimes(1)

    handle.setPenOnly(true)
    expect(touchstart(element, 'direct').defaultPrevented).toBe(false)
    expect(touchstart(element, 'stylus').defaultPrevented).toBe(true)
    expect(active.blur).toHaveBeenCalledTimes(2)

    handle.setPenOnly(false)
    expect(touchstart(element, 'direct').defaultPrevented).toBe(true)
    expect(active.blur).toHaveBeenCalledTimes(3)

    handle.destroy()
    expect(touchstart(element, 'stylus').defaultPrevented).toBe(false)
    expect(touchstart(element, 'direct').defaultPrevented).toBe(false)
    expect(active.blur).toHaveBeenCalledTimes(3)
  })

  it('leaves the focus on the body alone', () => {
    const map = drawingMap()
    const handle = createHandwriting(map, { store: new StrokeStore() })
    const body = Object.assign(new (globalThis as unknown as { HTMLElement: new () => object }).HTMLElement(), {
      blur: vi.fn(),
    })
    vi.stubGlobal('document', { activeElement: body, body })
    handle.setTool('lasso')
    expect(touchstart(map.getCanvasContainer(), 'stylus').defaultPrevented).toBe(true)
    expect(body.blur).not.toHaveBeenCalled()
    handle.destroy()
  })
})
