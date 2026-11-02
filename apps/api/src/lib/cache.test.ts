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

    describe('a load overtaken by an invalidation', () => {
      /** A load whose result the test releases by hand. */
      function deferredLoad() {
        let resolve: (value: string) => void = () => undefined;
        let reject: (error: Error) => void = () => undefined;
        const load = () =>
          new Promise<string>((res, rej) => {
            resolve = res;
            reject = rej;
          });
        return {
          load,
          resolve: (value: string) => {
            resolve(value);
          },
          reject: (error: Error) => {
            reject(error);
          },
        };
      }

      it('later callers start a new load instead of joining the abandoned one', async () => {
        const { cache } = cacheWithClock();
        const old = deferredLoad();
        const first = cache.getOrSet('movies:list', 60_000, old.load);

        cache.invalidatePrefix('movies:');
        const load = vi.fn().mockResolvedValue('fresh');
        expect(await cache.getOrSet('movies:list', 60_000, load)).toBe('fresh');
        expect(load).toHaveBeenCalledTimes(1);

        old.resolve('stale');
        await first;
      });

      it('an older load finishing AFTER the newer one does not overwrite it', async () => {
        const { cache } = cacheWithClock();
        const old = deferredLoad();
        const first = cache.getOrSet('movies:list', 60_000, old.load);

        cache.invalidatePrefix('movies:');
        await cache.getOrSet('movies:list', 60_000, () => Promise.resolve('fresh'));

        old.resolve('stale');
        expect(await first).toBe('stale');
        expect(cache.get('movies:list')).toBe('fresh');
      });

      it('an older load finishing BEFORE the newer one neither stores nor drops it', async () => {
        const { cache } = cacheWithClock();
        const old = deferredLoad();
        const first = cache.getOrSet('movies:list', 60_000, old.load);

        cache.invalidatePrefix('movies:');
        const fresh = deferredLoad();
        const second = cache.getOrSet('movies:list', 60_000, fresh.load);

        old.resolve('stale');
        await first;
        expect(cache.get('movies:list')).toBeUndefined();

        // The newer load is still the one in flight: a third caller joins it.
        const load = vi.fn().mockResolvedValue('third');
        const third = cache.getOrSet('movies:list', 60_000, load);
        fresh.resolve('fresh');
        expect(await second).toBe('fresh');
        expect(await third).toBe('fresh');
        expect(load).not.toHaveBeenCalled();
        expect(cache.get('movies:list')).toBe('fresh');
      });

      it('an older load failing does not disturb the newer one', async () => {
        const { cache } = cacheWithClock();
        const old = deferredLoad();
        const first = cache.getOrSet('movies:list', 60_000, old.load);

        cache.invalidatePrefix('movies:');
        const fresh = deferredLoad();
        const second = cache.getOrSet('movies:list', 60_000, fresh.load);

        old.reject(new Error('db down'));
        await expect(first).rejects.toThrow('db down');

        fresh.resolve('fresh');
        expect(await second).toBe('fresh');
        expect(cache.get('movies:list')).toBe('fresh');
      });

      it('an invalidation of another prefix does not abandon the load', async () => {
        const { cache } = cacheWithClock();
        const load = deferredLoad();
        const pending = cache.getOrSet('movies:list', 60_000, load.load);

        cache.invalidatePrefix('screens:');
        load.resolve('fresh');
        await pending;

        expect(cache.get('movies:list')).toBe('fresh');
      });
    });
  });
});
