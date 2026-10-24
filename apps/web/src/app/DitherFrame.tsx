import { useId } from 'react'

// A square frame of ordered-dither dots instead of a line: a checkerboard all
// round and, given `share` (0 to 1), denser blue dots that far round it,
// clockwise from the top left. The account's credits, around its avatar.
export function DitherFrame({ share }: { share?: number | null }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg className="dither-frame" viewBox="0 0 44 44" shapeRendering="crispEdges" aria-hidden>
      <defs>
        <pattern id={`${id}-half`} width="2" height="2" patternUnits="userSpaceOnUse">
          <rect className="dither-dot" width="1" height="1" />
          <rect className="dither-dot" x="1" y="1" width="1" height="1" />
        </pattern>
        <pattern id={`${id}-most`} width="2" height="2" patternUnits="userSpaceOnUse">
          <rect className="dither-fill" width="2" height="1" />
          <rect className="dither-fill" y="1" width="1" height="1" />
        </pattern>
      </defs>
      <rect x="2" y="2" width="40" height="40" fill="none" strokeWidth="4" stroke={`url(#${id}-half)`} />
      {share != null && (
        <rect x="2" y="2" width="40" height="40" fill="none" strokeWidth="4" stroke={`url(#${id}-most)`} pathLength={100} strokeDasharray={`${share * 100} 100`} className="dither-share" />
      )}
    </svg>
  )
}
