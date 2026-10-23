import { useEffect, useId, useRef } from 'react'
import { reducedMotion } from './ascii.ts'
import { box, el, fit, g, plane, rrect, seam, shadow, tween } from './iso.ts'

// World units. A host slab, a thin substrate tray on it, and a 3 × 2 grid of
// microVMs standing on the tray.
const HOST = { x: 0, y: 0, w: 300, d: 222, h: 34, r: 14 }
const TRAY = { x: 14, y: 14, z: HOST.h, w: 272, d: 194, h: 6, r: 10 }
const VM = { w: 70, d: 70, h: 54, r: 8 }
const BASE = TRAY.z + TRAY.h
// Back row first, then left to right: painter's order.
const SLOTS = [0, 1].flatMap((row) => [0, 1, 2].map((col) => ({ x: 29 + col * 86, y: 29 + row * 94 })))

type Vm = { slot: SVGGElement; x: number; y: number; h: number; on: boolean; busy: boolean; lines: number[] }

// A host running microVMs, in isometric line art on a transparent background.
// Click a microVM to despawn it into its socket, and an empty socket to boot
// one. Running screens scroll and VMs pause and wake on their own; all of it
// holds still if motion is reduced.
export function IsoHost({ className = '' }: { className?: string }) {
  const svg = useRef<SVGSVGElement>(null)
  const blur = `iso-blur-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`

  useEffect(() => {
    const root = svg.current
    if (!root) return
    const still = reducedMotion()
    root.replaceChildren()
    const defs = el('defs', null, root)
    el('feGaussianBlur', { stdDeviation: 9 }, el('filter', { id: blur, x: '-20%', y: '-40%', width: '140%', height: '180%' }, defs))
    const scene = g(root)

    // Host: plinth seam, front vents, status lamps and a port; vents on its side.
    shadow(scene, rrect(HOST.x, HOST.y, HOST.w, HOST.d, HOST.r), blur, 10, 10)
    const host = box(scene, HOST)
    seam(scene, rrect(HOST.x, HOST.y, HOST.w, HOST.d, HOST.r), 9, { class: 'faint' })
    for (let i = 0; i < 9; i++) el('line', { x1: 22 + i * 6, y1: 9, x2: 22 + i * 6, y2: 20, class: 'faint' }, host.left)
    for (let i = 0; i < 3; i++) el('circle', { cx: 92 + i * 9, cy: 14.5, r: 2, class: `lamp-dot${i < 2 ? ' is-lit' : ''}` }, host.left)
    el('rect', { x: 236, y: 9, width: 40, height: 10, rx: 2, class: 'well' }, host.left)
    for (let i = 0; i < 7; i++) el('line', { x1: 150 + i * 6, y1: 9, x2: 150 + i * 6, y2: 20, class: 'faint' }, host.right)

    // Tray: the substrate the VMs stand on.
    box(scene, TRAY)

    const vms: Vm[] = SLOTS.map((s, i) => ({ slot: g(scene, { class: 'hot' }), x: s.x, y: s.y, h: VM.h, on: i !== 2, busy: false, lines: [0.8, 0.5, 0.65] }))

    // One slot: its socket on the tray, and the microVM standing in it (a
    // rounded box with a screen and a lamp on its front, vents on top, and a
    // panel line on its side) when there is one.
    const draw = (vm: Vm) => {
      vm.slot.replaceChildren()
      const socket = g(vm.slot, { transform: plane.top(vm.x, vm.y, BASE) })
      el('rect', { x: -3, y: -3, width: VM.w + 6, height: VM.d + 6, rx: 9, class: vm.h < 1 ? 'socket is-empty' : 'socket' }, socket)
      if (vm.h < 1) return
      const b = box(vm.slot, { x: vm.x, y: vm.y, z: BASE, w: VM.w, d: VM.d, h: vm.h, r: VM.r })
      seam(vm.slot, rrect(vm.x, vm.y, VM.w, VM.d, VM.r), BASE + vm.h - 8, { class: 'faint' })
      if (vm.h < VM.h * 0.8) return
      for (let i = 0; i < 6; i++) el('line', { x1: 14, y1: 12 + i * 5, x2: 40, y2: 12 + i * 5, class: 'faint' }, b.top)
      el('rect', { x: 8, y: 13, width: VM.w - 16, height: 22, rx: 2, class: 'well' }, b.left)
      vm.lines.forEach((w, i) => el('rect', { x: 12, y: 17 + i * 5.5, width: Math.max(2, w * (VM.w - 24)), height: 1.6, class: vm.on ? 'phos' : 'dim' }, b.left))
      el('circle', { cx: 12, cy: 44, r: 2.2, class: `lamp-dot${vm.on ? ' is-lit' : ''}` }, b.left)
      for (let i = 0; i < 4; i++) el('line', { x1: 44 + i * 5, y1: 41, x2: 44 + i * 5, y2: 47, class: 'faint' }, b.left)
      el('line', { x1: 10, y1: 14, x2: VM.d - 10, y2: 14, class: 'faint' }, b.right)
    }
    vms.forEach(draw)
    fit(root, scene, 18)

    // Clicking a microVM sinks it into its socket; clicking an empty socket
    // boots one. The slot group stays put while its children are redrawn, so
    // it keeps the listener.
    const cancels: (() => void)[] = []
    const toggle = (vm: Vm) => {
      if (vm.busy) return
      vm.busy = true
      const despawn = vm.h >= 1
      vm.on = false
      cancels.push(tween(vm.h, despawn ? 0 : VM.h, despawn ? 420 : 640, (h) => {
        vm.h = h
        if (Math.abs(h - (despawn ? 0 : VM.h)) < 1e-6) { vm.h = despawn ? 0 : VM.h; vm.busy = false; vm.on = !despawn }
        draw(vm)
      }, still))
    }
    // On press, not click: a running VM redraws every few hundred ms, and a
    // click needs the same element under both ends of it.
    const clicks = vms.map((vm) => {
      const onPress = (e: PointerEvent) => { if (e.button === 0) toggle(vm) }
      vm.slot.addEventListener('pointerdown', onPress)
      return () => vm.slot.removeEventListener('pointerdown', onPress)
    })
    if (still) return () => { clicks.forEach((off) => off()); cancels.forEach((c) => c()) }

    let visible = true
    const seen = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting })
    seen.observe(root)

    // Running screens scroll: their lines change length.
    const scroll = window.setInterval(() => {
      if (!visible || document.hidden) return
      for (const vm of vms) {
        if (!vm.on || vm.busy || vm.h < VM.h) continue
        vm.lines = [...vm.lines.slice(1), 0.25 + Math.random() * 0.75]
        draw(vm)
      }
    }, 450)

    // Now and then, one that's up pauses or wakes.
    const life = window.setInterval(() => {
      if (!visible || document.hidden) return
      const up = vms.filter((vm) => !vm.busy && vm.h >= VM.h)
      const vm = up[Math.floor(Math.random() * up.length)]
      if (vm) { vm.on = !vm.on; draw(vm) }
    }, 2200)

    return () => {
      clearInterval(scroll)
      clearInterval(life)
      seen.disconnect()
      clicks.forEach((off) => off())
      cancels.forEach((c) => c())
    }
  }, [blur])

  return <svg ref={svg} className={`iso-scene ${className}`} aria-hidden />
}
