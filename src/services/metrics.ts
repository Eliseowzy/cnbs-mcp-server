// src/services/metrics.ts
// Centralized Prometheus metrics module. All metrics are module-level singletons
// that persist across requests (the MCP server is created per-request, but these are not).
import { Registry, Counter, Gauge, Histogram, collectDefaultMetrics } from 'prom-client';
import { createLogger } from '../logger.js';

const log = createLogger('metrics');

// ─── Registry ────────────────────────────────────────────────────────────────

export const metricsRegistry = new Registry();

// Collect default Node.js process metrics (event loop lag, heap, GC, fds)
collectDefaultMetrics({ register: metricsRegistry });

// ─── HTTP Layer ──────────────────────────────────────────────────────────────

export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['path', 'method', 'status'],
  registers: [metricsRegistry],
});

export const httpRequestDurationMs = new Histogram({
  name: 'http_request_duration_ms',
  help: 'HTTP request duration in milliseconds',
  labelNames: ['path', 'method'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

// ─── MCP Tool Layer ──────────────────────────────────────────────────────────

export const mcpToolCallsTotal = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool calls',
  labelNames: ['tool', 'ok'],
  registers: [metricsRegistry],
});

export const mcpToolDurationMs = new Histogram({
  name: 'mcp_tool_duration_ms',
  help: 'MCP tool call duration in milliseconds',
  labelNames: ['tool'],
  buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [metricsRegistry],
});

// ─── Upstream API Layer ──────────────────────────────────────────────────────

export const upstreamRequestsTotal = new Counter({
  name: 'upstream_requests_total',
  help: 'Total upstream API requests',
  labelNames: ['endpoint'],
  registers: [metricsRegistry],
});

export const upstreamRequestDurationMs = new Histogram({
  name: 'upstream_request_duration_ms',
  help: 'Upstream API request duration in milliseconds',
  labelNames: ['endpoint'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [metricsRegistry],
});

export const upstreamErrorsTotal = new Counter({
  name: 'upstream_errors_total',
  help: 'Total upstream errors by type',
  labelNames: ['type'],
  registers: [metricsRegistry],
});

export const upstreamRetriesTotal = new Counter({
  name: 'upstream_retries_total',
  help: 'Total upstream request retries',
  labelNames: ['endpoint'],
  registers: [metricsRegistry],
});

export const upstreamAccessBlockedTotal = new Counter({
  name: 'upstream_access_blocked_total',
  help: 'Total upstream requests blocked by WAF/anti-bot',
  labelNames: ['endpoint'],
  registers: [metricsRegistry],
});

// ─── Cache Layer ─────────────────────────────────────────────────────────────

export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total cache misses',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const cacheEvictionsTotal = new Counter({
  name: 'cache_evictions_total',
  help: 'Total cache evictions',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const cacheExpirationsTotal = new Counter({
  name: 'cache_expirations_total',
  help: 'Total cache expirations',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const cacheEntries = new Gauge({
  name: 'cache_entries',
  help: 'Current number of cache entries',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

export const cacheMemoryBytes = new Gauge({
  name: 'cache_memory_bytes',
  help: 'Current cache memory usage in bytes',
  labelNames: ['cache'],
  registers: [metricsRegistry],
});

// ─── Throttler Layer ─────────────────────────────────────────────────────────

export const throttlerQueueSize = new Gauge({
  name: 'throttler_queue_size',
  help: 'Current throttler queue size',
  registers: [metricsRegistry],
});

export const throttlerActive = new Gauge({
  name: 'throttler_active',
  help: 'Current active throttler tasks',
  registers: [metricsRegistry],
});

export const throttlerPaused = new Gauge({
  name: 'throttler_paused',
  help: 'Whether the throttler is paused (1=paused, 0=active)',
  registers: [metricsRegistry],
});

// ─── Periodic Gauge Snapshot ─────────────────────────────────────────────────

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic collection of gauge values from cache hub and throttler.
 * Default interval: 15s, configurable via CNBS_METRICS_INTERVAL_MS env var.
 */
export function startMetricsCollection(intervalMs?: number): void {
  const interval = intervalMs
    ?? (Number(process.env.CNBS_METRICS_INTERVAL_MS) || 15000);

  if (snapshotTimer) return; // already running

  // Lazy imports to avoid circular dependency at module load time
  const collect = async () => {
    try {
      const { getCacheHub } = await import('./cache.js');
      const { cnbsRequestThrottler } = await import('./error.js');

      // Cache gauges
      const allStats = await getCacheHub().getAllStats();
      for (const [name, stats] of Object.entries(allStats)) {
        cacheEntries.set({ cache: name }, stats.size);
        cacheMemoryBytes.set({ cache: name }, stats.memorySize);
      }

      // Throttler gauges
      const status = cnbsRequestThrottler.getStatus();
      throttlerQueueSize.set(status.queueSize);
      throttlerActive.set(status.active);
      throttlerPaused.set(status.isPaused ? 1 : 0);
    } catch (err) {
      log.warn({ err }, 'Metrics snapshot collection failed');
    }
  };

  // Run once immediately, then on interval
  void collect();
  snapshotTimer = setInterval(() => void collect(), interval);
  snapshotTimer.unref(); // don't keep process alive

  log.info({ intervalMs: interval }, 'Metrics collection started');
}

export function stopMetricsCollection(): void {
  if (snapshotTimer) {
    clearInterval(snapshotTimer);
    snapshotTimer = null;
  }
}
