import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { reducedMotion } from './ascii.ts'

// The thumb's width (theme.css); the fill and the ticks line up with its centre.
const THUMB_PX = 14

const nearest = (stops: number[], value: number) =>
  stops.reduce((best, s, i) => (Math.abs(s - value) < Math.abs(stops[best]! - value) ? i : best), 0)

// A slider over `stops`. Dragging moves it smoothly, and letting go glides it
// to the nearest stop; the value changes as it passes each one. Arrow keys
// step a stop at a time.
export function Slider({ label, stops, value, onChange, format, tick = format, disabled = false }: {
  label: string
  stops: number[]
  value: number
  onChange: (value: number) => void
  format: (value: number) => string
  tick?: (value: number) => string
  disabled?: boolean
}) {
  const index = nearest(stops, value)
  const last = stops.length - 1
  // Where the thumb is, in stops; between them while it's dragged or gliding.
  const [pos, setPos] = useState(index)
  const at = useRef(index)
  const dragging = useRef(false)
  const frame = useRef(0)

  const place = (p: number) => { at.current = p; setPos(p) }
  const glide = (to: number) => {
    cancelAnimationFrame(frame.current)
    const from = at.current
    if (reducedMotion() || Math.abs(to - from) < 0.001) return place(to)
    const begun = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - begun) / 180)
      place(from + (to - from) * (1 - Math.pow(1 - t, 3)))
      if (t < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
  }
  const pick = (i: number) => { if (stops[i] !== value) onChange(stops[i]!) }

  // A value set from outside (a reset, Windows' fixed size) glides there too.
  useEffect(() => { if (!dragging.current && Math.round(at.current) !== index) glide(index) }, [index])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const release = () => {
    if (!dragging.current) return
    dragging.current = false
    glide(Math.round(at.current))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 2, PageDown: -2, Home: -last, End: last }
    const move = moves[e.key]
    if (move === undefined) return
    e.preventDefault()
    const next = Math.min(last, Math.max(0, Math.round(at.current) + move))
    pick(next)
    glide(next)
  }

  const across = (p: number) => `calc(${THUMB_PX / 2}px + ${p / last} * (100% - ${THUMB_PX}px))`
  return (
    <div className={`slider ${disabled ? 'is-disabled' : ''}`}>
      <div className="slider-head">
        <span>{label}</span>
        <output>{format(stops[index]!)}</output>
      </div>
      <input
        type="range" className="slider-input" min={0} max={last} step="any" value={pos} disabled={disabled}
        style={{ '--fill': across(pos) } as CSSProperties}
        aria-label={label} aria-valuetext={format(stops[index]!)}
        onPointerDown={() => { dragging.current = true; cancelAnimationFrame(frame.current) }}
        onPointerUp={release} onPointerCancel={release} onBlur={release}
        onChange={(e) => {
          const p = Number(e.target.value)
          place(p)
          pick(Math.round(p))
          // A click without a drag lands between stops; settle it.
          if (!dragging.current) glide(Math.round(p))
        }}
        onKeyDown={onKeyDown}
      />
      <div className="slider-ticks" aria-hidden>
        {stops.map((s, i) => <span key={s} style={{ left: across(i) }} className={i === index ? 'is-on' : undefined}>{tick(s)}</span>)}
      </div>
    </div>
  )
}
