import { X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { bar, buttonFrame, reducedMotion, scrambled, shimmerFrame } from './ascii.ts'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
  // Primary only: its ASCII wave runs all the time, not just on hover.
  live?: boolean
}

export function Button({ variant = 'secondary', size = 'md', icon, live = false, className = '', children, type = 'button', ...rest }: ButtonProps) {
  const sizing = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : ''
  const classes = `btn btn-${variant} ${sizing} ${children ? '' : 'btn-icon'} ${className}`
  if (variant === 'primary') return <AsciiButton className={classes} icon={icon} live={live} type={type} {...rest}>{children}</AsciiButton>
  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  )
}

// A primary button: just a border, until it's hovered, when an ASCII wave
// loops inside it and its label scrambles into place. A live one keeps its
// wave going while it's enabled, and hovering only scrambles the label.
function AsciiButton({ children, icon, live, className, onPointerEnter, onPointerLeave, onFocus, onBlur, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; live: boolean }) {
  const button = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // When the label began scrambling; 0 when it isn't.
  const begun = useRef(0)
  const [label, setLabel] = useState<string | null>(null)
  const text = typeof children === 'string' ? children : null

  const clear = () => {
    clearTimeout(timer.current)
    if (field.current) field.current.textContent = ''
  }
  const run = (target: HTMLButtonElement) => {
    clearTimeout(timer.current)
    if (reducedMotion() || !field.current) return
    const cols = Math.ceil(target.clientWidth / 6) + 1
    const rows = Math.ceil(target.clientHeight / 10) + 1
    let t = 0
    const tick = () => {
      if (!field.current) return
      if (!document.hidden) field.current.textContent = buttonFrame(cols, rows, t++)
      if (text && begun.current) {
        const progress = (performance.now() - begun.current) / 380
        setLabel(progress < 1 ? scrambled(text, progress) : null)
        if (progress >= 1) begun.current = 0
      }
      timer.current = setTimeout(tick, 70)
    }
    tick()
  }
  const start = (target: HTMLButtonElement) => {
    if (target.disabled) return
    begun.current = performance.now()
    if (!live) run(target)
  }
  const stop = () => {
    begun.current = 0
    setLabel(null)
    if (!live) clear()
  }
  useEffect(() => {
    if (live && !rest.disabled && button.current) run(button.current)
    else clear()
    return () => clearTimeout(timer.current)
    // run reads the button's size as it is now; re-run when it's re-enabled.
  }, [live, rest.disabled])

  return (
    <button
      ref={button}
      className={live ? `${className} btn-live` : className}
      onPointerEnter={(e) => { start(e.currentTarget); onPointerEnter?.(e) }}
      onPointerLeave={(e) => { stop(); onPointerLeave?.(e) }}
      onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) start(e.currentTarget); onFocus?.(e) }}
      onBlur={(e) => { stop(); onBlur?.(e) }}
      {...rest}
    >
      <span ref={field} className="btn-ascii" aria-hidden />
      {icon}
      {children !== undefined && children !== null && children !== false && (
        <span className="btn-label">{label ?? children}</span>
      )}
    </button>
  )
}

// A bar in characters, e.g. memory in use: [######====..........].
export function AsciiBar({ parts, total, width = 28, label }: { parts: { value: number; char: string }[]; total: number; width?: number; label?: string }) {
  const inner = bar(parts, total, width).slice(1, -1)
  const filled = inner.replace(/\.+$/, '')
  return <div className="ascii-bar" role="img" aria-label={label}>[<b>{filled}</b>{inner.slice(filled.length)}]</div>
}

export function Card({ title, action, className = '', children, style }: { title?: ReactNode; action?: ReactNode; className?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section className={`card card-pad ${className}`} style={style}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="card-title">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="heading text-3xl sm:text-4xl">{typeof title === 'string' ? <Reveal text={title} /> : title}</h1>
        {subtitle && <p className="text-muted mt-1.5 text-sm">{typeof subtitle === 'string' ? <Reveal text={subtitle} /> : subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  )
}

// Text that fades in from a blur, a letter at a time from the left, when it
// appears (a page change) or changes. Letters stay grouped in their words so
// it wraps between words; screen readers get the text itself.
export function Reveal({ text }: { text: string }) {
  // The whole sweep takes about the same time, short text or long.
  const stagger = Math.min(28, 320 / Math.max(1, text.length))
  let n = 0
  return (
    <span key={text}>
      <span aria-hidden>
        {text.split(/(\s+)/).map((part, w) => /^\s+$/.test(part) ? (n += part.length, part) : (
          <span key={w} className="reveal-word">
            {[...part].map((ch, c) => <span key={c} className="reveal-ch" style={{ animationDelay: `${Math.round(n++ * stagger)}ms` }}>{ch}</span>)}
          </span>
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  )
}

// A setting: its name and a hint on the left, the control on the right.
export function FieldRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="min-w-0">
        <p className="font-medium">{label}</p>
        {hint && <p className="text-faint text-xs leading-relaxed">{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const tones: Record<string, string> = {
  running: 'is-ok', ready: 'is-ok', done: 'is-ok',
  paused: 'is-warn', pausing: 'is-busy', resuming: 'is-busy', starting: 'is-busy', creating: 'is-busy', stopping: 'is-busy', waiting: 'is-busy', deleting: 'is-busy',
  failed: 'is-bad', exited: '', stopped: '',
}

// Something running: a band of ASCII sweeping across it, behind its content.
// Put it first inside an element with the is-running class. Every shimmer on
// the page shares one timer, so they sweep in step.
export function Shimmer() {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || reducedMotion()) return
    return watchShimmer(el)
  }, [])
  return <span ref={ref} className="shimmer" aria-hidden />
}

// Its glyphs: 10px monospace, so 6px wide and 10px tall.
const SHIMMER_CHAR = { w: 6, h: 10 }
const shimmers = new Map<HTMLElement, { cols: number; rows: number }>()
let shimmerSizes: ResizeObserver | undefined
let shimmerTimer: ReturnType<typeof setInterval> | undefined

function watchShimmer(el: HTMLElement) {
  shimmerSizes ??= new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      const size = shimmers.get(target as HTMLElement)
      if (size) Object.assign(size, { cols: Math.ceil(contentRect.width / SHIMMER_CHAR.w), rows: Math.ceil(contentRect.height / SHIMMER_CHAR.h) })
    }
  })
  shimmers.set(el, { cols: 0, rows: 0 })
  shimmerSizes.observe(el)
  shimmerTimer ??= setInterval(() => {
    if (document.hidden) return
    // A 2.2s sweep, then a second's rest.
    const phase = Math.min(1, ((performance.now() / 1000) % 3.2) / 2.2)
    for (const [target, { cols, rows }] of shimmers) target.textContent = shimmerFrame(cols, rows, phase)
  }, 70)
  return () => {
    shimmers.delete(el)
    shimmerSizes?.unobserve(el)
    if (!shimmers.size) {
      clearInterval(shimmerTimer)
      shimmerTimer = undefined
    }
  }
}

export function StateBadge({ state, label }: { state: string; label?: string }) {
  return (
    <span className="chip">
      <span className={`dot ${tones[state] ?? ''}`} />
      {label ?? state}
    </span>
  )
}

// Substrate's mark (public/favicon.svg) drawn in dots, for empty states.
const MARK = [
  '::::::::::::::',
  '::::::::::::::',
  '::          ::',
  '::::::::::::::',
  '::          ::',
  '::::::::::::::',
  '::          ::',
  '::::::::::::::',
  '::::::::::::::',
].join('\n')

export function AsciiMark({ className = '' }: { className?: string }) {
  return <pre className={`ascii-mark ${className}`} aria-hidden>{MARK}</pre>
}

export function Empty({ icon, art, title, children }: { icon?: ReactNode; art?: boolean; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {art && <AsciiMark />}
      {icon && <div className="text-faint mb-1 [&>svg]:size-7">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="text-muted max-w-sm text-sm leading-relaxed">{children}</div>}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

// A panel that slides in from the right (from the bottom on phones).
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <div className={`sheet ${open ? 'is-open' : ''}`} aria-hidden={!open}>
      <div className="sheet-scrim" onClick={onClose} />
      <div ref={panel} className="sheet-panel card" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="heading text-xl">{title}</h2>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<X />} onClick={onClose} />
        </div>
        {open && children}
      </div>
    </div>
  )
}

// A dialog in the middle of the window, over a scrim; Escape or the scrim
// closes it, and focus goes back where it was. Its children lay out the body
// (.modal-body scrolls) and the footer (.modal-foot).
export function Modal({ open, title, onClose, className = '', children }: { open: boolean; title: string; onClose: () => void; className?: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    panel.current?.focus()
    return () => { document.removeEventListener('keydown', onKey); before?.focus?.() }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="modal">
      <div className="modal-scrim" onClick={onClose} />
      <div ref={panel} className={`modal-panel ${className}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <Button variant="ghost" size="sm" aria-label="Close" icon={<X />} onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}

// A small menu that opens under its button and closes on a choice or outside click.
export function Menu({ button, children, align = 'start' }: { button: (props: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<React.CSSProperties>({})
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])
  // Fixed to the window, so a scrolling container can't clip it; above the
  // button when there isn't room below.
  const toggle = () => {
    const r = root.current?.getBoundingClientRect()
    if (r) {
      const below = window.innerHeight - r.bottom > 320 || r.top < 320
      setPlace({
        position: 'fixed',
        ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }),
        ...(align === 'end' ? { right: window.innerWidth - r.right } : { left: r.left }),
      })
    }
    setOpen((v) => !v)
  }
  return (
    <div ref={root} className="relative">
      {button({ open, toggle })}
      {open && <div className="menu card" style={place} role="menu">{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function MenuItem({ icon, children, hint, onClick, disabled }: { icon?: ReactNode; children: ReactNode; hint?: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className="menu-item" onClick={onClick} disabled={disabled}>
      <span className="text-faint [&>svg]:size-4">{icon}</span>
      <span className="flex-1 text-left">{children}</span>
      {hint && <span className="text-faint text-xs">{hint}</span>}
    </button>
  )
}

// ── Toasts ──
type Toast = { id: number; text: string; tone: 'info' | 'error' }
const ToastContext = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})
export const useToast = () => useContext(ToastContext)

export function Toasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((prev) => [...prev.slice(-3), { id, text, tone }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), tone === 'error' ? 8_000 : 4_500)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast card ${t.tone === 'error' ? 'is-error' : ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const since = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} days`
}
export const gb = (mib: number) => `${(mib / 1024).toFixed(mib % 1024 ? 1 : 0)} GB`
