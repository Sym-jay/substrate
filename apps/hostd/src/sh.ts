import { $ } from 'bun'

// Runs a shell command (Bun's `$`, so values are escaped) and turns a failure
// into an Error that carries the command's stderr.
export async function sh(strings: TemplateStringsArray, ...values: unknown[]) {
  const result = await $(strings, ...(values as never[])).quiet().nothrow()
  if (result.exitCode !== 0) {
    const command = strings[0]?.trim().split(/\s+/).slice(0, 2).join(' ') ?? 'command'
    throw new Error(`${command} failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}
