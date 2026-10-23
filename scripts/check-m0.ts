// Checks M0's "Done when" list against the real deployment.
import { BudgetsClient, DescribeBudgetsCommand, DescribeNotificationsForBudgetCommand } from '@aws-sdk/client-budgets'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { instanceState, isSsmOnline, region, run, stackOutputs } from './lib/aws.ts'

type Check = { name: string; ok: boolean | null; detail: string }
const checks: Check[] = []
const check = (name: string, ok: boolean | null, detail = '') => {
  checks.push({ name, ok, detail })
  const mark = ok === null ? '–' : ok ? '✓' : '✗'
  console.log(`${mark} ${name}${detail ? `: ${detail}` : ''}`)
}

const out = await stackOutputs()
check('stack deployed', true, out.Url)

check('control box reachable over SSM', await isSsmOnline(out.ControlInstanceId))

const hostState = await instanceState(out.HostInstanceId)
if (hostState !== 'running') {
  check('host checks', null, `skipped, the host is ${hostState} (bun run host start)`)
} else {
  const online = await isSsmOnline(out.HostInstanceId)
  check('host reachable over SSM', online)
  if (online) {
    const result = await run(
      out.HostInstanceId,
      [
        'export PATH="$PATH:/usr/local/bin:/usr/sbin:/sbin"',
        'echo "kvm=$([ -e /dev/kvm ] && echo yes || echo no)"',
        'echo "firecracker=$(firecracker --version 2>/dev/null | head -1)"',
        'echo "pool=$(zpool list -H -o health substrate 2>/dev/null)"',
        'echo "datasets=$(zfs list -H -o name -r substrate 2>/dev/null | tr "\\n" " ")"',
      ].join('\n'),
      60,
    )
    const facts = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const i = line.indexOf('=')
          return [line.slice(0, i), line.slice(i + 1).trim()]
        }),
    )
    check('host has /dev/kvm', facts.kvm === 'yes')
    check('firecracker installed', Boolean(facts.firecracker), facts.firecracker || 'missing')
    check('ZFS pool on the data disk', facts.pool === 'ONLINE', facts.pool || 'no pool')
    check(
      'ZFS datasets',
      /substrate\/images/.test(facts.datasets ?? '') && /substrate\/vms/.test(facts.datasets ?? ''),
      facts.datasets,
    )
  }
}

const { Account } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}))
const budgets = new BudgetsClient({ region: 'us-east-1' })
const { Budgets = [] } = await budgets.send(new DescribeBudgetsCommand({ AccountId: Account }))
let alerts = 0
for (const b of Budgets) {
  const n = await budgets.send(
    new DescribeNotificationsForBudgetCommand({ AccountId: Account, BudgetName: b.BudgetName }),
  )
  alerts += n.Notifications?.length ?? 0
}
check('budget alert exists', alerts > 0, `${Budgets.length} budget(s), ${alerts} alert(s)`)

const health = await fetch(`${out.Url}/api/health`)
  .then((r) => (r.ok ? (r.json() as Promise<{ version: string }>) : null))
  .catch(() => null)
check('public URL serves the control API', Boolean(health), health ? `version ${health.version}` : 'no response')

const failed = checks.filter((c) => c.ok === false).length
const skipped = checks.filter((c) => c.ok === null).length
console.log(failed ? `\n${failed} check(s) failed` : skipped ? '\nall run checks passed (some skipped)' : '\nM0 done')
process.exit(failed ? 1 : 0)
