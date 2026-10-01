/** Concurrent calls for the same key share one in-flight promise. */
export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  run(key: K, task: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = task().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
