import type { ExecRequest, ExecResult } from '@substrate/protocol'

const MAX_OUTPUT_BYTES = 1024 * 1024

// `runuser -l` gives a login shell, so PATH and HOME match an interactive session.
export function shellFor({ command, user }: Pick<ExecRequest, 'command' | 'user'>): string[] {
  return user === 'root' ? ['bash', '-lc', command] : ['runuser', '-l', user, '-c', command]
}

// timeout(1) kills the command's whole process group, so a command that
// started background children can't keep the request open past its deadline.
export function withTimeout(argv: string[], timeoutMs: number): string[] {
  return ['timeout', '--kill-after=2', `${timeoutMs / 1000}`, ...argv]
}

const TIMEOUT_EXIT_CODES = new Set([124, 137])

export async function exec(req: ExecRequest, argv = withTimeout(shellFor(req), req.timeoutMs)): Promise<ExecResult> {
  const started = performance.now()
  const proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  // Backstop in case timeout(1) itself hangs.
  let killed = false
  const backstop = setTimeout(() => {
    killed = true
    proc.kill('SIGKILL')
  }, req.timeoutMs + 5_000)

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(backstop)

  const timedOut = killed || (argv[0] === 'timeout' && TIMEOUT_EXIT_CODES.has(exitCode))
  return {
    exitCode: timedOut ? null : exitCode,
    stdout: truncate(stdout),
    stderr: truncate(stderr),
    durationMs: Math.round(performance.now() - started),
    timedOut,
  }
}

function truncate(text: string) {
  return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}\n[output truncated]` : text
}
