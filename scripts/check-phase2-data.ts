// Checks RDS/IAM, KMS, and the migrated stores using the control instance role.
// --backup only records the pre-deployment state, without applying migrations.
import { $ } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { region, run, stackOutputs, upload } from './lib/aws.ts'

const { ControlInstanceId: control, ArtifactsBucket: bucket } = await stackOutputs()
const marker = randomUUID(), directory = await mkdtemp(join(tmpdir(), 'substrate-phase2-'))
const key = `control/checks/phase2/${marker}/probe`, remote = `/tmp/substrate-phase2-${marker}`
try {
  const binary = join(directory, 'probe')
  await $`bun build --compile --minify --target=bun-linux-arm64 ${join(import.meta.dir, 'lib/phase2-control-probe.ts')} --outfile ${binary}`.quiet()
  await upload(bucket, key, await Bun.file(binary).bytes())
  const result = await run(control, [
    'set -e', `install -d -m 755 '${remote}'`, `trap 'rm -rf ${remote}' EXIT`,
    `aws s3 cp --quiet 's3://${bucket}/${key}' '${remote}/probe'`, `chmod 755 '${remote}/probe'`,
    'set -a', 'source /etc/substrate/control.env', 'source /etc/substrate/control-secrets.env', 'set +a',
    'export SUBSTRATE_DB=/var/lib/substrate/control.db',
    `runuser --preserve-environment -u substrate -- '${remote}/probe' ${process.argv.includes('--backup') ? '--backup' : ''}`,
  ].join('\n'), 180)
  if (result.stdout.trim()) console.log(result.stdout.trim())
  if (!result.ok) throw new Error(result.stderr || 'Phase 2 data check failed')
} finally {
  await new S3Client({ region }).send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {})
  await rm(directory, { recursive: true, force: true })
}
