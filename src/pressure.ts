import type { PressureCurve } from './pens'

/** Weight of the newest pressure reading in the running average that smooths a pen's pressure */
export const PRESSURE_SMOOTHING = 0.5

/**
 * A point whose width coefficient differs from the last kept point's by this much or more is kept though it is closer
 * than the spacing, so a quick change of pressure is not thinned away: by DrawController, which records the input,
 * and by appendSamples, which samples a stroke's points
 */
export const PRESSURE_STEP = 0.1

/** Steps a width coefficient is rounded to: 1/255 */
const PRESSURE_LEVELS = 255

/**
 * A width coefficient as it is sent and kept: rounded to a multiple of 1/255, written with three decimals so a message
 * stays small (adjacent multiples still differ there), and never 0
 */
export function quantizePressure(coefficient: number): number {
  const level = Math.min(PRESSURE_LEVELS, Math.max(1, Math.round(coefficient * PRESSURE_LEVELS)))
  return Math.round((level / PRESSURE_LEVELS) * 1000) / 1000
}

/** The width coefficient for a smoothed pressure `p` (0 to 1), quantized: min + (1 - min) * p^gamma */
export function pressureCoefficient(p: number, curve: PressureCurve): number {
  const clamped = Math.min(1, Math.max(0, p))
  return quantizePressure(curve.min + (1 - curve.min) * clamped ** curve.gamma)
}

/** Smooths a pen's raw pressure readings and turns each into a width coefficient */
export class PressureFilter {
  private smoothed: number | null = null

  constructor(private curve: PressureCurve) {}

  /** The coefficient for the next reading `p` of the pen's pressure (PointerEvent.pressure, 0 to 1) */
  next(p: number): number {
    this.smoothed = this.smoothed === null ? p : PRESSURE_SMOOTHING * p + (1 - PRESSURE_SMOOTHING) * this.smoothed
    return pressureCoefficient(this.smoothed, this.curve)
  }
}
