export class TelegramError extends Error {
  constructor(readonly code: string, readonly retryAfter = 0, readonly permanent = false) { super(code) }
}

// Fixed origin: neither users nor webhook payloads choose an outbound server.
// Errors deliberately omit Telegram's request URL (which contains the bot token).
export type TelegramFetch = (input: string, init: RequestInit) => Promise<Response>
export class Telegram {
  constructor(private token: string, private request: TelegramFetch = fetch) {}
  async call<T>(method: string, body: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.request(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      })
    } catch { throw new TelegramError('telegram_unreachable') }
    const data = await response.json().catch(() => null) as { ok?: boolean; result?: T; error_code?: number; parameters?: { retry_after?: number } } | null
    if (!response.ok || !data?.ok) {
      const code = data?.error_code ?? response.status
      const delay = data?.parameters?.retry_after
      throw new TelegramError(`telegram_${code}`, Number.isFinite(delay) ? Math.max(0, Math.min(delay!, 86_400)) : 0, code === 400 || code === 403)
    }
    return data.result!
  }
  async send(chatId: string, text: string, url: string) {
    await this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Open in Substrate', url }]] } })
  }
}
