// The IDs of the strokes a handle makes when HandwritingOptions.startStroke is omitted (decision 0008)

/**
 * A random UUID v4 (lowercase 8-4-4-4-12), made from crypto.getRandomValues. crypto.randomUUID would give the same
 * shape, but only on a secure context: on a page served over http from another host than localhost it is undefined
 */
export function randomStrokeId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  // Version 4 in the high nibble of byte 6, variant 10xx in the high bits of byte 8 (RFC 9562)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
