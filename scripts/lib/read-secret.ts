// Reads a secret from the terminal without echoing it, or from stdin when it's
// piped. Never pass secrets on the command line or paste them into a chat.
export async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim()
  process.stderr.write(`${prompt} (hidden): `)
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
