import type { Vm } from '@substrate/protocol'

export type Alert = {
  vm: Pick<Vm, 'id' | 'name'>
  title: string
  message: string
  // low: no sound. high: sound and a pop-up.
  priority: 'low' | 'default' | 'high'
  // ntfy shows these emoji short codes before the title.
  tags: string[]
}
export type Notify = (alert: Alert) => Promise<void>

const priorities = { low: 2, default: 3, high: 4 }

// Publishes to ntfy (https://docs.ntfy.sh/publish/). Subscribers to the topic
// get a push notification. A failure is logged, never thrown.
export function ntfy({ server, topic }: { server: string; topic: string }, publicUrl: string | null): Notify {
  return async ({ vm, title, message, priority, tags }) => {
    const click = publicUrl ? `${publicUrl.replace(/\/$/, '')}/#${new URLSearchParams({ vm: vm.id })}` : undefined
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, title, message, priority: priorities[priority], tags, click }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: Error) => err)
    if (res instanceof Error || !res.ok) {
      console.error(`ntfy: couldn't send "${title}": ${res instanceof Error ? res.message : res.status}`)
    }
  }
}

export const logOnly: Notify = async ({ vm, title, message }) => console.log(`alert for ${vm.id}: ${title}: ${message}`)
