import { mkdir, readFile, writeFile, chown, chmod, readdir, unlink } from 'node:fs/promises'
import { $ } from 'bun'

export async function authorizeSsh(publicKey: string) {
  const directory = '/home/dev/.ssh', file = `${directory}/authorized_keys`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const existing = await readFile(file, 'utf8').catch(() => '')
  if (!existing.split('\n').includes(publicKey)) await writeFile(file, existing.trimEnd() + '\n' + publicKey + '\n', { mode: 0o600 })
  await chown(directory, 1000, 1000)
  await chown(file, 1000, 1000)
  await chmod(directory, 0o700)
  await chmod(file, 0o600)
  await $`ssh-keygen -A`.quiet()
  await $`systemctl start ssh`.quiet()
}

export async function renewSshIdentity() {
  for (const name of await readdir('/etc/ssh')) {
    if (/^ssh_host_.*_key(?:\.pub)?$/.test(name)) await unlink(`/etc/ssh/${name}`)
  }
  await $`ssh-keygen -A`.quiet()
  await $`systemctl restart ssh`.quiet()
}
