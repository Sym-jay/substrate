import { useEffect, useRef } from 'react'

// A 4×4 ordered-dither (Bayer) matrix: each dot's threshold, 0 to 1.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16)
// A dot, and the gap after it, in CSS pixels.
const DOT = 2
const GAP = 1
const STEP = DOT + GAP

// A meter in ordered-dither dots: dense blue for `share` (0 to 1) of it,
// thinning out over its edge, and sparse grey dots for the rest.
export function DitherMeter({ share, label, now, max, rows = 4 }: { share: number; label: string; now: number; max: number; rows?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvas.current
    const ctx = cv?.getContext('2d')
    if (!cv || !ctx) return
    const style = getComputedStyle(cv)
    const blue = style.getPropertyValue('--accent').trim() || '#2b5cff'
    const grey = style.getPropertyValue('--line-strong').trim() || 'rgba(0, 0, 0, 0.36)'
    const fill = Math.min(1, Math.max(0, share))
    const height = rows * STEP - GAP

    const draw = (width: number) => {
      const cols = Math.floor((width + GAP) / STEP)
      const end = fill * cols
      const edge = Math.max(3, cols * 0.08)
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      ctx.clearRect(0, 0, width, height)
      for (let x = 0; x < cols; x++) {
        // How blue: all of it inside the share, none past its edge.
        const v = Math.min(1, Math.max(0, (end - x) / edge + 0.5))
        for (let y = 0; y < rows; y++) {
          const threshold = BAYER[(y % 4) * 4 + (x % 4)]!
          if (v > threshold) ctx.fillStyle = blue
          else if (threshold < 0.25) ctx.fillStyle = grey
          else continue
          ctx.fillRect(x * STEP, y * STEP, DOT, DOT)
        }
      }
    }
    const resize = () => {
      const width = cv.parentElement?.clientWidth ?? 0
      cv.width = Math.round(width * devicePixelRatio)
      cv.height = Math.round(height * devicePixelRatio)
      cv.style.height = `${height}px`
      draw(width)
    }
    const sized = new ResizeObserver(resize)
    if (cv.parentElement) sized.observe(cv.parentElement)
    resize()
    return () => sized.disconnect()
  }, [share, rows])

  return (
    <div className="dither-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={now}>
      <canvas ref={canvas} aria-hidden />
    </div>
  )
}
