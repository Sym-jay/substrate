import type { z } from 'zod'
import { GitHubRepo } from '@substrate/protocol'
import { mkdir, writeFile, chmod, chown } from 'node:fs/promises'

// gh recommends GH_TOKEN for fine-grained PATs rather than its classic-token
// login flow. The wrapper also works in SSH's non-login command shells.
export const githubWrapper = `#!/bin/sh
if [ -r "$HOME/.config/substrate/github-token" ]; then
  GH_TOKEN=$(cat "$HOME/.config/substrate/github-token")
  export GH_TOKEN
fi
exec /usr/bin/gh "$@"
`

export async function setupRepository(repository: z.infer<typeof GitHubRepo>, token?: string) {
  const run = async (command: string) => {
    const child = Bun.spawn(['runuser', '-l', 'dev', '-c', command], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'ignore',
    })
    return await child.exited === 0
  }
  if (token) {
    const directory = '/home/dev/.config/substrate', credential = `${directory}/github-token`, wrapper = '/home/dev/.local/bin/gh'
    await mkdir('/home/dev/.config', { recursive: true, mode: 0o700 })
    await chown('/home/dev/.config', 1000, 1000)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(credential, token, { mode: 0o600 })
    await chmod(directory, 0o700); await chmod(credential, 0o600)
    await chown(directory, 1000, 1000); await chown(credential, 1000, 1000)
    await writeFile(wrapper, githubWrapper, { mode: 0o755 })
    await chown(wrapper, 1000, 1000)
    if (!(await run(`git config --global --replace-all credential.https://github.com.helper '' && git config --global --add credential.https://github.com.helper '!/home/dev/.local/bin/gh auth git-credential'`))) throw new Error('Could not configure GitHub credentials')
    if (!(await run(`login=$(gh api user --jq .login) && user_id=$(gh api user --jq .id) && git config --global user.name "$login" && git config --global user.email "$user_id+$login@users.noreply.github.com"`))) throw new Error('Could not configure the GitHub commit identity')
  }
  if (!(await run(`git clone -- 'https://github.com/${repository}.git' '/home/dev/workspace'`))) throw new Error('Could not clone the repository; check its name and token access')
}
