import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

// The control box's SSH key for Windows workspaces, which each one trusts
// from its first boot, and each workspace's host key, learned on first contact.
export class WindowsSsh {
  private readonly key: string

  constructor(private readonly dir: string) {
    this.key = join(dir, 'id_ed25519')
  }

  async init() {
    await mkdir(join(this.dir, 'known_hosts'), { recursive: true, mode: 0o700 })
    if (!existsSync(this.key)) {
      const keygen = Bun.spawn(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'substrate-control', '-f', this.key], { stderr: 'pipe' })
      if ((await keygen.exited) !== 0) throw new Error(`ssh-keygen failed: ${await new Response(keygen.stderr).text()}`)
    }
  }

  publicKey() {
    return readFile(`${this.key}.pub`, 'utf8').then((key) => key.trim())
  }

  argv(id: string, ip: string) {
    return [
      'ssh', '-i', this.key,
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', `UserKnownHostsFile=${join(this.dir, 'known_hosts', id)}`,
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=30',
      '-o', 'LogLevel=ERROR',
      `Administrator@${ip}`,
    ]
  }

  // Whether its first boot has finished: our key works, and it says so.
  async ready(id: string, ip: string) {
    const ssh = Bun.spawn([...this.argv(id, ip), "if (Test-Path C:\\substrate\\ready) { 'ready' }"], { stdout: 'pipe', stderr: 'ignore', timeout: 30_000 })
    const [out, code] = await Promise.all([new Response(ssh.stdout).text(), ssh.exited])
    return code === 0 && out.trim() === 'ready'
  }

  forget(id: string) {
    return rm(join(this.dir, 'known_hosts', id), { force: true })
  }
}
