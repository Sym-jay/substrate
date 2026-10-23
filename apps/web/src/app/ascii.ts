// The ASCII look: a character ramp from empty to dense, and ordered
// dithering so tones blend between its steps.

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

// A frame of the shimmer that sweeps across something running: a slanted
// band of glyphs, `phase` (0 to 1) of the way across.
export function shimmerFrame(cols: number, rows: number, phase: number) {
  const band = Math.max(5, cols * 0.06)
  const pos = -band * 3 + phase * (cols + band * 6)
  const lines: string[] = []
  for (let y = 0; y < rows; y++) {
    let line = ''
    for (let x = 0; x < cols; x++) {
      const d = (x - pos + (y - rows / 2) * 1.5) / band
      line += Math.abs(d) > 2.5 ? ' ' : glyph(Math.exp(-d * d * 1.4) * 0.62, x, y)
    }
    lines.push(line.trimEnd())
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
