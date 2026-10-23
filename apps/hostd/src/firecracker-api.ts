import type { FirecrackerApi } from './generated/firecracker.ts'

export function firecrackerClient(socket: string) {
  return async <K extends keyof FirecrackerApi>(operation: K, body: FirecrackerApi[K]['body'], timeoutMs = 5_000): Promise<FirecrackerApi[K]['response']> => {
    const [method, path] = operation.split(' ')
    const response = await fetch(`http://localhost${path}`, {
      unix: socket,
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Firecracker ${operation}: ${response.status} ${await response.text()}`)
    return (response.status === 204 ? undefined : await response.json()) as FirecrackerApi[K]['response']
  }
}
