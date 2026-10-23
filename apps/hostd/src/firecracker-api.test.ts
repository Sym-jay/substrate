import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firecrackerClient } from './firecracker-api.ts'

test('the typed Firecracker client sends snapshot requests over its Unix socket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fc-api-'))
  const socket = join(dir, 'api.sock')
  const calls: { method: string; path: string; body: unknown }[] = []
  const server = Bun.serve({
    unix: socket,
    async fetch(req) {
      const path = new URL(req.url).pathname
      calls.push({ method: req.method, path, body: await req.json().catch(() => null) })
      if (path === '/') return Response.json({ state: 'Paused', vmm_version: '1.17.0', id: 'test', app_name: 'Firecracker' })
      if (path === '/vm') return new Response('cannot resume', { status: 400 })
      return new Response(null, { status: 204 })
    },
  })
  try {
    const api = firecrackerClient(socket)
    expect((await api('GET /', undefined)).state).toBe('Paused')
    await api('PUT /snapshot/create', { snapshot_path: '/state', mem_file_path: '/memory', snapshot_type: 'Full', sync_snapshot_files: true })
    expect(calls[1]).toEqual({ method: 'PUT', path: '/snapshot/create', body: { snapshot_path: '/state', mem_file_path: '/memory', snapshot_type: 'Full', sync_snapshot_files: true } })
    await expect(api('PATCH /vm', { state: 'Resumed' })).rejects.toThrow('cannot resume')
  } finally { server.stop(true); await rm(dir, { recursive: true, force: true }) }
})
