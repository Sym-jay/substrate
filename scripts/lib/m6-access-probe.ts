// Compiled for the control box by check:m6. It registers only the test VM,
// issues short-lived transport grants, and removes them afterwards. No Clerk
// user is created or impersonated, and no credential is printed.
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Capabilities } from '../../apps/control/src/capabilities.ts'
import { openDatabase } from '../../apps/control/src/open-database.ts'
import { Owners } from '../../apps/control/src/owners.ts'

if (process.argv[2] === 'proxy') {
  process.argv.splice(2, 1)
  await import('../ssh-proxy.ts')
} else {
  await checkAccess()
}

async function checkAccess() {
  const [id, origin] = process.argv.slice(2)
  if (!id || !/^vm-[a-f0-9]{16}$/.test(id) || !origin || new URL(origin).protocol !== 'https:') throw new Error('invalid test arguments')
  const hostd = process.env.SUBSTRATE_HOSTD_URL, token = process.env.SUBSTRATE_HOSTD_TOKEN
  const preview = process.env.SUBSTRATE_PREVIEW_ORIGIN
  if (!hostd || !token || !preview) throw new Error('control configuration is incomplete')
  // The control box's own database, SQLite or Postgres (SUBSTRATE_DB and
  // friends come from its environment).
  process.env.SUBSTRATE_DB ??= '/var/lib/substrate/control.db'
  const db = await openDatabase()
  const owners = new Owners(db), caps = new Capabilities(db)
  const user = `m6-check-${crypto.randomUUID()}`
  if (await owners.owner(id)) throw new Error('refusing to replace ownership of an existing workspace')
  const directory = await mkdtemp(join(tmpdir(), 'substrate-m6-access-'))
  const internal = async (path: string, body?: unknown) => {
    const result = await fetch(hostd + `/vms/${id}` + path, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(300_000) })
    if (!result.ok) throw new Error(`test VM request failed (${result.status})`)
    return result
  }
  const expectStatus = async (url: string, status: number, headers?: Record<string, string>) => {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) })
    if (response.status !== status) throw new Error(`expected HTTP ${status}, received ${response.status}`)
    return response
  }
  await owners.add(id, user)
  try {
    await expectStatus(origin + '/api/vms', 401)
    await expectStatus(origin + `/api/vms/${id}/ssh`, 401)
    await expectStatus(preview + '/api/health', 404)
    await expectStatus(preview + `/p/${id}/3000/`, 401)

    const key = join(directory, 'key')
    const generate = Bun.spawn(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', key], { stdout: 'ignore', stderr: 'pipe' })
    if (await generate.exited !== 0) throw new Error('test SSH key generation failed')
    await internal('/ssh/keys', { publicKey: (await readFile(key + '.pub', 'utf8')).trim() })

    const previewGrant = await caps.issue({ vmId: id, userId: user, kind: 'preview', port: 3000 }, 300_000)
    const cookie = `__Secure-substrate-preview-${id}-3000=${previewGrant.token}`
    await internal('/pause')
    const started = performance.now()
    const app = await expectStatus(preview + `/p/${id}/3000/`, 200, { cookie })
    const body = await app.json() as { path: string }
    if (body.path !== `/p/${id}/3000/`) throw new Error('preview did not preserve its base path')
    const previewWakeMs = Math.round(performance.now() - started)

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(preview.replace(/^http/, 'ws') + `/p/${id}/3000/hmr`, { protocols: ['vite-hmr'], headers: { cookie } })
      ws.binaryType = 'arraybuffer'
      const timeout = setTimeout(() => { ws.close(); reject(new Error('public preview WebSocket timed out')) }, 30_000)
      ws.onopen = () => ws.send(new Uint8Array([0, 255, 128, 42]))
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('public preview WebSocket failed')) }
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') return
        const data = new Uint8Array(event.data as ArrayBuffer)
        clearTimeout(timeout); ws.close()
        if (data.join(',') === '0,255,128,42') resolve(); else reject(new Error('binary preview frame changed'))
      }
    })

    const sshGrant = await caps.issue({ vmId: id, userId: user, kind: 'ssh', port: 22 }, 300_000)
    const url = new URL(`/api/vms/${id}/ssh`, origin)
    url.protocol = 'wss:'; url.searchParams.set('access', sshGrant.token)
    const connection = join(directory, 'connection.json')
    await Bun.write(connection, JSON.stringify({ url: url.href, expiresAt: sshGrant.expiresAt }), { mode: 0o600 })
    await internal('/pause')
    const ssh = Bun.spawn(['ssh', '-i', key, '-o', `ProxyCommand=${process.execPath} proxy ${connection}`, '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=30', `dev@${id}`, 'printf m6-ssh-ok'],
    { stdout: 'pipe', stderr: 'pipe' })
    const output = await new Response(ssh.stdout).text()
    if (await ssh.exited !== 0 || output !== 'm6-ssh-ok') throw new Error('SSH through public WSS failed: ' + await new Response(ssh.stderr).text())
    await owners.remove(id)
    await expectStatus(url.href.replace(/^wss:/, 'https:'), 401)
    console.log(JSON.stringify({ previewWakeMs, previewWebSocket: true, sshThroughCloudFront: true, anonymousDenied: true, ownershipRevoked: true }))
  } finally {
    if ((await owners.owner(id)) === user) await owners.remove(id)
    // The test user's grants, by a match that works in SQLite and Postgres alike.
    await db`delete from capabilities where value like ${`%"userId":"${user}"%`}`
    await db.close()
    await rm(directory, { recursive: true, force: true })
  }
}
