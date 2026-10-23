import { expect, test } from 'bun:test'
import { forkGeneration } from './fork-generation.ts'

function rig(failure = '') {
  let sourcePaused = false
  let captures = 0
  const disks = new Map<string, string>(), memory = new Map<string, string>(), running = new Set<string>()
  const events: string[] = []
  const point = { id: 'immutable-generation', disk: 'disk-at-capture', memory: 'memory-at-capture' }
  const step = (event: string) => { events.push(event); if (event === failure) throw new Error(`injected ${event}`) }
  const run = () => forkGeneration({
    destinations: ['a', 'b'],
    capture: async () => { captures++; sourcePaused = true; step('capture'); return point },
    makeChild: (id) => ({ id }),
    copy: async (child, saved) => {
      expect(sourcePaused).toBe(true)
      expect(running.size).toBe(0)
      disks.set(child.id, saved.disk)
      step(`copy:${child.id}`)
      memory.set(child.id, saved.memory)
    },
    resume: async (child) => { expect(disks.size).toBe(2); expect(memory.size).toBe(2); running.add(child.id); step(`resume:${child.id}`) },
    remove: async (child) => { step(`remove:${child.id}`); running.delete(child.id); disks.delete(child.id); memory.delete(child.id) },
    releaseSource: async () => { sourcePaused = false; step('release') },
  })
  return { run, events, disks, memory, running, get captures() { return captures }, get sourcePaused() { return sourcePaused } }
}

test('both branches receive one captured disk/memory generation before either can execute', async () => {
  const r = rig()
  const result = await r.run()
  expect(r.captures).toBe(1)
  expect(result.point.id).toBe('immutable-generation')
  expect([...r.disks.values()]).toEqual(['disk-at-capture', 'disk-at-capture'])
  expect([...r.memory.values()]).toEqual(['memory-at-capture', 'memory-at-capture'])
  expect(r.sourcePaused).toBe(false)
  expect(r.events).toEqual(['capture', 'copy:a', 'copy:b', 'resume:a', 'resume:b', 'release'])
})

for (const failure of ['capture', 'copy:a', 'copy:b', 'resume:a', 'resume:b']) {
  test(`failure at ${failure} releases the source and removes every partial/running child`, async () => {
    const r = rig(failure)
    await expect(r.run()).rejects.toThrow(`injected ${failure}`)
    expect(r.sourcePaused).toBe(false)
    expect(r.disks.size).toBe(0)
    expect(r.memory.size).toBe(0)
    expect(r.running.size).toBe(0)
    expect(r.events.at(-1)).toBe('release')
    if (failure.startsWith('copy')) expect(r.events.some((event) => event.startsWith('resume'))).toBe(false)
  })
}
