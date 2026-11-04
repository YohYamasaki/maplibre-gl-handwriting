// The tools a handle offers (HandwritingOptions.tools), without a browser: setTool, getTools, the keyboard shortcuts
// on the window and the tools given to the shortcut list. createHandwriting's DOM parts are stand-ins here
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrokeStore } from '../src/core/stroke'
import { createHandwriting, type Tool } from '../src/createHandwriting'
import { StrokeTessellator } from '../src/StrokeTessellator'
import { FakeWorker, handwritingMap } from './layerFakes'
import { fakeWriter } from './support'

const lists = vi.hoisted(() => ({ tools: [] as unknown[] }))

vi.mock('../src/ui/cursor', () => ({ EraserCursor: class { show(): void {} hide(): void {} destroy(): void {} } }))
vi.mock('../src/ui/selection', () => ({
  SelectionFrame: class { update(): void {} showLasso(): void {} destroy(): void {} },
}))
vi.mock('../src/ui/laser', () => ({ LaserOverlay: class { destroy(): void {} } }))
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
function keydown(key: string): Event {
  const event = Object.assign(new Event('keydown', { cancelable: true }), {
    key,
    ctrlKey: false,
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
