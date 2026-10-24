import { useMemo } from 'react'

// 4×4 Bayer thresholds: the order a cell's dots come in as it darkens.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
// Dots across the mark, and how finely each one's coverage is sampled.
const CELLS = 56
const SAMPLE = 4
const drawn = new Map<string, string>()

// The dots for a 24×24 path, as one path of squares, shaded like a dithered
// picture: the mark's ink dense, what it encloses (Tux's belly) light, and
// all of it lighter towards the top left. Never quite solid.
function dots(d: string): string {
  const known = drawn.get(d)
  if (known !== undefined) return known
  const size = CELLS * SAMPLE
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.scale(size / 24, size / 24)
  ctx.fill(new Path2D(d))
  const alpha = ctx.getImageData(0, 0, size, size).data
  // What a flood from the edges reaches is outside; the rest is the mark or
  // enclosed by it.
  const outside = new Uint8Array(size * size)
  const stack: number[] = []
  for (let i = 0; i < size; i++) stack.push(i, (size - 1) * size + i, i * size, i * size + size - 1)
  while (stack.length) {
    const i = stack.pop()!
    if (outside[i] || alpha[i * 4 + 3]! >= 128) continue
    outside[i] = 1
    const x = i % size
    if (x > 0) stack.push(i - 1)
    if (x < size - 1) stack.push(i + 1)
    if (i >= size) stack.push(i - size)
    if (i < size * (size - 1)) stack.push(i + size)
  }
  const ink = new Float32Array(CELLS * CELLS)
  const inside = new Float32Array(CELLS * CELLS)
  for (let y = 0; y < CELLS; y++) {
    for (let x = 0; x < CELLS; x++) {
      for (let sy = 0; sy < SAMPLE; sy++) {
        for (let sx = 0; sx < SAMPLE; sx++) {
          const i = (y * SAMPLE + sy) * size + x * SAMPLE + sx
          ink[y * CELLS + x]! += alpha[i * 4 + 3]! / 255 / (SAMPLE * SAMPLE)
          inside[y * CELLS + x]! += (1 - outside[i]!) / (SAMPLE * SAMPLE)
        }
      }
    }
  }
  // A mark that's mostly ink (Windows' four panes) is drawn lighter, so it
  // weighs about the same as one that isn't (Tux).
  let inked = 0
  let area = 0
  for (let c = 0; c < ink.length; c++) { inked += ink[c]!; area += inside[c]! }
  const weight = Math.min(1, Math.max(0.6, 0.55 / (inked / (area || 1))))
  let out = ''
  for (let y = 0; y < CELLS; y++) {
    for (let x = 0; x < CELLS; x++) {
      const c = y * CELLS + x
      const shade = 0.55 + 0.45 * ((x + y) / (2 * (CELLS - 1)))
      const level = (ink[c]! * 0.9 * weight + Math.max(0, inside[c]! - ink[c]!) * 0.22) * shade
      if (level > (BAYER[(y % 4) * 4 + (x % 4)]! + 0.5) / 16) out += `M${x} ${y}h1v1h-1z`
    }
  }
  drawn.set(d, out)
  return out
}

// A mark drawn large in ordered-dither dots, in currentColor, for the
// background of a card. Size it in whole multiples of 56px so the dots stay
// square.
export function DitherMark({ d, className = '' }: { d: string; className?: string }) {
  const path = useMemo(() => (typeof document === 'undefined' ? '' : dots(d)), [d])
  return (
    <svg viewBox={`0 0 ${CELLS} ${CELLS}`} shapeRendering="crispEdges" fill="currentColor" aria-hidden className={`dither-mark ${className}`}>
      <path d={path} />
    </svg>
  )
}
