import { run } from './aws.ts'

export type HostdResponse<T> = { status: number; data: T }

// Calls hostd's API on the host through SSM, so it needs no open port or
// tunnel. Each call takes a couple of seconds. Large responses (over SSM's
// 24 KB output limit) come back truncated.
export async function hostd<T>(
  hostInstanceId: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<HostdResponse<T>> {
  const send = body === undefined ? '' : `printf %s '${Buffer.from(JSON.stringify(body)).toString('base64')}' | base64 -d |`
  const result = await run(
    hostInstanceId,
    [
      'set -e',
      'token=$(cat /var/lib/substrate/hostd-token)',
      'res=$(mktemp)',
      `status=$(${send} curl -sS -o "$res" -w '%{http_code}' -X ${method} -H "Authorization: Bearer $token" -H 'content-type: application/json' ${body === undefined ? '' : '--data-binary @-'} http://127.0.0.1:7070${path})`,
      'echo "$status"',
      'cat "$res"',
      'rm -f "$res"',
    ].join('\n'),
    900,
  )
  if (!result.ok) throw new Error(`couldn't reach hostd: ${result.stderr.trim() || result.status}`)

  const [statusLine = '', ...rest] = result.stdout.split('\n')
  const text = rest.join('\n').trim()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`hostd returned something that isn't JSON (${statusLine}): ${text.slice(0, 500)}`)
  }
  return { status: Number(statusLine), data: data as T }
}

export function errorMessage(res: HostdResponse<unknown>) {
  const data = res.data as { error?: string } | null
  return `hostd returned ${res.status}${data?.error ? `: ${data.error}` : ''}`
}
