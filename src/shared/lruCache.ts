/**
 * A size-bounded map that evicts the least recently written entry. `Map` iterates in insertion
 * order, so re-inserting on every write keeps the oldest entry first.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): V | undefined {
    return this.entries.get(key);
  }

  /** Store `value` as the most recent entry, evicting the oldest beyond capacity. */
  set(key: K, value: V): void {
    if (this.maxEntries <= 0) return;
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }
}
