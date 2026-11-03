import { describe, expect, it } from 'vitest'
import { PenOnlyInput } from '../src/penOnly'

const pen = { pointerId: 2, pointerType: 'pen' }
const mouse = { pointerId: 1, pointerType: 'mouse' }
const touch = { pointerId: 7, pointerType: 'touch' }
const touch2 = { pointerId: 8, pointerType: 'touch' }

describe('PenOnlyInput', () => {
  it('leaves touch to the map as soon as the setting is on, before any pen has been used', () => {
    const input = new PenOnlyInput(() => true)
    expect(input.active).toBe(true)
    expect(input.accepts(touch)).toBe(false)
    expect(input.accepts(pen)).toBe(true)
    expect(input.accepts(mouse)).toBe(true)
    expect(input.touchFree).toBe(true)
  })

  it('does nothing while the setting is off, and applies as soon as it is turned on', () => {
    let enabled = false
    const input = new PenOnlyInput(() => enabled)
    input.down(pen, true)
    expect(input.active).toBe(false)
    expect(input.accepts(touch)).toBe(true)
    expect(input.touchFree).toBe(false)
    input.up(pen)
    expect(input.touchFree).toBe(false)
    enabled = true
    expect(input.accepts(touch)).toBe(false)
    expect(input.touchFree).toBe(true)
    enabled = false
    expect(input.accepts(touch)).toBe(true)
  })

  it('keeps touch from the map while a pen or mouse presses with a tool, so a palm cannot move the map under a stroke', () => {
    const input = new PenOnlyInput(() => true)
    input.down(pen, true)
    expect(input.touchFree).toBe(false)
    // A touch landing meanwhile neither draws nor frees the map
    input.down(touch, true)
    expect(input.touchFree).toBe(false)
    input.up(touch)
    input.down(mouse, true)
    input.up(pen)
    expect(input.touchFree).toBe(false)
    input.up(mouse)
    expect(input.touchFree).toBe(true)
    // A press with no tool selected keeps nothing
    input.down(pen, false)
    expect(input.touchFree).toBe(true)
  })

  it('names the touches still pressed when a pen lands, so their strokes can be let go of', () => {
    let enabled = false
    const input = new PenOnlyInput(() => enabled)
    // A touch that pressed while the setting was off may be drawing
    expect(input.down(touch, true)).toEqual([])
    enabled = true
    expect(input.down(pen, true)).toEqual([touch.pointerId])
    input.up(pen)
    // Once the touch is up there is nothing left to let go of
    input.up(touch)
    expect(input.down(pen, true)).toEqual([])
  })

  it('lets go of no touch when the setting is off or the pointer is not a pen', () => {
    let enabled = false
    const input = new PenOnlyInput(() => enabled)
    input.down(touch, true)
    expect(input.down(pen, true)).toEqual([])
    enabled = true
    expect(input.down(mouse, true)).toEqual([])
  })

  it('lists the touch pointers pressed now', () => {
    const input = new PenOnlyInput(() => false)
    expect(input.pressedTouches()).toEqual([])
    input.down(touch, true)
    input.down(touch2, false)
    input.down(pen, true)
    input.down(mouse, true)
    expect(input.pressedTouches()).toEqual([touch.pointerId, touch2.pointerId])
    input.up(touch)
    input.up({ pointerId: touch2.pointerId, pointerType: 'touch' })
    expect(input.pressedTouches()).toEqual([])
  })
})
