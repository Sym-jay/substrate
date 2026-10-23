import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { githubWrapper } from './repository.ts'

test('the gh wrapper loads the fine-grained token without placing it in command arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'substrate-github-test-'))
  try {
    const credential = join(directory, 'token'), capture = join(directory, 'capture-gh'), wrapper = join(directory, 'gh')
    await writeFile(credential, 'synthetic-test-token', { mode: 0o600 })
    await writeFile(capture, '#!/bin/sh\nprintf "%s|%s" "$GH_TOKEN" "$*"\n', { mode: 0o755 })
    await writeFile(wrapper, githubWrapper.replaceAll('$HOME/.config/substrate/github-token', credential).replace('/usr/bin/gh', capture), { mode: 0o755 })
    const child = Bun.spawn([wrapper, 'auth', 'git-credential'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await new Response(child.stdout).text()).toBe('synthetic-test-token|auth git-credential')
    expect(await child.exited).toBe(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
