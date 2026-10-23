// The ASCII look: a character ramp from empty to dense, ordered dithering so
// tones blend between its steps, and smooth noise for things to move with.

// Dot-like glyphs only: '-' and '=' line up into horizontal streaks.
export const RAMP = ' .:+*#%@'

// A 4×4 Bayer matrix, as thresholds in [0, 1).
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16)

// The character for brightness `v` (0 to 1) at cell (x, y), dithered.
export function glyph(v: number, x: number, y: number, ramp = RAMP) {
  const steps = ramp.length - 1
  const scaled = Math.min(Math.max(v, 0), 1) * steps
  const base = Math.floor(scaled)
  const i = scaled - base > BAYER[(y & 3) * 4 + (x & 3)]! ? base + 1 : base
  return ramp[Math.min(i, steps)]!
}

// Smooth 3D value noise (x, y, and time), in [0, 1].
const perm = new Uint8Array(512)
{
  const p = Array.from({ length: 256 }, (_, i) => i)
  let seed = 1337
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647
    const j = seed % (i + 1)
    ;[p[i], p[j]] = [p[j]!, p[i]!]
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!
}
const fade = (t: number) => t * t * (3 - 2 * t)
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const hash = (x: number, y: number, z: number) => perm[(perm[(perm[x & 255]! + y) & 255]! + z) & 255]! / 255

export function noise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z)
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi)
  return lerp(
    lerp(lerp(hash(xi, yi, zi), hash(xi + 1, yi, zi), u), lerp(hash(xi, yi + 1, zi), hash(xi + 1, yi + 1, zi), u), v),
    lerp(lerp(hash(xi, yi, zi + 1), hash(xi + 1, yi, zi + 1), u), lerp(hash(xi, yi + 1, zi + 1), hash(xi + 1, yi + 1, zi + 1), u), v),
    w,
  )
}

export function fbm(x: number, y: number, z: number, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq, z * freq)
    norm += amp
    amp *= 0.5
    freq *= 2.03
  }
  return sum / norm
}

export const reducedMotion = () =>
  document.documentElement.dataset.motion === 'reduced' || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)

// A frame of the wave that runs inside a primary button while it's hovered.
export function buttonFrame(cols: number, rows: number, t: number) {
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      const v = 0.5 + 0.5 * Math.sin(x * 0.42 - y * 0.9 - t * 0.55) * Math.cos(x * 0.11 + t * 0.18)
      line += glyph(v * 0.85, x, y)
    }
    lines.push(line)
  }
  return lines.join('\n')
}

// A bar in characters: `[######====......]`.
export function bar(parts: { value: number; char: string }[], total: number, width = 32) {
  let used = 0
  let out = ''
  for (const part of parts) {
    const n = Math.max(0, Math.min(width - used, Math.round((part.value / total) * width)))
    out += part.char.repeat(n)
    used += n
  }
  return `[${out}${'.'.repeat(width - used)}]`
}

const SCRAMBLE = '!<>-_\\/[]{}=+*^?#%@'
// The label, partway through settling: characters left of `progress` are
// final, the rest random.
export function scrambled(text: string, progress: number) {
  const settled = Math.floor(text.length * progress)
  return text.split('').map((ch, i) => (i < settled || ch === ' ' ? ch : SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)])).join('')
}
