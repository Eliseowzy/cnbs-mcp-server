// src/services/cache.ts
// Cache module: a backend-agnostic adapter layer over pluggable cache backends.
// The default backend wraps the mature `lru-cache` library; Redis is reserved
// as a future backend behind the same `CacheBackend` interface.
import { LRUCache } from 'lru-cache';
import { createLogger } from '../logger.js';
import {
  cacheHitsTotal,
  cacheMissesTotal,
  cacheEvictionsTotal,
  cacheExpirationsTotal,
} from './metrics.js';

const log = createLogger('cache');

// ─── 类型定义 ────────────────────────────────────────────────────────────────

export type CacheBackendKind = 'memory' | 'redis';

/**
 * 统一存储载荷。TTL、SWR 和统计逻辑都基于该信封在适配层实现，
 * 使这些语义与具体后端（内存 / Redis）解耦。
 */
interface CacheEnvelope<T> {
  value: T;
  expireAt: number;
  hitCount: number;
  lastHit: number;
  storedAt: number;
  size: number;
}

interface CacheOptions {
  capacity?: number;
  defaultExpire?: number;
  maxMemorySize?: number;
  cleanupInterval?: number; // 保留字段兼容旧调用，当前已由底层库接管淘汰
  backend?: CacheBackendKind;
}

interface CacheStats {
  size: number;
  capacity: number;
  memorySize: number;
  maxMemorySize: number;
  oldestEntry: { key: string; age: number } | null;
  topHit: { key: string; count: number } | null;
  hitRate: number;
  missRate: number;
  totalHits: number;
  totalMisses: number;
  evictionCount: number;
  expirationCount: number;
  persistenceCount: number; // 保留字段兼容上层调用，恒为 0
}

// ─── 缓存后端抽象 ────────────────────────────────────────────────────────────

export interface CacheBackendOptions {
  capacity: number;
  maxMemorySize: number;
}

/**
 * 可插拔缓存后端接口。所有方法均为异步，以便未来接入 Redis 等
 * 本质异步的存储实现。适配层只依赖该接口，不依赖具体第三方库 API。
 */
export interface CacheBackend<V extends object> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V, sizeHint?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  entries(): Promise<Array<[string, V]>>;
  size(): Promise<number>;
  calculatedSize(): Promise<number>;
  onEvict(cb: (key: string) => void): void;
  close(): Promise<void>;
}

/**
 * 基于 `lru-cache` 的内存后端。容量与估算大小淘汰由底层库负责，
 * 因容量 / 大小压力发生的淘汰通过 dispose(reason==='evict') 上报。
 */
class MemoryCacheBackend<V extends object> implements CacheBackend<V> {
  private lru: LRUCache<string, V>;
  private maxMemorySize: number;
  private evictListeners: Array<(key: string) => void> = [];

  constructor(options: CacheBackendOptions) {
    this.maxMemorySize = options.maxMemorySize;
    this.lru = new LRUCache<string, V>({
      max: options.capacity,
      maxSize: options.maxMemorySize,
      // 每次 set 都会显式传入 size，这里仅作兜底。
      sizeCalculation: () => 1,
      dispose: (_value, key, reason) => {
        if (reason === 'evict') {
          for (const cb of this.evictListeners) cb(key);
        }
      },
    });
  }

  async get(key: string): Promise<V | undefined> {
    return this.lru.get(key);
  }

  async set(key: string, value: V, sizeHint?: number): Promise<void> {
    // lru-cache 要求 size 为不超过 maxSize 的正整数。
    const raw = Math.floor(sizeHint ?? 1);
    const size = Math.min(Math.max(1, Number.isFinite(raw) ? raw : 1), this.maxMemorySize);
    this.lru.set(key, value, { size });
  }

  async delete(key: string): Promise<boolean> {
    return this.lru.delete(key);
  }

  async clear(): Promise<void> {
    this.lru.clear();
  }

  async keys(): Promise<string[]> {
    return [...this.lru.keys()];
  }

  async entries(): Promise<Array<[string, V]>> {
    return [...this.lru.entries()];
  }

  async size(): Promise<number> {
    return this.lru.size;
  }

  async calculatedSize(): Promise<number> {
    return this.lru.calculatedSize;
  }

  onEvict(cb: (key: string) => void): void {
    this.evictListeners.push(cb);
  }

  async close(): Promise<void> {
    this.evictListeners = [];
  }
}

/**
 * 缓存后端工厂。`memory` 已实现；`redis` 作为预留 seam，
 * 选择时抛出明确错误，后续按 `CacheBackend` 接口补充实现即可。
 */
export function createCacheBackend<V extends object>(
  kind: CacheBackendKind,
  options: CacheBackendOptions,
): CacheBackend<V> {
  switch (kind) {
    case 'memory':
      return new MemoryCacheBackend<V>(options);
    case 'redis':
      throw new Error('redis cache backend not implemented yet');
    default:
      throw new Error(`unknown cache backend: ${kind as string}`);
  }
}

function resolveBackendKind(explicit?: CacheBackendKind): CacheBackendKind {
  const fromEnv = process.env.CNBS_CACHE_BACKEND as CacheBackendKind | undefined;
  return explicit ?? fromEnv ?? 'memory';
}

// ─── 缓存适配层 ──────────────────────────────────────────────────────────────

export class ManagedCache<T> {
  private backend: CacheBackend<CacheEnvelope<T>>;
  private name: string;

  private capacity: number;
  private defaultExpire: number;
  private maxMemorySize: number;

  private totalHits: number = 0;
  private totalMisses: number = 0;
  private evictionCount: number = 0;
  private expirationCount: number = 0;
  private inflightMap = new Map<string, Promise<T>>();

  constructor(name: string, options: CacheOptions = {}) {
    this.name = name;
    this.capacity = options.capacity ?? 1000;
    this.defaultExpire = options.defaultExpire ?? 24 * 60 * 60 * 1000;
    this.maxMemorySize = options.maxMemorySize ?? 100 * 1024 * 1024;

    const kind = resolveBackendKind(options.backend);
    this.backend = createCacheBackend<CacheEnvelope<T>>(kind, {
      capacity: this.capacity,
      maxMemorySize: this.maxMemorySize,
    });
    // ✅ 构造无定时器等副作用；淘汰计数由后端在容量 / 大小压力时上报
    this.backend.onEvict(() => {
      this.evictionCount++;
      cacheEvictionsTotal.inc({ cache: this.name });
    });
  }

  // ─── 工具 ────────────────────────────────────────────────────────────────────

  private calculateSize(value: T): number {
    if (typeof value === 'string') return value.length;
    try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 1; }
  }

  // ─── 公开 API ────────────────────────────────────────────────────────────────

  async fetch(key: string): Promise<T | null> {
    const entry = await this.backend.get(key);
    if (!entry) {
      this.totalMisses++;
      cacheMissesTotal.inc({ cache: this.name });
      return null;
    }

    if (Date.now() > entry.expireAt) {
      await this.backend.delete(key);
      this.expirationCount++;
      cacheExpirationsTotal.inc({ cache: this.name });
      this.totalMisses++;
      cacheMissesTotal.inc({ cache: this.name });
      return null;
    }

    entry.hitCount++;
    entry.lastHit = Date.now();
    this.totalHits++;
    cacheHitsTotal.inc({ cache: this.name });
    return entry.value;
  }

  async fetchMultiple(keys: string[]): Promise<Map<string, T>> {
    const entries = await Promise.all(
      keys.map(async (key) => [key, await this.fetch(key)] as const),
    );
    const result = new Map<string, T>();
    for (const [key, value] of entries) {
      if (value !== null) result.set(key, value);
    }
    return result;
  }

  /**
   * Fetch from cache or invoke loader — with two guarantees:
   *  1. In-flight dedup: concurrent requests for the same missing key share one Promise.
   *  2. Stale-while-revalidate: if entry expired within `staleGrace` ms, serve the
   *     stale value immediately and kick off a background refresh.
   */
  async fetchOrLoad(
    key: string,
    loader: () => Promise<T>,
    ttl?: number,
    staleGrace: number = 0,
  ): Promise<T> {
    const now = Date.now();
    const entry = await this.backend.get(key);

    if (entry) {
      if (now <= entry.expireAt) {
        log.debug({ key, source: 'l1' }, 'Cache hit');
        // Fresh hit
        entry.hitCount++;
        entry.lastHit = now;
        this.totalHits++;
        cacheHitsTotal.inc({ cache: this.name });
        return entry.value;
      }

      if (staleGrace > 0 && now <= entry.expireAt + staleGrace) {
        log.debug({ key, source: 'l1-stale' }, 'Cache hit');
        // Stale-while-revalidate: return stale value, refresh in background
        entry.hitCount++;
        entry.lastHit = now;
        this.totalHits++;
        cacheHitsTotal.inc({ cache: this.name });
        if (!this.inflightMap.has(key)) {
          const bg = loader()
            .then(v => this.store(key, v, ttl))
            .catch(err => { log.warn({ key, err }, 'Background cache refresh failed'); })
            .finally(() => { this.inflightMap.delete(key); });
          this.inflightMap.set(key, bg as unknown as Promise<T>);
        }
        return entry.value;
      }

      // Fully expired
      await this.backend.delete(key);
      this.expirationCount++;
      cacheExpirationsTotal.inc({ cache: this.name });
      this.totalMisses++;
      cacheMissesTotal.inc({ cache: this.name });
    } else {
      this.totalMisses++;
      cacheMissesTotal.inc({ cache: this.name });
    }

    // In-flight dedup: if another coroutine is already fetching this key, wait for it
    const inflight = this.inflightMap.get(key);
    if (inflight) return inflight;

    // Timeout protection: auto-remove inflight entry after 60s to prevent memory leaks
    const INFLIGHT_TIMEOUT = 60_000;
    const timer = setTimeout(() => {
      this.inflightMap.delete(key);
      log.warn({ key }, 'Inflight request timed out after 60s');
    }, INFLIGHT_TIMEOUT);

    const promise = loader()
      .then(async value => {
        await this.store(key, value, ttl);
        this.inflightMap.delete(key);
        clearTimeout(timer);
        return value;
      })
      .catch(err => {
        this.inflightMap.delete(key);
        clearTimeout(timer);
        throw err;
      });

    this.inflightMap.set(key, promise);
    log.debug({ key, source: 'miss' }, 'Cache miss');
    return promise;
  }

  async store(key: string, value: T, ttl: number = this.defaultExpire): Promise<void> {
    const size = this.calculateSize(value);
    const now = Date.now();
    const envelope: CacheEnvelope<T> = {
      value,
      expireAt: now + ttl,
      hitCount: 1,
      lastHit: now,
      storedAt: now,
      size,
    };
    // 容量与估算大小淘汰由后端负责
    await this.backend.set(key, envelope, size);
  }

  async storeMultiple(items: Array<{ key: string; value: T; ttl?: number }>): Promise<void> {
    await Promise.all(items.map(item => this.store(item.key, item.value, item.ttl)));
  }

  async remove(key: string): Promise<void> {
    await this.backend.delete(key);
  }

  async removeMultiple(keys: string[]): Promise<void> {
    await Promise.all(keys.map(key => this.remove(key)));
  }

  async flush(): Promise<void> {
    await this.backend.clear();
  }

  async count(): Promise<number> {
    return this.backend.size();
  }

  async getMemorySize(): Promise<number> {
    return this.backend.calculatedSize();
  }

  async getStats(): Promise<CacheStats> {
    let oldestEntry: { key: string; age: number } | null = null;
    let topHit: { key: string; count: number } | null = null;

    const now = Date.now();
    const entries = await this.backend.entries();
    for (const [key, item] of entries) {
      const age = now - item.lastHit;
      if (!oldestEntry || age > oldestEntry.age) oldestEntry = { key, age };
      if (!topHit || item.hitCount > topHit.count) topHit = { key, count: item.hitCount };
    }

    const total = this.totalHits + this.totalMisses;
    return {
      size: await this.backend.size(),
      capacity: this.capacity,
      memorySize: await this.backend.calculatedSize(),
      maxMemorySize: this.maxMemorySize,
      oldestEntry,
      topHit,
      hitRate: total > 0 ? parseFloat(((this.totalHits / total) * 100).toFixed(2)) : 0,
      missRate: total > 0 ? parseFloat(((this.totalMisses / total) * 100).toFixed(2)) : 0,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      evictionCount: this.evictionCount,
      expirationCount: this.expirationCount,
      persistenceCount: 0, // 无持久化
    };
  }

  async getCacheInfo(key: string): Promise<{ timestamp: number; size: number; ttl: number; hits: number } | null> {
    const entry = await this.backend.get(key);
    if (!entry) return null;
    return {
      timestamp: entry.lastHit,
      size: entry.size,
      ttl: entry.expireAt - Date.now(),
      hits: entry.hitCount,
    };
  }

  // close() 关闭后端资源
  async close(): Promise<void> {
    await this.backend.close();
  }
}

// ─── 缓存中心 ────────────────────────────────────────────────────────────────

export class CacheHub {
  private caches: Map<string, ManagedCache<unknown>> = new Map();
  private defaultOptions: CacheOptions = {
    capacity: 1000,
    defaultExpire: 24 * 60 * 60 * 1000,
    maxMemorySize: 100 * 1024 * 1024,
    cleanupInterval: 60 * 1000,
  };

  getCache<T>(name: string, options: CacheOptions = {}): ManagedCache<T> {
    if (!this.caches.has(name)) {
      this.caches.set(name, new ManagedCache<unknown>(name, { ...this.defaultOptions, ...options }));
    }
    return this.caches.get(name) as unknown as ManagedCache<T>;
  }

  async removeCache(name: string): Promise<void> {
    const cache = this.caches.get(name);
    if (cache) {
      await cache.close();
      this.caches.delete(name);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.caches.values()].map(cache => cache.flush()));
  }

  async getAllStats(): Promise<Record<string, CacheStats>> {
    const stats: Record<string, CacheStats> = {};
    for (const [name, cache] of this.caches) {
      stats[name] = await cache.getStats();
    }
    return stats;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.caches.values()].map(cache => cache.close()));
    this.caches.clear();
  }
}

// ─── 懒加载单例（✅ 模块加载时零副作用）────────────────────────────────────

let _hub: CacheHub | null = null;

export function getCacheHub(): CacheHub {
  if (!_hub) _hub = new CacheHub();
  return _hub;
}

/**
 * 懒加载单例的代理导出。真正的 CacheHub 在首次访问时才创建，
 * 以保持模块加载阶段零副作用。
 * ⚠️  只能在 handler / 函数体内使用，不能在模块顶层赋值后立即调用方法。
 *
 * 用法：import { cacheHub } from './services/cache.js'
 *       cacheHub.getCache('xxx')
 */
export const cacheHub: CacheHub = new Proxy({} as CacheHub, {
  get(_target, prop) {
    return Reflect.get(getCacheHub(), prop);
  },
});

// ─── 缓存键工具 ──────────────────────────────────────────────────────────────

export class CacheKeyGenerator {
  static generateSearchKey(keyword: string, pageNum: number = 1, pageSize: number = 10): string {
    return `search_${keyword.toLowerCase()}_${pageNum}_${pageSize}`;
  }

  static generateNodeKey(category: string, parentId?: string): string {
    return `node_${category}_${parentId ?? 'root'}`;
  }

  static generateMetricKey(setId: string, name?: string): string {
    return `metric_${setId}_${name ?? 'all'}`;
  }

  static generateSeriesKey(
      setId: string,
      metricIds: string[],
      periods: string[],
      areas?: Array<{ text: string; code: string }>,
  ): string {
    const enc = encodeURIComponent;
    const metricKey = [...metricIds].sort().map(enc).join(',');
    const periodKey = [...periods].sort().map(enc).join(',');
    const areaKey = areas ? areas.map(a => a.code).sort().map(enc).join(',') : '000000000000';
    return `series|${enc(setId)}|${metricKey}|${periodKey}|${areaKey}`;
  }

  static generateDataSourceKey(source: string, params: Record<string, unknown>): string {
    const sortedParams = Object.keys(params)
        .sort()
        .map(key => `${key}=${params[key]}`)
        .join('&');
    return `datasource_${source}_${sortedParams}`;
  }
}
