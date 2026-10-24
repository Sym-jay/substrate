import { $ } from 'bun'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
const target = process.argv[2] ?? `bun-${process.platform}-${process.arch}`
if (!['bun-darwin-arm64', 'bun-darwin-x64', 'bun-linux-arm64', 'bun-linux-x64'].includes(target)) throw new Error('Choose bun-darwin-arm64, bun-darwin-x64, bun-linux-arm64, or bun-linux-x64.')
const output = join(import.meta.dir, '../../dist/cli', target, 'substrate')
await mkdir(join(output, '..'), { recursive: true })
await $`bun build --compile --minify --target=${target} ${join(import.meta.dir, 'src/index.ts')} --outfile ${output}`
console.log(output)
