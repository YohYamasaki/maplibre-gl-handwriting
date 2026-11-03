// Frames per second from requestAnimationFrame, and the average CPU and GPU times of the strokes' drawing, over the
// last second (decision 0089)

const WINDOW_MS = 1000
/** How often the numbers are reported */
const REPORT_MS = 250

export type FrameStats = {
  fps: number
  /** Average ms over the window, or null when there was no sample */
  cpu: number | null
  gpu: number | null
}

type Sample = { at: number; ms: number }

export class FrameMeter {
  private frames: number[] = []
  private cpu: Sample[] = []
  private gpu: Sample[] = []
  private request = 0
  private reportedAt = 0

  constructor(private readonly onReport: (stats: FrameStats) => void) {
    this.request = requestAnimationFrame(this.tick)
  }

  addCpu(ms: number): void {
    this.cpu.push({ at: performance.now(), ms })
  }

  addGpu(ms: number): void {
    this.gpu.push({ at: performance.now(), ms })
  }

  /** Forgets the samples so far, e.g. when what is measured changes */
  clear(): void {
    this.cpu = []
    this.gpu = []
  }

  destroy(): void {
    cancelAnimationFrame(this.request)
  }

  private readonly tick = (now: number): void => {
    this.frames.push(now)
    const since = now - WINDOW_MS
    while (this.frames.length > 0 && this.frames[0] < since) this.frames.shift()
    if (now - this.reportedAt >= REPORT_MS) {
      this.reportedAt = now
      this.onReport({ fps: this.frames.length, cpu: average(this.cpu, since), gpu: average(this.gpu, since) })
    }
    this.request = requestAnimationFrame(this.tick)
  }
}

/** Drops the samples older than `since` and averages the rest */
function average(samples: Sample[], since: number): number | null {
  while (samples.length > 0 && samples[0].at < since) samples.shift()
  if (samples.length === 0) return null
  return samples.reduce((sum, sample) => sum + sample.ms, 0) / samples.length
}
