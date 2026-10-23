import { randomBytes, timingSafeEqual } from 'node:crypto'

// hostd's bearer tokens: the current one and, while a rotation settles, the
// previous one. A timer on the host (refresh-token.sh) keeps both files in
// step with Parameter Store, where a scheduled rotation replaces the token;
// they're reread at most every 30 seconds.
export class Tokens {
  private cached: { at: number; tokens: string[] } | null = null

  constructor(private readonly paths: { current: string; previous: string }, private readonly now = Date.now) {}

  // The current token, made on first start if there's none.
  async init() {
    const file = Bun.file(this.paths.current)
    if (!(await file.exists())) await Bun.write(this.paths.current, randomBytes(32).toString('hex'), { mode: 0o600 })
    return (await this.read())[0]!
  }

  async verify(token: string) {
    const given = Buffer.from(token)
    return (await this.read()).some((known) => {
      const expected = Buffer.from(known)
      return expected.length === given.length && timingSafeEqual(expected, given)
    })
  }

  private async read() {
    if (this.cached && this.now() - this.cached.at < 30_000) return this.cached.tokens
    const read = (path: string) => Bun.file(path).text().then((text) => text.trim(), () => '')
    const tokens = [await read(this.paths.current), await read(this.paths.previous)].filter(Boolean)
    this.cached = { at: this.now(), tokens }
    return tokens
  }
}
