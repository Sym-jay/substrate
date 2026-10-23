// Creates the SecureStrings in Parameter Store that the boxes read at deploy
// time, so no secret ever passes through a shell or this repo. Safe to run
// again: an existing parameter is left alone.
//   bun run secrets
import { GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { randomBytes } from 'node:crypto'
import { region } from './lib/aws.ts'

const ssm = new SSMClient({ region })

// control → hostd. install-hostd.sh and setup-control.sh both read it.
const HOSTD_TOKEN = '/substrate/hostd-token'

const exists = await ssm
  .send(new GetParameterCommand({ Name: HOSTD_TOKEN }))
  .then(() => true)
  .catch((err: Error) => {
    if (err.name === 'ParameterNotFound') return false
    throw err
  })

if (exists) {
  console.log(`${HOSTD_TOKEN} already exists`)
} else {
  await ssm.send(
    new PutParameterCommand({ Name: HOSTD_TOKEN, Type: 'SecureString', Value: randomBytes(32).toString('hex') }),
  )
  console.log(`created ${HOSTD_TOKEN}. Run \`bun run deploy:host\` and \`bun run deploy:control\` to use it.`)
}
