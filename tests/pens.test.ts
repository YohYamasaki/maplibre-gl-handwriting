import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, PenSettings, strokeColor, type PenTool } from '../src/pens'

describe('PenSettings', () => {
  it('starts from the library defaults: a black pen and a yellow 50% highlighter', () => {
    const settings = new PenSettings()
    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
    expect(strokeColor(settings.pen('pen'))).toBe('#000000')
    expect(strokeColor(settings.pen('highlighter'))).toBe('#ffeb3b80')
    expect(settings.pen('highlighter').width).toBe(16)
  })

  it('takes the given defaults and keeps the library default for every field left out', () => {
    const settings = new PenSettings({ pens: { highlighter: { width: 24 } }, eraser: { radius: 12 } })
    expect(settings.pen('highlighter')).toEqual({ ...DEFAULT_SETTINGS.pens.highlighter, width: 24 })
    expect(settings.pen('pen')).toEqual(DEFAULT_SETTINGS.pens.pen)
    expect(settings.eraserRadius()).toBe(12)
    expect(settings.get().palette).toEqual(DEFAULT_SETTINGS.palette)
  })

  it('keeps a pen of its own for each tool', () => {
    const settings = new PenSettings()
    settings.setPen('pen', { color: '#E53935', width: 8 })
    expect(settings.pen('pen')).toMatchObject({ color: '#e53935', width: 8 })
    expect(settings.pen('highlighter')).toEqual(DEFAULT_SETTINGS.pens.highlighter)
  })

  it('gives back the same state from the settings it reported, passed as defaults', () => {
    let reported = new PenSettings().get()
    const settings = new PenSettings({}, () => (reported = settings.get()))
    settings.setPen('highlighter', { color: '#00ff00', opacity: 0.3, pressure: true })
    settings.setPalette(['#111111', '#222222', '#333333', '#444444', '#555555'])
    settings.setEraser({ radius: 20 })
    expect(new PenSettings(JSON.parse(JSON.stringify(reported))).get()).toEqual(settings.get())
  })

  it('reports each change once, with the pen that changed, and nothing for a call that changes nothing', () => {
    const changes: { pen?: PenTool }[] = []
    const settings = new PenSettings({}, (changed) => changes.push(changed))
    settings.setPen('pen', { width: 4 })
    settings.setPalette([...DEFAULT_SETTINGS.palette])
    settings.setEraser({ radius: 6 })
    expect(changes).toEqual([])
    settings.setPen('highlighter', { width: 10 })
    settings.setEraser({ radius: 7 })
    expect(changes).toEqual([{ pen: 'highlighter' }, {}])
  })

  it('clamps numbers to the ranges the protocol accepts', () => {
    const settings = new PenSettings()
    settings.setPen('pen', { width: 1000, opacity: 0 })
    expect(settings.pen('pen')).toMatchObject({ width: 64, opacity: 0.13 })
    settings.setPen('pen', { width: 0 })
    expect(settings.pen('pen').width).toBe(0.5)
    settings.setEraser({ radius: -5 })
    expect(settings.eraserRadius()).toBe(1)
  })

  it('refuses a color that is not #rrggbb, a palette of the wrong size and a number that is NaN', () => {
    const settings = new PenSettings()
    expect(() => settings.setPen('pen', { color: '#ff000080' })).toThrow(RangeError)
    expect(() => settings.setPen('pen', { color: 'red' })).toThrow(RangeError)
    expect(() => settings.setPen('pen', { width: NaN })).toThrow(RangeError)
    expect(() => settings.setPalette(['#000000'])).toThrow(RangeError)
    expect(() => new PenSettings({ palette: ['#000000', '#000000', '#000000', '#000000', 'blue'] })).toThrow(RangeError)
    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the toolbar placement: checked, clamped, reported once per change and restored from defaults', () => {
    const changes: { pen?: PenTool }[] = []
    const settings = new PenSettings({ toolbar: { edge: 'left' } }, (changed) => changes.push(changed))
    expect(settings.get().toolbar).toEqual({ ...DEFAULT_SETTINGS.toolbar, edge: 'left' })
    settings.setToolbar({ edge: 'left' })
    expect(changes).toEqual([])
    settings.setToolbar({ offset: 2, collapsed: true })
    expect(settings.get().toolbar).toEqual({ edge: 'left', offset: 1, collapsed: true })
    expect(changes).toEqual([{}])
    expect(() => settings.setToolbar({ edge: 'middle' as 'top' })).toThrow(RangeError)
    expect(() => new PenSettings({ toolbar: { offset: NaN } })).toThrow(RangeError)
    expect(new PenSettings(JSON.parse(JSON.stringify(settings.get()))).get()).toEqual(settings.get())
  })

  it('does not let a caller change its state through what it returns', () => {
    const settings = new PenSettings()
    const copy = settings.get()
    copy.pens.pen.width = 30
    copy.palette[0] = '#ffffff'
    settings.pen('pen').width = 30
    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('strokeColor', () => {
  it('gives #rrggbb for an opaque pen and #rrggbbaa otherwise', () => {
    for (const opacity of [0.13, 0.2, 0.5, 0.99]) {
      expect(strokeColor({ color: '#336699', opacity, width: 4, pressure: false }), `opacity ${opacity}`).toMatch(/^#336699[0-9a-f]{2}$/)
    }
    expect(strokeColor({ color: '#336699', opacity: 1, width: 4, pressure: false })).toBe('#336699')
  })

  it('keeps pen-only input off by default, takes it from the defaults, and reports a change once', () => {
    expect(new PenSettings().penOnly()).toBe(false)
    let changes = 0
    const settings = new PenSettings({ penOnly: true }, () => changes++)
    expect(settings.penOnly()).toBe(true)
    settings.setPenOnly(true)
    expect(changes).toBe(0)
    settings.setPenOnly(false)
    expect(changes).toBe(1)
    expect(new PenSettings(JSON.parse(JSON.stringify(settings.get()))).get()).toEqual(settings.get())
  })
})

describe('PenSettings pressure curve', () => {
  it('takes the curve from the defaults, clamped, and reports it with the settings', () => {
    expect(new PenSettings().pressureCurve()).toEqual({ min: 0.25, gamma: 0.7 })
    const settings = new PenSettings({ pressure: { min: 0, gamma: 9 } })
    expect(settings.pressureCurve()).toEqual({ min: 0.05, gamma: 5 })
    expect(new PenSettings(settings.get()).pressureCurve()).toEqual({ min: 0.05, gamma: 5 })
    expect(new PenSettings({ pressure: { gamma: 0.1 } }).pressureCurve()).toEqual({ min: 0.25, gamma: 0.2 })
    expect(() => new PenSettings({ pressure: { min: Number.NaN } })).toThrow(RangeError)
  })
})

describe('PenSettings eraser mode', () => {
  it('erases whole strokes by default, and keeps the mode it is given', () => {
    expect(new PenSettings().eraserMode()).toBe('stroke')
    const settings = new PenSettings({ eraser: { mode: 'partial' } }, undefined, true)
    expect(settings.eraserMode()).toBe('partial')
    expect(settings.eraserRadius()).toBe(DEFAULT_SETTINGS.eraser.radius)
  })

  it('reports a change of mode, and refuses an unknown one', () => {
    const changes: unknown[] = []
    const settings = new PenSettings({}, (changed) => changes.push(changed), true)
    settings.setEraser({ mode: 'stroke' })
    expect(changes).toEqual([])
    settings.setEraser({ mode: 'partial' })
    expect(changes).toEqual([{}])
    expect(() => settings.setEraser({ mode: 'pixel' as never })).toThrow(RangeError)
    expect(() => new PenSettings({ eraser: { mode: 'pixel' as never } })).toThrow(RangeError)
  })

  it('refuses the partial eraser unless it is turned on, and starts a saved partial eraser as whole strokes', () => {
    const changes: unknown[] = []
    const settings = new PenSettings({}, (changed) => changes.push(changed))
    expect(() => settings.setEraser({ mode: 'partial' })).toThrow(RangeError)
    expect(settings.eraserMode()).toBe('stroke')
    expect(changes).toEqual([])
    const saved = new PenSettings({ eraser: { mode: 'partial', radius: 30 } })
    expect(saved.eraserMode()).toBe('stroke')
    expect(saved.eraserRadius()).toBe(30)
  })
})

describe('PenSettings laser', () => {
  it('draws the laser in #ff3b30 by default, takes its color from the defaults, and keeps it with the settings', () => {
    expect(new PenSettings().laserColor()).toBe('#ff3b30')
    expect(DEFAULT_SETTINGS.laser).toEqual({ color: '#ff3b30' })
    const settings = new PenSettings({ laser: { color: '#00AAFF' } })
    expect(settings.laserColor()).toBe('#00aaff')
    expect(new PenSettings(JSON.parse(JSON.stringify(settings.get()))).laserColor()).toBe('#00aaff')
  })

  it('refuses a laser color that is not #rrggbb', () => {
    for (const color of ['red', '#ff3b3080', '#ff3b3', 7]) {
      expect(() => new PenSettings({ laser: { color: color as string } })).toThrow(RangeError)
    }
  })
})
