// An error that becomes this HTTP status (and message) in hostd's API.
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message)
  }
}

// For logs: one line. Logging the error itself makes the bundled binary print
// screenfuls of minified source.
export const message = (err: unknown) => (err instanceof Error ? err.message : String(err))
