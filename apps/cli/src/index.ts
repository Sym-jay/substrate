#!/usr/bin/env bun
import { run } from './program.ts'
import { UsageError } from './args.ts'
import { clean } from './output.ts'

const controller = new AbortController()
const interrupted = () => controller.abort(new Error('Interrupted. Remote operations already submitted keep running.'))
process.once('SIGINT', interrupted)
process.once('SIGTERM', interrupted)
try { process.exitCode = await run(process.argv.slice(2), { signal: controller.signal }) }
catch (error) {
  const code = controller.signal.aborted ? 130 : error instanceof UsageError ? 2 : 1
  const message = controller.signal.aborted ? controller.signal.reason.message : error instanceof Error ? error.message : 'Command failed.'
  if (process.argv.includes('--json')) process.stderr.write(JSON.stringify({ error: message, exitCode: code }) + '\n')
  else process.stderr.write(`substrate: ${clean(message)}\n`)
  process.exitCode = code
} finally { process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted) }
