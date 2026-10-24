import { parseArgs } from 'node:util'

const strings = ['url', 'name', 'size', 'disk', 'repo', 'command', 'agent', 'prompt', 'verify', 'timeout', 'wait-timeout', 'file', 'a', 'b', 'task', 'port', 'idle', 'max-run'] as const
const booleans = ['json', 'help', 'version', 'wait', 'yes', 'auto', 'no-browser', 'token-stdin', 'unreviewed', 'root'] as const
export type Flag = (typeof strings)[number] | (typeof booleans)[number]
export class UsageError extends Error {}
export function argumentsFor(argv: string[]) {
  const dash = argv.indexOf('--'), command = dash < 0 ? [] : argv.slice(dash + 1)
  try {
    const parsed = parseArgs({ args: dash < 0 ? argv : argv.slice(0, dash), allowPositionals: true,
      options: Object.fromEntries([...strings.map((name) => [name, { type: 'string' as const }]), ...booleans.map((name) => [name, { type: 'boolean' as const }])]),
    })
    const values = parsed.values as Partial<Record<Flag, string | boolean>>
    return { words: parsed.positionals, command, flag: (name: Flag) => values[name] === true,
      option: (name: Flag) => typeof values[name] === 'string' ? values[name] as string : undefined,
      allow: (...allowed: Flag[]) => {
        for (const name of Object.keys(values) as Flag[]) if (!['url', 'json', 'help', 'version', ...allowed].includes(name)) throw new UsageError(`--${name} is not valid for this command.`)
      },
    }
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments.') }
}

export function numberOption(input: string | undefined, fallback: number, min: number, max: number, name: string) {
  if (input === undefined) return fallback
  if (!/^\d+$/.test(input)) throw new UsageError(`${name} must be a whole number between ${min} and ${max}.`)
  const value = Number(input)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new UsageError(`${name} must be a whole number between ${min} and ${max}.`)
  return value
}

export const HELP = `Substrate — persistent workspaces and agent tasks

Usage: substrate <command> [options]

  login --url URL [--no-browser]       Approve CLI access in your browser
  login --url URL --token-stdin        Import a CLI credential from stdin
  logout                              Revoke this CLI login and remove it locally
  whoami                              Check the current login
  status                              Show the control service and host state

  workspace list                      List your Linux workspaces
  workspace get WORKSPACE              Read a workspace (name or ID)
  workspace create [--name NAME]       Create a workspace
      [--size small|medium|large] [--disk GIB] [--repo OWNER/REPO]
  workspace start|stop|pause|resume WORKSPACE
  workspace resize WORKSPACE [--size SIZE] [--disk GIB]
  workspace settings WORKSPACE [--idle MINUTES|off] [--max-run HOURS|off]
  workspace delete WORKSPACE --yes
  workspace fork WORKSPACE [--name NAME] [--wait]
  workspace exec WORKSPACE -- COMMAND [ARG...]
  workspace exec WORKSPACE --command 'SHELL PROGRAM' [--root]
  workspace open WORKSPACE [--no-browser]
  workspace preview WORKSPACE --port PORT

  task list                           List saved task summaries
  task run WORKSPACE --name NAME --command 'SHELL PROGRAM' [--wait]
  task run WORKSPACE --name NAME --agent claude|codex|opencode --prompt TEXT
      [--verify 'COMMAND'] [--auto] [--timeout SECONDS] [--wait]
  task get ID                         Read the complete saved result
  task wait ID                        Wait for a task already submitted
  task cancel ID                      Cancel the remote task
  task review ID [--unreviewed]        Mark a result reviewed or unreviewed

  compare list                        List saved comparisons
  compare run WORKSPACE --name NAME --a 'COMMAND' --b 'COMMAND' [--wait]
  compare run WORKSPACE --file FILE    Use {title, approaches:[TaskSpec,TaskSpec]}
  compare get|wait ID                  Read or wait for both approaches
  compare choose ID --task TASK_ID     Select an approach; retain both workspaces

Global: --url URL  --json  --help  --version
Waiting: --wait-timeout SECONDS (default 3600). Ctrl+C detaches; remote work continues.
Configuration: SUBSTRATE_URL, SUBSTRATE_TOKEN, SUBSTRATE_CONFIG_DIR.
No AWS credentials required. Windows/macOS workspace commands are outside this version.
`
