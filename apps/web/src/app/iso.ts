// Isometric line art in plain SVG: a trimmed TypeScript port of iso.js from
// the isometric-ui skill. World axes: +x is screen right-and-down, +y is
// screen left-and-down, +z is straight up; one world unit is one SVG unit.
// Flat faces are ordinary 2D SVG drawn through a plane matrix, and solids are
// convex outlines extruded upward. Draw back to front (painter's order).

const NS = 'http://www.w3.org/2000/svg'
const C = Math.cos(Math.PI / 6)
const S = 0.5
const DEG = Math.PI / 180

export type Pt = [number, number]
type Attrs = Record<string, string | number | null | undefined | false>

export const project = (x: number, y: number, z = 0): Pt => [(x - y) * C, (x + y) * S - z]
const r2 = (n: number) => Math.round(n * 100) / 100
const r4 = (n: number) => Math.round(n * 1e4) / 1e4
const pts = (list: Pt[]) => list.map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ')

export function el(tag: string, attrs: Attrs | null, parent?: Element) {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue
    if (k === 'text') node.textContent = String(v)
    else node.setAttribute(k, String(v))
  }
  parent?.appendChild(node)
  return node
}
export const g = (parent: Element, attrs?: Attrs) => el('g', attrs ?? null, parent) as SVGGElement

function planeMatrix(o: [number, number, number], u: [number, number, number], v: [number, number, number]) {
  const O = project(...o), U = project(...u), V = project(...v)
  return `matrix(${r4(U[0])} ${r4(U[1])} ${r4(V[0])} ${r4(V[1])} ${r4(O[0])} ${r4(O[1])})`
}

// The three visible faces, each kept readable (never mirrored).
export const plane = {
  // Horizontal surface at height z: u along +x, v along +y.
  top: (x: number, y: number, z: number) => planeMatrix([x, y, z], [1, 0, 0], [0, 1, 0]),
  // Wall facing +y (screen lower left): u along +x, v down.
  left: (x: number, y: number, z: number) => planeMatrix([x, y, z], [1, 0, 0], [0, 0, -1]),
  // Wall facing +x (screen lower right): u from the front corner back, v down.
  right: (x: number, y: number, z: number) => planeMatrix([x, y, z], [0, -1, 0], [0, 0, -1]),
}

// A rounded-rectangle outline in world x–y; seg stays even so the 45° points are exact.
export function rrect(x: number, y: number, w: number, d: number, r = 0, seg = 6): Pt[] {
  r = Math.max(0, Math.min(r, w / 2, d / 2))
  if (!r) return [[x, y], [x + w, y], [x + w, y + d], [x, y + d]]
  const out: Pt[] = []
  for (const [cx, cy, a0] of [[x + w - r, y + r, -90], [x + w - r, y + d - r, 0], [x + r, y + d - r, 90], [x + r, y + r, 180]] as const) {
    for (let i = 0; i <= seg; i++) {
      const a = (a0 + (90 * i) / seg) * DEG
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return out
}

export function circle(cx: number, cy: number, r: number, n = 48): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt
  })
}

// From the leftmost to the rightmost projected point, through the front-most one.
function frontChain(T: Pt[]) {
  const n = T.length
  let iL = 0, iR = 0, iF = 0
  for (let i = 1; i < n; i++) {
    if (T[i]![0] < T[iL]![0] - 1e-6) iL = i
    if (T[i]![0] > T[iR]![0] + 1e-6) iR = i
    if (T[i]![1] > T[iF]![1] + 1e-6) iF = i
  }
  const walk = (step: number) => {
    const out = [iL]
    for (let i = iL; i !== iR;) { i = (i + step + n) % n; out.push(i) }
    return out
  }
  let chain = walk(1)
  if (!chain.includes(iF)) chain = walk(-1)
  return { chain, k: chain.indexOf(iF) }
}

// A convex outline extruded from z to z + h; `split: false` paints one side (cylinders).
export function prism(parent: Element, outline: Pt[], z: number, h: number, o: { cls?: string; split?: boolean } = {}) {
  const grp = g(parent, o.cls ? { class: o.cls } : undefined)
  const T = outline.map((p) => project(p[0], p[1], z + h))
  const { chain, k } = frontChain(T)
  const band = (idx: number[]) => idx.map((i) => T[i]!).concat(idx.slice().reverse().map((i) => [T[i]![0], T[i]![1] + h] as Pt))
  if (h > 0) {
    if (o.split === false) el('polygon', { points: pts(band(chain)), class: 'iso-side' }, grp)
    else {
      el('polygon', { points: pts(band(chain.slice(0, k + 1))), class: 'iso-left' }, grp)
      el('polygon', { points: pts(band(chain.slice(k))), class: 'iso-right' }, grp)
    }
  }
  el('polygon', { points: pts(T), class: 'iso-top' }, grp)
  return grp
}

// A rounded box, with a group per visible face to draw on in that face's own 2D coordinates:
// top u 0..w, v 0..d · left u 0..w, v 0..h down · right u 0..d (front → back), v 0..h down.
export function box(parent: Element, b: { x: number; y: number; z?: number; w: number; d: number; h: number; r?: number; cls?: string }) {
  const { x, y, z = 0, w, d, h, r = 0 } = b
  const grp = prism(parent, rrect(x, y, w, d, r), z, h, b)
  return {
    g: grp,
    top: g(grp, { transform: plane.top(x, y, z + h) }),
    left: g(grp, { transform: plane.left(x, y + d, z + h) }),
    right: g(grp, { transform: plane.right(x + w, y + d, z + h) }),
  }
}

// The visible front line of an outline at height z: lid seams, plinths.
export function seam(parent: Element, outline: Pt[], z: number, attrs?: Attrs) {
  const T = outline.map((p) => project(p[0], p[1], z))
  const { chain } = frontChain(T)
  return el('polyline', { points: pts(chain.map((i) => T[i]!)), ...attrs }, parent)
}

// A soft contact shadow under a footprint; needs a blur filter with id `blur`.
export function shadow(parent: Element, outline: Pt[], filter: string, grow = 6, drop = 8) {
  const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length
  const cy = outline.reduce((s, p) => s + p[1], 0) / outline.length
  const T = outline.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1
    return project(x + (dx / L) * grow, y + (dy / L) * grow, 0)
  })
  return el('polygon', { points: pts(T), class: 'iso-shadow', transform: `translate(0 ${drop})`, filter: `url(#${filter})` }, parent)
}

// The svg's viewBox, around what's drawn.
export function fit(svg: SVGSVGElement, node: SVGGraphicsElement, pad = 20) {
  const b = node.getBBox()
  svg.setAttribute('viewBox', [b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2].map(r2).join(' '))
}

// Animate a number with ease-out; returns a cancel function.
export function tween(from: number, to: number, ms: number, fn: (v: number) => void, still = false) {
  if (ms <= 0 || still) { fn(to); return () => {} }
  let raf = 0, t0: number | null = null
  const step = (now: number) => {
    t0 ??= now
    const t = Math.min(1, (now - t0) / ms)
    fn(from + (to - from) * (1 - Math.pow(1 - t, 3)))
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)
}
