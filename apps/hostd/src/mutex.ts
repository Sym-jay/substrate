// Runs async sections one at a time, in the order they asked.
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.catch(() => {})
    return result
  }
}
