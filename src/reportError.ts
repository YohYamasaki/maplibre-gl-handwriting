import type { Map as MapLibreMap } from 'maplibre-gl'

/**
 * Reports that the layer `layerId` failed to load (the WebAssembly module, the tessellation worker or the worker's
 * script or module) as the map's error event, `{ error, layerId }`. MapLibre logs an error event no one listens for;
 * this one it would not, so then it goes to the console here
 */
export function reportError(map: MapLibreMap, error: Error, layerId: string): void {
  if (map.listens('error')) map.fire('error', { error, layerId })
  else console.error(error)
}

/** What was thrown or rejected with, as an Error */
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
