import { useEffect, useRef, type ReactNode } from 'react'
import { RAMP, glyph, reducedMotion } from './ascii.ts'

// Columns of dashes: one every STEP_X px, a dash every STEP_Y px down it.
const STEP_X = 5
const STEP_Y = 4
// The icon, rasterised this many pixels square to read as a mask.
const MASK = 96
// How far round the pointer the streaks turn into glowing characters.
const GLOW_R = 64

// A stable random number in [0, 1) for each pair.
const hash = (a: number, b: number) => {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// A card's background: `icon` drawn large in vertical streaks of dashes that
// drift down their columns (after Cloudflare's customer-story cards). Round
// the pointer, the dashes become ASCII characters that glow, densest nearest
// it. `children` sit on top.
export function StreakArt({ icon, className = '', children }: { icon: ReactNode; className?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const source = useRef<HTMLSpanElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const redraw = useRef(() => {})

  useEffect(() => {
    const el = root.current
    const cv = canvas.current
    const svg = source.current?.querySelector('svg')
    const ctx = cv?.getContext('2d')
    if (!el || !cv || !svg || !ctx) return
    const still = reducedMotion()
    let mask: Float32Array | null = null
    let width = 0
    let height = 0
    let t = 0

    const draw = () => {
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = '#ffffff'
      // The icon: centred across, above the words, and fading out where they start.
      const size = Math.min(width * 0.62, height * 0.42)
      const ox = (width - size) / 2
      const oy = height * 0.16
      const fadeFrom = height * 0.5
      const p = pointer.current
      const glow: [number, number, string, number][] = []
      for (let col = 0, x = 1; x < width; col++, x += STEP_X) {
        const offset = t * (0.25 + hash(col, 7) * 0.9)
        for (let k = Math.floor(offset / STEP_Y); ; k++) {
          const y = k * STEP_Y - offset
          if (y > height) break
          const u = (x - ox) / size
          const v = (y - oy) / size
          const m = mask && u >= 0 && u < 1 && v >= 0 && v < 1 ? mask[Math.floor(v * MASK) * MASK + Math.floor(u * MASK)]! : 0
          const n = hash(col, k)
          // The icon's dashes, and a sparse field around it.
          const fade = y < fadeFrom ? 1 : Math.max(0.2, 1 - (y - fadeFrom) / (height * 0.14))
          const a = m > 0.1 ? (0.18 + 0.52 * m * n) * fade : n > 0.965 ? 0.12 : 0
          // Near the pointer: a glowing character instead, on every other row.
          const near = p ? 1 - Math.hypot(x - p.x, y - p.y) / GLOW_R : 0
          if (near > 0) {
            if (k % 2) continue
            const level = Math.min(1, a + near * near * 0.85 + (m > 0.1 ? 0.2 : 0))
            const ch = glyph(level, col, k, RAMP)
            if (ch === ' ') continue
            glow.push([x, y, ch, Math.min(1, 0.35 + level)])
            continue
          }
          if (a < 0.02) continue
          ctx.globalAlpha = a
          ctx.fillRect(x, y, 2, STEP_Y - 1 + (n > 0.72 ? 3 : 0))
        }
      }
      // The characters last, so their glow sits over the dashes.
      if (glow.length) {
        ctx.font = `9px ${getComputedStyle(el).getPropertyValue('--font-mono') || 'monospace'}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.shadowColor = 'rgba(255, 255, 255, 0.85)'
        ctx.shadowBlur = 6
        for (const [gx, gy, ch, ga] of glow) {
          ctx.globalAlpha = ga
          ctx.fillText(ch, gx + 1, gy)
        }
        ctx.shadowBlur = 0
      }
      ctx.globalAlpha = 1
    }
    redraw.current = draw

    const resize = () => {
      width = el.clientWidth
      height = el.clientHeight
      cv.width = Math.round(width * devicePixelRatio)
      cv.height = Math.round(height * devicePixelRatio)
      draw()
    }
    const sized = new ResizeObserver(resize)
    sized.observe(el)
    resize()

    // The icon as a mask: its SVG, white and a little bolder, rasterised.
    const markup = new XMLSerializer().serializeToString(svg)
      .replace(/currentColor/g, '#ffffff')
      .replace(/stroke-width="[^"]*"/, 'stroke-width="2.4"')
      .replace(/width="24" height="24"/, `width="${MASK}" height="${MASK}"`)
    const img = new Image()
    img.onload = () => {
      const off = document.createElement('canvas')
      off.width = MASK
      off.height = MASK
      const o = off.getContext('2d')
      if (!o) return
      o.drawImage(img, 0, 0, MASK, MASK)
      const data = o.getImageData(0, 0, MASK, MASK).data
      mask = new Float32Array(MASK * MASK)
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]! / 255
      draw()
    }
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`

    if (still) return () => sized.disconnect()
    let visible = true
    const seen = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting })
    seen.observe(el)
    const timer = window.setInterval(() => {
      if (!visible || document.hidden) return
      t++
      draw()
    }, 50)
    return () => { clearInterval(timer); seen.disconnect(); sized.disconnect() }
  }, [])

  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top }
    if (reducedMotion()) redraw.current()
  }
  const leave = () => {
    pointer.current = null
    if (reducedMotion()) redraw.current()
  }

  return (
    <div ref={root} className={`streak-art ${className}`} onPointerMove={point} onPointerLeave={leave}>
      <canvas ref={canvas} className="streak-canvas" aria-hidden />
      <span ref={source} className="streak-source" aria-hidden>{icon}</span>
      {children}
    </div>
  )
}
