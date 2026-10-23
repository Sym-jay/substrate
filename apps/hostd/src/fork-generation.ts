// Keep the source frozen until every destination has its own disk/memory copy.
// Register each child before copying so a partial copy is cleaned up too.
export async function forkGeneration<D, P, C>(options: {
  destinations: D[]
  capture: () => Promise<P>
  makeChild: (destination: D, point: P, children: C[]) => C
  copy: (child: C, point: P) => Promise<void>
  resume: (child: C) => Promise<void>
  remove: (child: C) => Promise<void>
  releaseSource: () => Promise<void>
}) {
  const children: C[] = []
  try {
    const point = await options.capture()
    for (const destination of options.destinations) {
      const child = options.makeChild(destination, point, children)
      children.push(child)
      await options.copy(child, point)
    }
    for (const child of children) await options.resume(child)
    return { children, point }
  } catch (error) {
    for (const child of children) await options.remove(child).catch((cleanupError) => console.error('fork cleanup:', cleanupError))
    throw error
  } finally { await options.releaseSource() }
}
