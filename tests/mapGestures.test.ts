import { describe, expect, it } from 'vitest'
import { claimMapGestures, POINTER_HANDLERS, TOUCH_HANDLERS, type GestureMap } from '../src/mapGestures'

type FakeMap = GestureMap & {
  enabled: Set<string>
  canvas: { style: { cursor: string; touchAction: string } }
  container: { style: { cursor: string } }
}

function fakeMap(disabled: string[] = []): FakeMap {
  const enabled = new Set<string>(POINTER_HANDLERS.filter((name) => !disabled.includes(name)))
  const handler = (name: string): { isEnabled(): boolean; enable(): void; disable(): void } => ({
    isEnabled: () => enabled.has(name),
    enable: () => void enabled.add(name),
    disable: () => void enabled.delete(name),
  })
  const canvas = { style: { cursor: 'grab', touchAction: '' } }
  const container = { style: { cursor: '' } }
  const map = { enabled, canvas, container, getCanvas: () => canvas, getCanvasContainer: () => container } as Record<
    string,
    unknown
  >
  for (const name of POINTER_HANDLERS) map[name] = handler(name)
  return map as unknown as FakeMap
}

describe('claimMapGestures', () => {
  it('keeps the gestures off and the crosshair while another handle on the map still holds a tool', () => {
    const map = fakeMap()
    const a = claimMapGestures(map)
    const b = claimMapGestures(map)
    a.release()
    expect(map.enabled.size).toBe(0)
    expect(map.canvas.style.cursor).toBe('crosshair')
    // With MapLibre's touch gestures off its stylesheet would leave touch-action at auto, and the browser would
    // cancel a vertical touch or pen drag mid-stroke to scroll
    expect(map.canvas.style.touchAction).toBe('none')
    b.release()
    expect([...map.enabled].sort()).toEqual([...POINTER_HANDLERS].sort())
    expect(map.canvas.style.cursor).toBe('grab')
    expect(map.canvas.style.touchAction).toBe('')
  })

  it('gives back only the gestures it turned off, and releasing twice counts once', () => {
    const map = fakeMap(['boxZoom'])
    const a = claimMapGestures(map)
    const b = claimMapGestures(map)
    a.release()
    a.release()
    expect(map.enabled.size).toBe(0)
    b.release()
    expect(map.enabled.has('boxZoom')).toBe(false)
    expect(map.enabled.has('dragPan')).toBe(true)
  })

  it('gives touch its gestures back only while every claim on the map lets it', () => {
    const map = fakeMap()
    const a = claimMapGestures(map)
    const b = claimMapGestures(map)
    a.setTouchFree(true)
    expect(map.enabled.size).toBe(0)
    b.setTouchFree(true)
    expect([...map.enabled].sort()).toEqual([...TOUCH_HANDLERS].sort())
    expect(map.canvas.style.cursor).toBe('crosshair')
    // A pen pressed with a tool takes touch away again
    b.setTouchFree(false)
    expect(map.enabled.size).toBe(0)
    b.setTouchFree(true)
    // The other claim still lets touch, so releasing this one leaves the touch gestures on
    b.release()
    expect([...map.enabled].sort()).toEqual([...TOUCH_HANDLERS].sort())
    a.setTouchFree(false)
    expect(map.enabled.size).toBe(0)
    a.release()
    expect([...map.enabled].sort()).toEqual([...POINTER_HANDLERS].sort())
  })

  it('never turns on a touch gesture the map had off before the first claim', () => {
    const map = fakeMap(['touchPitch'])
    const claim = claimMapGestures(map)
    claim.setTouchFree(true)
    expect([...map.enabled].sort()).toEqual(['dragPan', 'touchZoomRotate'])
    claim.release()
    expect(map.enabled.has('touchPitch')).toBe(false)
  })

  it('does nothing for a claim already released', () => {
    const map = fakeMap()
    const a = claimMapGestures(map)
    const b = claimMapGestures(map)
    b.setTouchFree(true)
    a.release()
    a.setTouchFree(true)
    expect([...map.enabled].sort()).toEqual([...TOUCH_HANDLERS].sort())
    b.release()
  })

  it('shows the cursor of the claim that set one last, on the canvas and its container, until the last release', () => {
    const map = fakeMap()
    const a = claimMapGestures(map)
    expect(map.container.style.cursor).toBe('crosshair')
    const b = claimMapGestures(map)
    a.setCursor('default')
    expect(map.canvas.style.cursor).toBe('default')
    expect(map.container.style.cursor).toBe('default')
    b.setCursor('crosshair')
    expect(map.canvas.style.cursor).toBe('crosshair')
    a.setCursor('nwse-resize')
    expect(map.container.style.cursor).toBe('nwse-resize')
    // Releasing the one shown falls back to the other's
    a.release()
    expect(map.canvas.style.cursor).toBe('crosshair')
    expect(map.container.style.cursor).toBe('crosshair')
    b.setCursor('grab')
    expect(map.container.style.cursor).toBe('grab')
    b.release()
    expect(map.canvas.style.cursor).toBe('grab')
    expect(map.container.style.cursor).toBe('')
    // A released claim no longer sets one
    b.setCursor('move')
    expect(map.container.style.cursor).toBe('')
  })
})
