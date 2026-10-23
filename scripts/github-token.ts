// Read a fine-grained GitHub token privately and store it for one Clerk user.
// Never pass the token on the command line or paste it into a chat. Since
// Phase 2 users connect GitHub themselves from the dashboard; tokens stored
// here still work until they do.
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { region } from './lib/aws.ts'
import { readSecret } from './lib/read-secret.ts'

const userId = process.argv[2]
if (!userId || !/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('usage: bun run github:token <Clerk user ID>')
const token = await readSecret('Fine-grained GitHub token')
if (!/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error('Use a fine-grained GitHub token limited to the repositories this user may access')
await new SSMClient({ region }).send(new PutParameterCommand({ Name: `/substrate/github/${userId}`, Value: token, Type: 'SecureString', Overwrite: true }))
console.log('Stored GitHub credentials for this user. New repository workspaces can use them.')
