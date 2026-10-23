import { X } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { bar, buttonFrame, reducedMotion, scrambled } from './ascii.ts'

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  icon?: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', icon, className = '', children, type = 'button', ...rest }: ButtonProps) {
  const sizing = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : ''
  const classes = `btn btn-${variant} ${sizing} ${children ? '' : 'btn-icon'} ${className}`
  if (variant === 'primary') return <AsciiButton className={classes} icon={icon} type={type} {...rest}>{children}</AsciiButton>
  return (
    <button type={type} className={classes} {...rest}>
      {icon}
      {children}
    </button>
  )
}

// A primary button: just a border, until it's hovered, when an ASCII wave
// loops inside it and its label scrambles into place.
function AsciiButton({ children, icon, className, onPointerEnter, onPointerLeave, onFocus, onBlur, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode }) {
  const field = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [label, setLabel] = useState<string | null>(null)
  const text = typeof children === 'string' ? children : null

  const stop = () => {
    clearTimeout(timer.current)
    if (field.current) field.current.textContent = ''
    setLabel(null)
  }
  const start = (target: HTMLButtonElement) => {
    if (reducedMotion() || target.disabled || !field.current) return
    const cols = Math.ceil(target.clientWidth / 6) + 1
    const rows = Math.ceil(target.clientHeight / 10) + 1
    const begun = performance.now()
    let t = 0
    const tick = () => {
      if (!field.current) return
      field.current.textContent = buttonFrame(cols, rows, t++)
      const progress = (performance.now() - begun) / 380
      if (text) setLabel(progress < 1 ? scrambled(text, progress) : null)
      timer.current = setTimeout(tick, 70)
    }
    tick()
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <button
      className={className}
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

// A bar in characters, e.g. host memory: [######====..........].
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
        <h1 className="heading text-3xl sm:text-4xl">{title}</h1>
        {subtitle && <p className="text-muted mt-1.5 text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  )
}

export function Stat({ label, value, detail, children }: { label: string; value: ReactNode; detail?: ReactNode; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="card card-pad flex flex-col gap-1">
      <div className="label">{label}</div>
      <div className="stat-value">{value}</div>
      {detail && <div className="text-faint text-xs">{detail}</div>}
      {children}
    </div>
  )
}

const tones: Record<string, string> = {
  running: 'is-ok', ready: 'is-ok', done: 'is-ok',
  paused: 'is-warn', pausing: 'is-busy', resuming: 'is-busy', starting: 'is-busy', creating: 'is-busy', stopping: 'is-busy', waiting: 'is-busy', deleting: 'is-busy',
  failed: 'is-bad', exited: '', stopped: '',
}

export function StateBadge({ state, label }: { state: string; label?: string }) {
  return (
    <span className="chip">
      <span className={`dot ${tones[state] ?? ''}`} />
      {label ?? state}
    </span>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
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

// A small menu that opens under its button and closes on a choice or outside click.
export function Menu({ button, children, align = 'start' }: { button: (props: { open: boolean; toggle: () => void }) => ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={root} className="relative">
      {button({ open, toggle: () => setOpen((v) => !v) })}
      {open && <div className={`menu card ${align === 'end' ? 'right-0' : 'left-0'}`} role="menu">{children(() => setOpen(false))}</div>}
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
