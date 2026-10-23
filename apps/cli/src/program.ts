import { Comparison, CreateComparison, CreateVm, ExecResult, ResizeVm, Task, TaskSpec, UpdateVm, Vm, type Task as TaskType } from '@substrate/protocol'
import { argumentsFor, HELP, numberOption, UsageError } from './args.ts'
import { Client } from './client.ts'
import { connection, writeConfig } from './config.ts'
import { login, openBrowser } from './login.ts'
import { clean, table, taskExit, taskResult, taskTable, workspaceTable } from './output.ts'

const segment = encodeURIComponent
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const VERSION = '0.1.0'

export async function run(argv: string[], options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; stdout?: (value: string) => void; stderr?: (value: string) => void } = {}) {
  const args = argumentsFor(argv), env = options.env ?? process.env
  const stdout = options.stdout ?? ((text) => process.stdout.write(text)), stderr = options.stderr ?? ((text) => process.stderr.write(text))
  const output = (value: unknown, human?: string) => stdout((args.flag('json') ? JSON.stringify(value) : human ?? JSON.stringify(value, null, 2)) + '\n')
  const [group, action, ref, ...extra] = args.words
  if (args.flag('version')) { stdout(VERSION + '\n'); return 0 }
  if (args.flag('help') || !group || group === 'help') { stdout(HELP); return 0 }
  const need = (value: string | undefined, name: string) => { if (!value) throw new UsageError(`Provide ${name}. See substrate --help.`); return value }
  const waitMs = () => numberOption(args.option('wait-timeout'), 3600, 1, 86_400, '--wait-timeout') * 1000
  const noExtra = (count: number) => { if (args.words.length > count || (args.command.length && !(group === 'workspace' && action === 'exec'))) throw new UsageError('Unexpected arguments. See substrate --help.') }
  if (!['login', 'logout', 'whoami', 'status', 'workspace', 'task', 'compare'].includes(group)) throw new UsageError(`Unknown command ${clean(group)}. See substrate --help.`)
  if (group === 'login') {
    args.allow('name', 'no-browser', 'token-stdin'); noExtra(1)
    await login({ url: args.option('url'), name: args.option('name'), noBrowser: args.flag('no-browser'), tokenStdin: args.flag('token-stdin'), signal: options.signal, env,
      stdout: (value) => output(value, `Signed in to ${(value as { server: string }).server}.`), stderr })
    return 0
  }
  const info = await connection(args.option('url'), env), client = new Client(info.server, info.token, fetch, options.signal)
  if (group === 'logout') {
    args.allow(); noExtra(1)
    if (env.SUBSTRATE_TOKEN) throw new UsageError('Unset SUBSTRATE_TOKEN before logging out; manage that credential in the website Settings.')
    if (info.token) {
      // Keep a still-valid local credential if revocation cannot be confirmed.
      try { await client.request('/api/cli/logout', 'POST', {}) }
      catch (error) { if (!(error instanceof Error && 'status' in error && error.status === 401)) throw error }
    }
    delete info.config.servers[info.server]
    if (info.config.defaultServer === info.server) info.config.defaultServer = Object.keys(info.config.servers)[0]
    await writeConfig(info.config, info.path); output({ server: info.server, loggedOut: true }, `Signed out of ${info.server}.`); return 0
  }
  if (group === 'whoami') { args.allow(); noExtra(1); output(await client.identity()); return 0 }
  if (group === 'status') { args.allow(); noExtra(1); output(await client.request('/api/status', 'GET', undefined, false)); return 0 }
  if (group === 'workspace') {
    if (extra.length) throw new UsageError('Unexpected workspace arguments.')
    if (action === 'list') { args.allow(); noExtra(2); const vms = await client.workspaces(); output(vms, workspaceTable(vms)); return 0 }
    if (action === 'create') {
      args.allow('name', 'size', 'disk', 'repo', 'wait-timeout'); noExtra(2)
      const input = CreateVm.parse({ name: args.option('name'), size: args.option('size'), diskGib: args.option('disk') === undefined ? undefined : numberOption(args.option('disk'), 32, 8, 1024, '--disk'), repository: args.option('repo') })
      const result = await client.request('/api/vms', 'POST', input)
      if (!args.flag('json')) stderr('Creating workspace…\n')
      const vm = await client.operation(result, waitMs()); output(vm, workspaceTable([vm])); return 0
    }
    const supported = ['get', 'start', 'stop', 'pause', 'resume', 'delete', 'resize', 'settings', 'fork', 'exec', 'open', 'preview']
    if (!action || !supported.includes(action)) throw new UsageError('Unknown workspace command. See substrate --help.')
    const allowed = { resize: ['size', 'disk'], settings: ['idle', 'max-run'], fork: ['name', 'wait', 'wait-timeout'], exec: ['command', 'root', 'timeout'], open: ['no-browser'], preview: ['port'], delete: ['yes'] } as const
    args.allow(...(allowed[action as keyof typeof allowed] ?? [])); noExtra(3)
    need(ref, 'a workspace name or ID')
    if (action === 'delete' && !args.flag('yes')) throw new UsageError('Deleting a workspace removes its disk and sessions. Repeat with --yes to delete it.')
    if (action === 'exec' && (!!args.option('command') === !!args.command.length)) throw new UsageError('Provide either --command PROGRAM or -- COMMAND [ARG...].')
    const vm = await client.workspace(ref!), path = `/api/vms/${segment(vm.id)}`
    if (action === 'get') { output(vm); return 0 }
    if (action === 'open') {
      const url = `${info.server}/#/workspaces/${segment(vm.id)}`
      output({ url }, url); if (!args.flag('no-browser') && !args.flag('json')) await openBrowser(url); return 0
    }
    if (action === 'delete') { await client.request(path, 'DELETE'); output({ deleted: vm.id }, `Deleted ${vm.name}.`); return 0 }
    if (action === 'exec') {
      const command = args.option('command') ?? args.command.map(quote).join(' ')
      const timeoutMs = numberOption(args.option('timeout'), 30, 1, 600, '--timeout') * 1000
      const result = await client.parsed(ExecResult, path + '/exec', 'POST', { command, user: args.flag('root') ? 'root' : 'dev', timeoutMs }, timeoutMs + 10_000)
      if (args.flag('json')) output(result)
      else { stdout(result.stdout); stderr(result.stderr); if (result.timedOut) stderr('Command timed out.\n') }
      return result.timedOut ? 124 : Math.max(0, Math.min(255, result.exitCode ?? 1))
    }
    if (action === 'preview') { output(await client.request(path + '/previews', 'POST', { port: numberOption(need(args.option('port'), '--port'), 0, 1024, 65535, '--port') })); return 0 }
    if (action === 'fork') {
      const result = await client.request(path + '/fork', 'POST', { name: args.option('name') })
      output(args.flag('wait') ? await client.operation(result, waitMs()) : result); return 0
    }
    if (action === 'settings') {
      const input = UpdateVm.parse({
        autoPauseMinutes: args.option('idle') === undefined ? undefined : args.option('idle') === 'off' ? null : numberOption(args.option('idle'), 0, 1, 1440, '--idle'),
        maxAwakeHours: args.option('max-run') === undefined ? undefined : args.option('max-run') === 'off' ? null : numberOption(args.option('max-run'), 0, 1, 720, '--max-run') })
      if (!Object.values(input).some((value) => value !== undefined)) throw new UsageError('Choose --idle or --max-run.')
      output(await client.parsed(Vm, path, 'PATCH', input)); return 0
    }
    const body = action === 'resize' ? ResizeVm.parse({ size: args.option('size'), diskGib: args.option('disk') === undefined ? undefined : numberOption(args.option('disk'), 32, 8, 1024, '--disk') }) : {}
    const result = await client.parsed(Vm, path + '/' + action, 'POST', body); output(result, workspaceTable([result])); return 0
  }
  if (group === 'task') {
    if (extra.length) throw new UsageError('Unexpected task arguments.')
    if (action === 'list') { args.allow(); noExtra(2); const tasks = await client.parsed(Task.array(), '/api/tasks'); output(tasks, taskTable(tasks)); return 0 }
    if (action === 'run') {
      args.allow('name', 'command', 'agent', 'prompt', 'verify', 'auto', 'timeout', 'wait', 'wait-timeout'); noExtra(3)
      const command = args.option('command'), agent = args.option('agent'), prompt = args.option('prompt')
      if (command ? !!agent || !!prompt || args.flag('auto') : !agent || !prompt) throw new UsageError('Use --command PROGRAM, or --agent RUNNER --prompt TEXT [--auto].')
      const spec = TaskSpec.parse({ title: need(args.option('name'), '--name'), runner: command ? 'command' : agent, input: command ?? prompt, mode: args.flag('auto') ? 'auto' : 'ask', verificationCommand: args.option('verify') ?? '', timeoutSeconds: numberOption(args.option('timeout'), 3600, 10, 86400, '--timeout') })
      const vm = await client.workspace(need(ref, 'a workspace'))
      const task = await client.parsed(Task, '/api/tasks', 'POST', { vmId: vm.id, spec })
      if (!args.flag('wait')) { output(task, `${task.id} · submitted to ${vm.name}`); return 0 }
      if (!args.flag('json')) stderr(`Task ${task.id} submitted. Waiting; Ctrl+C detaches without cancelling it.\n`)
      const result = await client.waitTask(task.id, waitMs()); output(result, taskResult(result)); return taskExit(result)
    }
    if (!action || !['get', 'wait', 'cancel', 'review'].includes(action)) throw new UsageError('Unknown task command. See substrate --help.')
    args.allow(...(action === 'wait' ? ['wait-timeout'] as const : action === 'review' ? ['unreviewed'] as const : [])); noExtra(3)
    const id = segment(need(ref, 'a task ID'))
    const task = action === 'wait' ? await client.waitTask(ref!, waitMs())
      : action === 'review' ? await client.parsed(Task, `/api/tasks/${id}`, 'PATCH', { reviewed: !args.flag('unreviewed') })
      : await client.parsed(Task, `/api/tasks/${id}${action === 'cancel' ? '/cancel' : ''}`, action === 'cancel' ? 'POST' : 'GET', action === 'cancel' ? {} : undefined)
    output(task, taskResult(task)); return action === 'wait' ? taskExit(task) : 0
  }
  if (group === 'compare') {
    if (extra.length) throw new UsageError('Unexpected comparison arguments.')
    if (action === 'list') { args.allow(); noExtra(2); const values = await client.parsed(Comparison.array(), '/api/comparisons'); output(values, table(['ID', 'NAME', 'STATE', 'CHOSEN TASK'], values.map((v) => [v.id, v.title, v.state, v.selectedTaskId]))); return 0 }
    if (action === 'run') {
      args.allow('name', 'a', 'b', 'file', 'verify', 'timeout', 'wait', 'wait-timeout'); noExtra(3)
      const file = args.option('file')
      if (file && ['name', 'a', 'b', 'verify', 'timeout'].some((name) => args.option(name as 'name'))) throw new UsageError('Use either --file or inline approach options.')
      const data = file ? await Bun.file(file).json().catch(() => { throw new UsageError('Could not read comparison JSON file.') }) : {
        title: need(args.option('name'), '--name'), approaches: [args.option('a'), args.option('b')].map((input, i) => ({ title: `Approach ${i ? 'B' : 'A'}`, runner: 'command', input: need(input, i ? '--b' : '--a'), verificationCommand: args.option('verify') ?? '', timeoutSeconds: numberOption(args.option('timeout'), 3600, 10, 86400, '--timeout') })),
      }
      const vm = await client.workspace(need(ref, 'a workspace'))
      const input = CreateComparison.parse({ ...data, sourceVmId: vm.id })
      const comparison = await client.parsed(Comparison, '/api/comparisons', 'POST', input)
      if (!args.flag('wait')) { output(comparison, `${comparison.id} · preparing both approaches`); return 0 }
      if (!args.flag('json')) stderr(`Comparison ${comparison.id} submitted. Waiting; Ctrl+C detaches without cancelling it.\n`)
      const result = await client.waitComparison(comparison.id, waitMs()); output(result, comparisonResult(result)); return comparisonExit(result)
    }
    if (!action || !['get', 'wait', 'choose'].includes(action)) throw new UsageError('Unknown comparison command. See substrate --help.')
    args.allow(...(action === 'wait' ? ['wait-timeout'] as const : action === 'choose' ? ['task'] as const : [])); noExtra(3)
    const id = need(ref, 'a comparison ID'), path = `/api/comparisons/${segment(id)}`
    if (action === 'choose') { output(await client.parsed(Comparison, path + '/select', 'POST', { taskId: need(args.option('task'), '--task') })); return 0 }
    const comparison = action === 'wait' ? await client.waitComparison(id, waitMs()) : await (async () => {
      const value = await client.parsed(Comparison, path)
      return { comparison: value, tasks: await Promise.all(value.taskIds.map((task) => client.parsed(Task, `/api/tasks/${segment(task)}`))) }
    })()
    output(comparison, comparisonResult(comparison)); return action === 'wait' ? comparisonExit(comparison) : 0
  }
  throw new UsageError(`Unknown command ${clean(group)}. See substrate --help.`)
}

const comparisonExit = (result: { comparison: Comparison; tasks: TaskType[] }) => result.comparison.state === 'failed' || result.tasks.some((task) => taskExit(task) !== 0) ? 1 : 0
const comparisonResult = (result: { comparison: Comparison; tasks: TaskType[] }) => [
  `${clean(result.comparison.title)} (${result.comparison.id}) · ${result.comparison.state}`,
  result.comparison.error, ...result.tasks.map(taskResult),
  result.comparison.selectedTaskId ? `Chosen: ${result.comparison.selectedTaskId}` : 'Choose explicitly with substrate compare choose ID --task TASK_ID. Both workspaces are retained.',
].filter(Boolean).join('\n\n')
