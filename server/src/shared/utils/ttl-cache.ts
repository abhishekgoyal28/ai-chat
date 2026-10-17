/**
 * A small read-through cache with a time-to-live and request coalescing:
 * concurrent misses for one key share a single load instead of stampeding the
 * database. Misses (null) are cached too, for a shorter time, so a deleted
 * row is not re-queried on every request.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V | null; expiresAt: number }>();
  private readonly loading = new Map<string, Promise<V | null>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  async get(key: string, load: () => Promise<V | null>): Promise<V | null> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    const pending = this.loading.get(key);
    if (pending) {
      return pending;
    }
    const promise = load()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, promise);
    return promise;
  }

  invalidate(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
    } else {
      this.entries.delete(key);
    }
  }

  private set(key: string, value: V | null): void {
    if (this.ttlMs <= 0) {
      return;
    }
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    const ttl = value === null ? Math.min(this.ttlMs, 5000) : this.ttlMs;
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });
  }
}
