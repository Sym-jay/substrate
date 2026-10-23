// Checks M1's "Done when" list: creates a default-size VM, checks its boot
// time, internet, Docker and agent CLIs, checks it's walled off from the host
// and the VPC, checks files survive a stop and start, then deletes it.
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2'
import type { ExecResult, HostdHealth, Vm } from '@substrate/protocol'
import { ec2, instanceState, stackOutputs } from './lib/aws.ts'
import { errorMessage, hostd } from './lib/hostd.ts'

const BOOT_TARGET_MS = 4_000

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `: ${detail}` : ''}`)
}

const out = await stackOutputs()
const host = out.HostInstanceId
if ((await instanceState(host)) !== 'running') {
  console.error('the host is stopped. Start it with `bun run host start`.')
  process.exit(1)
}

const health = await hostd<HostdHealth>(host, 'GET', '/health')
check('hostd running', health.status === 200, health.data?.version)
if (!health.data?.image) {
  check('VM image built', false, 'run `bun run images:build`')
  process.exit(1)
}
check('VM image built', true, health.data.image)

const created = await hostd<Vm>(host, 'POST', '/vms', { name: `m1-check-${Date.now() % 100_000}` })
if (created.status !== 201) {
  check('default VM created', false, errorMessage(created))
  process.exit(1)
}
const vm = created.data
check('default VM created', vm.vcpus === 6 && vm.memMib === 16_384, `${vm.vcpus} vCPU / ${vm.memMib / 1024} GiB`)

try {
  const bootMs = vm.bootMs ?? Infinity
  check(`boots in about ${BOOT_TARGET_MS / 1000} s or less`, bootMs <= BOOT_TARGET_MS * 1.1, `${(bootMs / 1000).toFixed(2)} s`)

  const { Reservations } = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [host] }))
  const hostPrivateIp = Reservations?.[0]?.Instances?.[0]?.PrivateIpAddress ?? ''
  const gateway = vm.guestIp.replace(/\.\d+$/, (last) => `.${Number(last.slice(1)) - 1}`)

  const exec = await hostd<ExecResult>(host, 'POST', `/vms/${vm.id}/exec`, {
    timeoutMs: 240_000,
    command: `
      echo "internet=$(curl -sS -o /dev/null -w '%{http_code}' -m 10 https://www.google.com 2>&1)"
      for i in $(seq 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
      if docker run --rm hello-world 2>&1 | grep -q 'Hello from Docker'; then echo docker=ok; else echo docker=failed; fi
      for tool in claude codex opencode agy; do echo "$tool=$($tool --version 2>&1 | head -1)"; done
      echo "node=$(node --version)"; echo "bun=$(bun --version)"; echo "python=$(python3 --version)"; echo "gh=$(gh --version | head -1)"
      echo "disk_gib=$(df -BG --output=size / | tail -1 | tr -dc 0-9)"
      echo "hostd_via_gateway=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://${gateway}:7070/health)"
      echo "hostd_via_vpc=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://${hostPrivateIp}:7070/health)"
    `,
  })
  if (exec.status !== 200) {
    check('commands run inside the VM', false, errorMessage(exec))
  } else {
    const facts = Object.fromEntries(
      exec.data.stdout
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
    )
    check('has internet', facts.internet === '200', `HTTPS to google.com returned ${facts.internet}`)
    check('docker run hello-world', facts.docker === 'ok')
    // The filesystem should fill the VM's disk, less ext4's own overhead.
    check('root filesystem fills the disk', Number(facts.disk_gib) >= vm.diskGib * 0.9, `${facts.disk_gib} GiB of ${vm.diskGib}`)
    for (const tool of ['claude', 'codex', 'opencode', 'agy', 'node', 'bun', 'python', 'gh']) {
      const value = facts[tool] ?? ''
      check(`${tool} installed`, Boolean(value) && !/not found|error/i.test(value), value || 'missing')
    }
    // 000 means the connection never got through, which is what we want.
    check("can't reach hostd through its gateway", facts.hostd_via_gateway === '000', facts.hostd_via_gateway)
    check("can't reach the VPC", facts.hostd_via_vpc === '000', facts.hostd_via_vpc)
  }

  // Written just before the stop, so it's only on disk if the VM shut down cleanly.
  const marker = `persist-${Date.now()}`
  await hostd(host, 'POST', `/vms/${vm.id}/exec`, { command: `echo ${marker} > ~/marker` })
  const stopStarted = Date.now()
  const stopped = await hostd<Vm>(host, 'POST', `/vms/${vm.id}/stop`)
  const stopSeconds = ((Date.now() - stopStarted) / 1000).toFixed(1)
  const restarted = await hostd<Vm>(host, 'POST', `/vms/${vm.id}/start`)
  const read = await hostd<ExecResult>(host, 'POST', `/vms/${vm.id}/exec`, { command: 'cat ~/marker' })
  check(
    'files survive a stop and start',
    stopped.data?.state === 'stopped' && read.data?.stdout.trim() === marker,
    `stop ${stopSeconds} s (incl. SSM), restart ${((restarted.data?.bootMs ?? 0) / 1000).toFixed(1)} s`,
  )
} finally {
  const deleted = await hostd(host, 'DELETE', `/vms/${vm.id}`)
  check('VM deleted', deleted.status === 204)
}

console.log(failed ? `\n${failed} check(s) failed` : '\nM1 done')
process.exit(failed ? 1 : 0)
