interface Entry {
  value: unknown;
  expiresAt: number;
}

export interface MemoryCacheOptions {
  /** Upper bound on stored entries; the oldest are evicted first. */
  maxEntries?: number;
  /** Clock, injectable for tests. */
  now?: () => number;
}

/**
 * Small in-process TTL cache for public GET responses.
 * Keys are namespaced strings (e.g. "movies:list:NOW_SHOWING") so that admin writes can
 * invalidate a whole group with `invalidatePrefix("movies:")`.
 */
export class MemoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor({ maxEntries = 1000, now = Date.now }: MemoryCacheOptions = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): unknown {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.entries.delete(key); // re-insert so Map order tracks age
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    this.evict();
  }

  /**
   * Returns the cached value, or runs `load` once (even for concurrent callers) and caches it.
   * Failed loads are not cached. A load that was in flight when its key was invalidated is
   * returned to its callers but not cached, so stale data never outlives an invalidation.
   */
  async getOrSet<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) return entry.value as T;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = load().then(
      (value) => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
          this.set(key, value, ttlMs);
        }
        return value;
      },
      (error: unknown) => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
        throw error;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  /** Removes every entry (and abandons every in-flight load) whose key starts with `prefix`. */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.entries.keys(), ...this.inflight.keys()]) {
      if (key.startsWith(prefix)) this.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  private evict(): void {
    const now = this.now();
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
