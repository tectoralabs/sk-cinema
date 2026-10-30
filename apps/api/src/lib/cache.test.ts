import { describe, expect, it, vi } from 'vitest';
import { MemoryCache } from './cache.js';

function cacheWithClock(options: { maxEntries?: number } = {}) {
  let now = 1_000_000;
  const cache = new MemoryCache({ ...options, now: () => now });
  const advance = (ms: number) => {
    now += ms;
  };
  return { cache, advance };
}

describe('MemoryCache', () => {
  it('returns values until they expire', () => {
    const { cache, advance } = cacheWithClock();
    cache.set('movies:list', ['a'], 1000);
    expect(cache.get('movies:list')).toEqual(['a']);
    advance(999);
    expect(cache.get('movies:list')).toEqual(['a']);
    advance(1);
    expect(cache.get('movies:list')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('invalidates every key with a prefix and nothing else', () => {
    const { cache } = cacheWithClock();
    cache.set('movies:list:NOW_SHOWING', 1, 60_000);
    cache.set('movies:detail:abc', 2, 60_000);
    cache.set('showtimes:abc', 3, 60_000);
    cache.invalidatePrefix('movies:');
    expect(cache.get('movies:list:NOW_SHOWING')).toBeUndefined();
    expect(cache.get('movies:detail:abc')).toBeUndefined();
    expect(cache.get('showtimes:abc')).toBe(3);
  });

  it('evicts the oldest entries beyond maxEntries', () => {
    const { cache } = cacheWithClock({ maxEntries: 2 });
    cache.set('a', 1, 60_000);
    cache.set('b', 2, 60_000);
    cache.set('c', 3, 60_000);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  describe('getOrSet', () => {
    it('loads once, then serves from cache until expiry', async () => {
      const { cache, advance } = cacheWithClock();
      const load = vi.fn().mockResolvedValue('fresh');
      expect(await cache.getOrSet('k', 1000, load)).toBe('fresh');
      expect(await cache.getOrSet('k', 1000, load)).toBe('fresh');
      expect(load).toHaveBeenCalledTimes(1);
      advance(1000);
      await cache.getOrSet('k', 1000, load);
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('shares one load between concurrent callers', async () => {
      const { cache } = cacheWithClock();
      const load = vi.fn().mockResolvedValue(42);
      const results = await Promise.all([1, 2, 3].map(() => cache.getOrSet('k', 1000, load)));
      expect(results).toEqual([42, 42, 42]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('does not cache failed loads', async () => {
      const { cache } = cacheWithClock();
      const load = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue('ok');
      await expect(cache.getOrSet('k', 1000, load)).rejects.toThrow('db down');
      expect(await cache.getOrSet('k', 1000, load)).toBe('ok');
      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not cache a load that was in flight when its key was invalidated', async () => {
      const { cache } = cacheWithClock();
      let resolve: (value: string) => void = () => undefined;
      const pending = cache.getOrSet(
        'movies:list',
        60_000,
        () =>
          new Promise<string>((r) => {
            resolve = r;
          }),
      );

      cache.invalidatePrefix('movies:'); // an admin write lands mid-load
      resolve('stale');

      expect(await pending).toBe('stale');
      expect(cache.get('movies:list')).toBeUndefined();
    });
  });
});
