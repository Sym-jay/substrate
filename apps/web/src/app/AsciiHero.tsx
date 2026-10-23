import { useEffect, useRef, type ReactNode } from 'react'
import { fbm, glyph, reducedMotion } from './ascii.ts'

const FONT_PX = 12
const LINE_PX = 13
const FPS = 24

// The top of Home: soft organic shapes drifting and morphing, drawn in
// dithered ASCII. It leans towards the pointer a little, pauses when it's off
// screen or the tab is hidden, and holds still if motion is reduced.
export function AsciiHero({ children }: { children?: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const box = frame.current
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!box || !el || !ctx) return
    let cols = 0, rows = 0, charW = 7
    let visible = true
    let raf = 0, last = 0
    const pointer = { x: -1, y: -1, strength: 0 }
    const started = performance.now()
    const styles = getComputedStyle(document.documentElement)

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const { width, height } = box.getBoundingClientRect()
      el.width = Math.round(width * dpr)
      el.height = Math.round(height * dpr)
      el.style.width = `${width}px`
      el.style.height = `${height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `${FONT_PX}px ${styles.getPropertyValue('--font-mono') || 'monospace'}`
      ctx.textBaseline = 'top'
      charW = ctx.measureText('M').width || 7
      cols = Math.ceil(width / charW)
      rows = Math.ceil(height / LINE_PX)
      draw(performance.now())
    }

    const draw = (now: number) => {
      const t = (now - started) / 1000
      const ink = getComputedStyle(box).getPropertyValue('--hero-ink').trim() || '#e8e8e8'
      const dim = getComputedStyle(box).getPropertyValue('--hero-dim').trim() || '#555'
      ctx.clearRect(0, 0, el.width, el.height)
      const aspect = LINE_PX / charW
      for (let y = 0; y < rows; y++) {
        let bright = '', soft = ''
        for (let x = 0; x < cols; x++) {
          // Domain-warped noise: petals that fold into each other as they drift.
          const px = (x / cols) * 2.4, py = (y / rows) * 2.4 * (rows / cols) * aspect
          const qx = fbm(px + t * 0.05, py, t * 0.04, 3)
          const qy = fbm(px + 5.2, py + 1.3 - t * 0.04, t * 0.04, 3)
          let v = fbm(px + 2.6 * qx, py + 2.6 * qy, t * 0.06, 4)
          v = Math.min(1, Math.max(0, (v - 0.48) * 3.1))
          // Fade out towards the edges, so the shapes sit in the frame.
          const ex = Math.min(x, cols - 1 - x) / (cols * 0.12), ey = Math.min(y, rows - 1 - y) / (rows * 0.2)
          v *= Math.min(1, ex) * Math.min(1, ey)
          if (pointer.strength > 0) {
            const dx = (x - pointer.x) / 16, dy = ((y - pointer.y) * aspect) / 16
            v += pointer.strength * 0.45 * Math.exp(-(dx * dx + dy * dy))
          }
          const ch = glyph(v, x, y)
          const dense = v > 0.58
          bright += dense ? ch : ' '
          soft += dense ? ' ' : ch
        }
        ctx.fillStyle = dim
        ctx.fillText(soft, 0, y * LINE_PX)
        ctx.fillStyle = ink
        ctx.fillText(bright, 0, y * LINE_PX)
      }
    }

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (!visible || document.hidden || now - last < 1000 / FPS) return
      last = now
      pointer.strength *= 0.94
      draw(now)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(box)
    const seen = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting })
    seen.observe(box)
    const move = (e: PointerEvent) => {
      const r = box.getBoundingClientRect()
      pointer.x = (e.clientX - r.left) / charW
      pointer.y = (e.clientY - r.top) / LINE_PX
      pointer.strength = 1
    }
    box.addEventListener('pointermove', move)
    if (!reducedMotion()) raf = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      seen.disconnect()
      box.removeEventListener('pointermove', move)
    }
  }, [])

  return (
    <div ref={frame} className="ascii-hero">
      <canvas ref={canvas} aria-hidden />
      {children}
    </div>
  )
}
