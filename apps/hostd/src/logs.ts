import type { VmLogs } from '@substrate/protocol'

// Runs journalctl with these arguments and returns what it printed. It exits
// non-zero when nothing matches, which isn't an error here.
export type Journal = (args: string[]) => Promise<string>

export const journalctl: Journal = async (args) => {
  const proc = Bun.spawn(['journalctl', '--no-pager', '-o', 'short-iso', ...args], { stdout: 'pipe', stderr: 'ignore' })
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return out
}

// A VM's logs for the web app: its console (Firecracker's output, in its
// unit's journal) and what hostd said about it.
export async function vmLogs(id: string, lines: number, journal: Journal = journalctl): Promise<VmLogs> {
  const [console, host] = await Promise.all([
    journal(['-u', `substrate-vm-${id}`, '-n', String(lines)]),
    journal(['-u', 'substrate-hostd', '-n', String(lines), '--grep', id]),
  ])
  const clean = (text: string) => text.replace(/^-- No entries --\n?/m, '').trimEnd()
  return { console: clean(console), host: clean(host) }
}
