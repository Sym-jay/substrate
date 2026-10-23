// Read a fine-grained GitHub token privately and store it for one Clerk user.
// Never pass the token on the command line or paste it into a chat.
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { region } from './lib/aws.ts'

const userId = process.argv[2]
if (!userId || !/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error('usage: bun run github:token <Clerk user ID>')
async function readSecret(): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim()
  process.stderr.write('Fine-grained GitHub token (hidden): ')
  const wasRaw = process.stdin.isRaw
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const done = () => { process.stdin.off('data', input); process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stderr.write('\n') }
    const input = (buffer: Buffer) => {
      for (const char of buffer.toString()) {
        if (char === '\x03') { done(); reject(new Error('cancelled')); return }
        if (char === '\r' || char === '\n') { done(); resolve(value.trim()); return }
        if (char === '\x7f' || char === '\b') value = value.slice(0, -1)
        else value += char
      }
    }
    process.stdin.on('data', input)
  })
}
const token = await readSecret()
if (!/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error('Use a fine-grained GitHub token limited to the repositories this user may access')
await new SSMClient({ region }).send(new PutParameterCommand({ Name: `/substrate/github/${userId}`, Value: token, Type: 'SecureString', Overwrite: true }))
console.log('Stored GitHub credentials for this user. New repository workspaces can use them.')
