import { describe, expect, it } from 'vitest'
import { LaserChannel, MAX_LASER_TRAIL, type LaserOp, type LaserOrigin } from '../src/core/laser'

describe('LaserChannel', () => {
  it('gives trail numbers that do not repeat to everyone sharing the channel', () => {
    const channel = new LaserChannel()
    // Two handles on the same channel take turns
    const a = [channel.nextTrail(), channel.nextTrail()]
    const b = [channel.nextTrail(), channel.nextTrail()]
    expect(new Set([...a, ...b]).size).toBe(4)
  })

  it('wraps the trail numbers around within what the protocol accepts', () => {
    const channel = new LaserChannel()
    ;(channel as unknown as { trail: number }).trail = MAX_LASER_TRAIL
    expect(channel.nextTrail()).toBe(MAX_LASER_TRAIL)
    expect(channel.nextTrail()).toBe(0)
  })

  it('passes each op with its origin to the subscribers until they stop', () => {
    const channel = new LaserChannel()
    const got: [LaserOp, LaserOrigin][] = []
    const stop = channel.subscribe((op, origin) => got.push([op, origin]))
    const op: LaserOp = { source: '', trail: 0, pts: [[0.5, 0.5]] }
    channel.emit(op, 'local')
    stop()
    channel.emit(op, 'remote')
    expect(got).toEqual([[op, 'local']])
  })
})
