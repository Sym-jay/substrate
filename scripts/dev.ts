// Runs the control API and the web dev server together. No AWS needed: the
// control API reports "no host configured" unless SUBSTRATE_HOST_INSTANCE_ID is set.
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const procs = [
  Bun.spawn(['bun', '--watch', 'src/index.ts'], {
    cwd: join(root, 'apps/control'),
    env: { ...process.env, PORT: '8080' },
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
  Bun.spawn(['bun', 'run', 'dev'], {
    cwd: join(root, 'apps/web'),
    stdio: ['inherit', 'inherit', 'inherit'],
  }),
]

const stop = () => {
  for (const p of procs) p.kill()
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
await Promise.race(procs.map((p) => p.exited))
stop()
