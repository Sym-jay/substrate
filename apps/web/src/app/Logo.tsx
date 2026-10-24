// The logo: the name in Geist Mono between blue brackets. `short` is its
// first letter, for the folded sidebar.
export function Wordmark({ short, className = '' }: { short?: boolean; className?: string }) {
  return (
    <span className={`logo-word ${className}`}>
      <span className="logo-accent" aria-hidden>[</span>{short ? 's' : 'substrate'}<span className="logo-accent" aria-hidden>]</span>
    </span>
  )
}
