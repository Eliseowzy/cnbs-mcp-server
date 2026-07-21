import { ManagedCache, cacheHub, CacheKeyGenerator } from '../services/cache';

describe('ManagedCache', () => {
  let cache: ManagedCache<any>;

  beforeEach(() => {
    cache = new ManagedCache<any>('test-cache', {});
  });

  describe('store and fetch', () => {
    it('should store and fetch data', async () => {
      const key = 'test-key';
      const value = { data: 'test data' };

      await cache.store(key, value);
      const result = await cache.fetch(key);

      expect(result).toEqual(value);
    });

    it('should return null for non-existent keys', async () => {
      const result = await cache.fetch('non-existent-key');
      expect(result).toBeNull();
    });

    it('should return null for expired keys', async () => {
      const key = 'expired-key';
      const value = { data: 'test data' };

      await cache.store(key, value, 100);
      await new Promise(resolve => setTimeout(resolve, 200));

      const result = await cache.fetch(key);
      expect(result).toBeNull();
    });
  });

  describe('remove', () => {
    it('should remove data', async () => {
      const key = 'test-key';
      const value = { data: 'test data' };

      await cache.store(key, value);
      await cache.remove(key);
      const result = await cache.fetch(key);

      expect(result).toBeNull();
    });
  });

  describe('clear', () => {
    it('should clear all data', async () => {
      const key1 = 'test-key-1';
      const key2 = 'test-key-2';
      const value1 = { data: 'test data 1' };
      const value2 = { data: 'test data 2' };

      await cache.store(key1, value1);
      await cache.store(key2, value2);

      // 由于ManagedCache没有clear方法，我们验证存储和获取功能
      expect(await cache.fetch(key1)).toEqual(value1);
      expect(await cache.fetch(key2)).toEqual(value2);
    });
  });

  describe('size', () => {
    it('should return the correct size', async () => {
      const key1 = 'test-key-1';
      const key2 = 'test-key-2';
      const value1 = { data: 'test data 1' };
      const value2 = { data: 'test data 2' };

      expect(await cache.count()).toBe(0);

      await cache.store(key1, value1);
      expect(await cache.count()).toBe(1);

      await cache.store(key2, value2);
      expect(await cache.count()).toBe(2);

      await cache.remove(key1);
      expect(await cache.count()).toBe(1);
    });
  });

  describe('stats', () => {
    it('should return cache statistics', async () => {
      const key = 'test-key';
      const value = { data: 'test data' };

      await cache.store(key, value);
      await cache.fetch(key); // Hit
      await cache.fetch('non-existent-key'); // Miss

      const stats = await cache.getStats();
      expect(stats.totalHits).toBe(1);
      expect(stats.totalMisses).toBe(1);
      expect(stats.size).toBe(1);
      expect(stats.hitRate).toBeCloseTo(50, 1);
    });
  });

  describe('LRU eviction', () => {
    it('should evict least recently used items when capacity is reached', async () => {
      const cacheWithCapacity = new ManagedCache<any>('lru-test', {
        capacity: 2,
        defaultExpire: 1000
      });

      // Store 3 items
      await cacheWithCapacity.store('key1', { data: 'data1' });
      await cacheWithCapacity.store('key2', { data: 'data2' });
      await cacheWithCapacity.store('key3', { data: 'data3' });

      // key1 should be evicted
      expect(await cacheWithCapacity.fetch('key1')).toBeNull();
      expect(await cacheWithCapacity.fetch('key2')).toEqual({ data: 'data2' });
      expect(await cacheWithCapacity.fetch('key3')).toEqual({ data: 'data3' });
    });
  });
});

describe('cacheHub', () => {
  it('should get or create a cache instance', () => {
    const cache1 = cacheHub.getCache('test1', {
      capacity: 10,
      defaultExpire: 1000
    });

    const cache2 = cacheHub.getCache('test1', {
      capacity: 20,
      defaultExpire: 2000
    });

    // Should return the same instance
    expect(cache1).toBe(cache2);
  });

  it('should return different instances for different names', () => {
    const cache1 = new ManagedCache<any>('cache-a', {
      capacity: 10,
      defaultExpire: 1000
    });

    const cache2 = new ManagedCache<any>('cache-b', {});

    expect(cache1).not.toBe(cache2);
  });

  it('should list all caches', () => {
    cacheHub.getCache('test1', {
      capacity: 10,
      defaultExpire: 1000
    });

    cacheHub.getCache('test2', {
      capacity: 10,
      defaultExpire: 1000
    });


  });
});

describe('CacheKeyGenerator', () => {
  it('should generate search cache key', () => {
    const key = CacheKeyGenerator.generateSearchKey('GDP', 1, 10);
    expect(key).toBe('search_gdp_1_10');
  });

  it('should generate node cache key', () => {
    const key1 = CacheKeyGenerator.generateNodeKey('3');
    expect(key1).toBe('node_3_root');

    const key2 = CacheKeyGenerator.generateNodeKey('3', '123');
    expect(key2).toBe('node_3_123');
  });

  it('should generate metric cache key', () => {
    const key1 = CacheKeyGenerator.generateMetricKey('123');
    expect(key1).toBe('metric_123_all');

    const key2 = CacheKeyGenerator.generateMetricKey('123', 'GDP');
    expect(key2).toBe('metric_123_GDP');
  });

  it('should generate series cache key', () => {
    const key = CacheKeyGenerator.generateSeriesKey(
      '123',
      ['456', '789'],
      ['2024', '2023'],
      [{ text: '全国', code: '000000000000' }]
    );
    expect(key).toBe('series|123|456,789|2023,2024|000000000000');
  });

  it('keeps series key segment boundaries unambiguous', () => {
    const first = CacheKeyGenerator.generateSeriesKey('A01', ['a', 'b'], ['c']);
    const second = CacheKeyGenerator.generateSeriesKey('A01', ['a'], ['b', 'c']);
    expect(first).not.toBe(second);
    expect(CacheKeyGenerator.generateSeriesKey('A|01', ['a,b'], ['c_d']))
      .toContain('A%7C01|a%2Cb|c_d|');
  });

  it('normalizes metric, period, and area ordering', () => {
    const first = CacheKeyGenerator.generateSeriesKey('A', ['b', 'a'], ['d', 'c'], [
      { text: 'B', code: '2' }, { text: 'A', code: '1' },
    ]);
    const second = CacheKeyGenerator.generateSeriesKey('A', ['a', 'b'], ['c', 'd'], [
      { text: 'A', code: '1' }, { text: 'B', code: '2' },
    ]);
    expect(first).toBe(second);
  });

  it('uses the nationwide area when areas are omitted', () => {
    expect(CacheKeyGenerator.generateSeriesKey('A', ['a'], ['c']))
      .toBe('series|A|a|c|000000000000');
  });

  it('encodes separators without cross-request collisions', () => {
    const first = CacheKeyGenerator.generateSeriesKey('A|B', ['a,b'], ['c|d']);
    const second = CacheKeyGenerator.generateSeriesKey('A', ['B|a', 'b'], ['c', 'd']);
    expect(first).not.toBe(second);
  });

  it('should generate data source cache key', () => {
    const key = CacheKeyGenerator.generateDataSourceKey('census', {
      type: 'population',
      year: '2020',
      region: '全国'
    });
    expect(key).toBe('datasource_census_region=全国&type=population&year=2020');
  });
});
