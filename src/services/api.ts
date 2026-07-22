import { cacheHub, CacheKeyGenerator, ManagedCache } from './cache.js';
import { CnbsErrorHandler, CnbsErrorType } from './error.js';
import { cnbsRequestThrottler } from './throttler.js';
import { safePropertyAccess } from './boundary.js';
import { createLogger } from '../logger.js';
import { sharedAxiosConfig, loggedGet, loggedPost } from './http-client.js';
import { upstreamAccessBlockedTotal } from './metrics.js';
import {
  CNBS_API_BASE,
  CNBS_NODE_CACHE_TTL,
  CNBS_METRIC_CACHE_TTL,
  CNBS_DATA_CACHE_TTL,
  CNBS_DEFAULT_ROOT
} from '../constants/index.js';
import {
  CnbsSeriesQuery,
  CnbsNodeQuery,
  CnbsMetricQuery,
  CnbsSearchQuery,
  CnbsCategory,
  CnbsClientConfig,
  CnbsSearchResponse,
  CnbsNodeResponse,
  CnbsMetricResponse,
  CnbsSeriesResponse,
  CnbsRawNodeItem,
  CnbsRawMetricItem,
  CnbsRawSearchItem,
  CategoryItem,
  SearchResult,
} from '../types/index.js';

const log = createLogger('api');

function truncateSnippet(value: unknown, maxLength: number = 240): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function looksLikeHtmlPayload(data: unknown): boolean {
  if (typeof data !== 'string') {
    return false;
  }

  const sample = data.trim().slice(0, 256).toLowerCase();
  return sample.startsWith('<!doctype html') || sample.startsWith('<html') || sample.includes('<script');
}

function looksLikeWafChallenge(data: unknown, headers: Record<string, unknown>): boolean {
  const snippet = typeof data === 'string' ? data.toLowerCase() : '';
  return Boolean(
    headers['wzws-ray'] ||
    snippet.includes('please enable javascript and refresh the page') ||
    snippet.includes('waf') ||
    snippet.includes('challenge')
  );
}

function validateCnbsApiResponse(
  endpoint: string,
  response: { status: number; headers: Record<string, unknown>; data: unknown }
): void {
  const headers = response.headers || {};
  const contentType = String(headers['content-type'] || '');
  const rawSnippet = truncateSnippet(response.data);

  if (contentType.includes('text/html') || looksLikeHtmlPayload(response.data)) {
    const blockedByWaf = looksLikeWafChallenge(response.data, headers);
    if (blockedByWaf) {
      upstreamAccessBlockedTotal.inc({ endpoint });
    }
    throw CnbsErrorHandler.createServiceError({
      type: blockedByWaf ? CnbsErrorType.ACCESS_BLOCKED : CnbsErrorType.API_FAILURE,
      message: blockedByWaf
        ? 'CNBS upstream returned an anti-bot or browser challenge page instead of JSON data.'
        : 'CNBS upstream returned HTML instead of the expected JSON payload.',
      // WAF challenges are intermittent and often self-heal on retry with a
      // longer backoff; non-WAF HTML (format change / redirect) is not retried.
      canRetry: blockedByWaf,
      endpoint,
      status: response.status,
      contentType,
      rawSnippet,
      hints: blockedByWaf
        ? [
            'This endpoint appears to be protected by WAF or anti-bot logic.',
            'Calls that depend on CNBS search may fail until the upstream service allows server-side access.'
          ]
        : ['The upstream response format changed or the request was redirected to a non-API page.'],
    });
  }
}

type ParsedPeriod =
  | { kind: 'annual'; year: number }
  | { kind: 'quarter'; year: number; startMonth: number }
  | { kind: 'month'; year: number; month: number };

const PERIOD_ANNUAL_RE = /^(\d{4})YY$/;
const PERIOD_QUARTER_RE = /^(\d{4})([A-D])$/;
const PERIOD_MONTH_RE = /^(\d{4})(\d{2})MM$/;
const QUARTER_START_MONTH: Record<string, number> = { A: 1, B: 4, C: 7, D: 10 };
const PERIOD_FORMAT_HINT =
  '支持年度 2024YY、季度 2024A/B/C/D、月度 202401MM，或区间 起-止（如 202001MM-202412MM）。';

/** Parse a single (non-range) period token, or null when the format is illegal. */
function parseSinglePeriod(token: string): ParsedPeriod | null {
  let m = PERIOD_ANNUAL_RE.exec(token);
  if (m) return { kind: 'annual', year: Number(m[1]) };

  m = PERIOD_QUARTER_RE.exec(token);
  if (m) return { kind: 'quarter', year: Number(m[1]), startMonth: QUARTER_START_MONTH[m[2]] };

  m = PERIOD_MONTH_RE.exec(token);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return { kind: 'month', year: Number(m[1]), month };
  }

  return null;
}

/**
 * Decide whether a parsed period lies in the future relative to `now`.
 * Annual: filtered only when the year is beyond the current year.
 * Quarter: judged by the quarter's starting month; the just-started quarter is
 *   treated as future (2026-07 → 2026A/2026B valid, 2026C/2026D filtered).
 * Month: filtered only when strictly later than the current year-month.
 */
function isFuturePeriod(period: ParsedPeriod, now: Date): boolean {
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  if (period.kind === 'annual') {
    return period.year > curYear;
  }
  if (period.year !== curYear) {
    return period.year > curYear;
  }
  if (period.kind === 'quarter') {
    return period.startMonth >= curMonth;
  }
  return period.month > curMonth;
}

function throwPeriodValidationError(message: string): never {
  throw CnbsErrorHandler.createServiceError({
    type: CnbsErrorType.VALIDATION_ERROR,
    message,
    canRetry: false,
  });
}

/**
 * Validate and normalize `dts` before hitting the upstream esData endpoint.
 * Rejects illegal formats up front (no upstream request), passes range tokens
 * through untouched, and drops future periods so invalid metric+period combos
 * do not trigger opaque upstream 500s. Throws VALIDATION_ERROR when the input
 * is empty or every entry is filtered as future.
 */
export function normalizePeriods(periods: string[], now: Date = new Date()): string[] {
  if (!Array.isArray(periods) || periods.length === 0) {
    throwPeriodValidationError(`periods 不能为空，请提供至少一个时间段。${PERIOD_FORMAT_HINT}`);
  }

  const kept: string[] = [];
  const filteredFuture: string[] = [];

  for (const raw of periods) {
    const token = typeof raw === 'string' ? raw.trim() : '';
    if (!token) {
      throwPeriodValidationError(`非法的时间段格式：「${String(raw)}」。${PERIOD_FORMAT_HINT}`);
    }

    // Range form X-Y (e.g. findAndFetch's 202001MM-202607MM): validate both
    // endpoints then pass the original token through without future filtering.
    if (token.includes('-')) {
      const parts = token.split('-');
      const valid = parts.length === 2 && parts.every((part) => parseSinglePeriod(part) !== null);
      if (!valid) {
        throwPeriodValidationError(`非法的时间段区间：「${token}」。${PERIOD_FORMAT_HINT}`);
      }
      kept.push(token);
      continue;
    }

    const parsed = parseSinglePeriod(token);
    if (!parsed) {
      throwPeriodValidationError(`非法的时间段格式：「${token}」。${PERIOD_FORMAT_HINT}`);
    }
    if (isFuturePeriod(parsed, now)) {
      filteredFuture.push(token);
      continue;
    }
    kept.push(token);
  }

  if (kept.length === 0) {
    throwPeriodValidationError(
      `所有时间段都晚于当前日期（${filteredFuture.join(', ')}），已被过滤；请改用不晚于当前时间的时段。`,
    );
  }

  return kept;
}

/**
 * Normalize the CNBS `/query` response into a consistent shape.
 * The live NBS API wraps results as `{ data: { types, data: [...], count } }`,
 * while older/mocked payloads expose the item array directly at `data`.
 * Downstream consumers (findAndFetch, tools) rely on `CnbsSearchResponse.data`
 * being the item array, so we flatten both shapes here.
 */
function normalizeSearchResponse(raw: unknown): CnbsSearchResponse {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const dataField = body.data;

  // Legacy/mocked shape: results already at `data`.
  if (Array.isArray(dataField)) {
    return {
      code: body.code as number | undefined,
      msg: (body.msg ?? body.message) as string | undefined,
      data: dataField as CnbsRawSearchItem[],
      total: body.total as number | undefined,
    };
  }

  // Live NBS shape: results nested at `data.data`.
  if (dataField && typeof dataField === 'object') {
    const inner = dataField as Record<string, unknown>;
    const items = Array.isArray(inner.data) ? (inner.data as CnbsRawSearchItem[]) : [];
    return {
      code: body.code as number | undefined,
      msg: (body.msg ?? body.message) as string | undefined,
      data: items,
      total: (inner.count ?? body.total) as number | undefined,
    };
  }

  return { data: [] };
}

/**
 * Normalize a metric name for tolerant matching.
 * NBS indicator names frequently differ from user input by connective
 * characters (的/之), full-width vs half-width punctuation, brackets and
 * whitespace, e.g. user "卫生总费用占GDP比重" vs NBS "卫生总费用占GDP的比重".
 * We strip that noise and lowercase so equivalent names compare equal.
 */
function normalizeMetricName(name: string): string {
  return name
    // full-width ASCII → half-width
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    // drop connective / structural characters that carry no matching signal
    .replace(/[的之\s()（）[\]【】、,，.。:：;；/\\-]/g, '')
    .toLowerCase();
}

/**
 * Find the metric whose show name best matches the requested name.
 * Tries, in order: exact substring, normalized bidirectional containment,
 * then character-overlap ranking. Returns undefined when nothing is close.
 */
function matchMetricByName(
  metrics: CnbsRawMetricItem[],
  metricName: string,
): CnbsRawMetricItem | undefined {
  // 1) Exact substring match (original behaviour, cheapest).
  const exact = metrics.find((m) => m.i_showname?.includes(metricName));
  if (exact) return exact;

  const target = normalizeMetricName(metricName);
  if (!target) return undefined;

  // 2) Normalized bidirectional containment.
  const normalized = metrics.find((m) => {
    const name = normalizeMetricName(m.i_showname || '');
    return name.includes(target) || target.includes(name);
  });
  if (normalized) return normalized;

  // 3) Character-overlap ranking; require a meaningful overlap ratio.
  const targetChars = new Set(target);
  let best: { metric: CnbsRawMetricItem; score: number } | undefined;
  for (const m of metrics) {
    const name = normalizeMetricName(m.i_showname || '');
    if (!name) continue;
    let hits = 0;
    for (const ch of new Set(name)) {
      if (targetChars.has(ch)) hits += 1;
    }
    const score = hits / targetChars.size;
    if (score > (best?.score ?? 0)) {
      best = { metric: m, score };
    }
  }
  return best && best.score >= 0.6 ? best.metric : undefined;
}

/**
 * Score how well a keyword matches a candidate name via normalized character
 * overlap (reusing normalizeMetricName). Returns the ratio of keyword chars
 * covered by the name, 0 when either side normalizes to empty.
 */
function relevanceScore(keyword: string, name: string): number {
  const target = normalizeMetricName(keyword);
  const candidate = normalizeMetricName(name || '');
  if (!target || !candidate) return 0;
  const candidateChars = new Set(candidate);
  let hits = 0;
  for (const ch of new Set(target)) {
    if (candidateChars.has(ch)) hits += 1;
  }
  return hits / new Set(target).size;
}

/**
 * Pick the search result most relevant to the keyword. Falls back to the
 * latest `dt` when relevance scores tie, preserving previous behaviour for
 * ambiguous inputs.
 */
function pickBestSearchResult(
  results: CnbsRawSearchItem[],
  keyword: string,
): CnbsRawSearchItem {
  return results.reduce((best, current) => {
    const bestScore = relevanceScore(keyword, best.show_name || '');
    const currentScore = relevanceScore(keyword, current.show_name || '');
    if (currentScore !== bestScore) {
      return currentScore > bestScore ? current : best;
    }
    // tie-break: latest dt
    if (!best.dt) return current;
    if (!current.dt) return best;
    return current.dt > best.dt ? current : best;
  });
}

/**
 * Derive a human-readable data granularity hint from a search item. NBS marks
 * period type via `dt_type`/`dt_name`; we surface 月度/季度/年度 when detectable
 * and 未知 otherwise, without inventing information.
 */
function deriveGranularity(item: CnbsRawSearchItem): string {
  const hint = `${item.dt_type ?? ''}${item.dt_name ?? ''}${item.dt ?? ''}`;
  if (/月|MM/i.test(hint)) return '月度';
  if (/季|QQ/i.test(hint)) return '季度';
  if (/年|YY/i.test(hint)) return '年度';
  return '未知';
}

/**
 * Build a de-duplicated candidate list (by cid) from search results, so the
 * caller can see cross-board alternatives for a broad keyword.
 */
function buildCandidates(
  results: CnbsRawSearchItem[],
  limit: number = 8,
): Array<{ name: string; setId: string; granularity: string; dt?: string }> {
  const seen = new Set<string>();
  const candidates: Array<{ name: string; setId: string; granularity: string; dt?: string }> = [];
  for (const item of results) {
    const setId = item.cid;
    if (!setId || seen.has(setId)) continue;
    seen.add(setId);
    candidates.push({
      name: item.show_name || '',
      setId,
      granularity: deriveGranularity(item),
      dt: item.dt,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/**
 * Detect whether a series response carries no usable data: either no data
 * items, or every value across all items is empty/null after trimming.
 */
function isSeriesAllEmpty(series: CnbsSeriesResponse): boolean {
  const items = Array.isArray(series?.data) ? series.data : [];
  if (items.length === 0) return true;
  return items.every((item) => {
    const values = Array.isArray(item?.values) ? item.values : [];
    if (values.length === 0) return true;
    return values.every((v) => {
      const raw = v?.value;
      if (raw === null || raw === undefined) return true;
      return String(raw).trim() === '';
    });
  });
}

export interface FindAndFetchResult {
  setId: string;
  metric: CnbsRawMetricItem;
  series: CnbsSeriesResponse;
  warning?: string;
  candidates?: Array<{ name: string; setId: string; granularity: string; dt?: string }>;
}

// 数据同步状态管理
export class CnbsModernClient {
  private baseUrl: string;
  private timeout: number;
  private rootId: string;

  private nodeCache: ManagedCache<CnbsSearchResponse | CnbsNodeResponse>;
  private metricCache: ManagedCache<CnbsMetricResponse>;
  private seriesCache: ManagedCache<CnbsSeriesResponse>;

  constructor(config?: CnbsClientConfig) {
    this.baseUrl = config?.baseUrl || CNBS_API_BASE;
    this.timeout = config?.timeout || 30000;
    this.rootId = config?.rootId || CNBS_DEFAULT_ROOT;

    this.nodeCache = cacheHub.getCache('node', {
      capacity: 500,
      defaultExpire: CNBS_NODE_CACHE_TTL
    });

    this.metricCache = cacheHub.getCache('metric', {
      capacity: 1000,
      defaultExpire: CNBS_METRIC_CACHE_TTL
    });

    this.seriesCache = cacheHub.getCache('series', {
      capacity: 2000,
      defaultExpire: CNBS_DATA_CACHE_TTL
    });
  }

  async findItems(params: CnbsSearchQuery): Promise<CnbsSearchResponse> {
    const cacheKey = CacheKeyGenerator.generateSearchKey(
      params.keyword,
      params.pageNum || 1,
      params.pageSize || 10,
    );
    return this.nodeCache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(() =>
        CnbsErrorHandler.retryWithBackoff(async () => {
          const url = new URL(`${this.baseUrl}/query`);
          url.searchParams.set('search', params.keyword);
          url.searchParams.set('pagenum', (params.pageNum || 1).toString());
          url.searchParams.set('pageSize', (params.pageSize || 10).toString());
          log.debug({ url: url.toString() }, 'Search Request');
          const response = await loggedGet('search', url.toString(), { ...sharedAxiosConfig, timeout: this.timeout });
          validateCnbsApiResponse(url.toString(), response);
          log.debug({ url: url.toString(), status: response.status }, 'Search Response');
          return normalizeSearchResponse(response.data);
        }),
      ),
      CNBS_NODE_CACHE_TTL,
      5 * 60 * 1000, // 5 min stale grace
    ) as Promise<CnbsSearchResponse>;
  }

  async batchFindItems(keywords: string[], pageSize: number = 5): Promise<Record<string, CnbsSearchResponse | { error: string }>> {
    const entries = await Promise.all(
      keywords.map(async (keyword) => {
        try {
          const result = await this.findItems({ keyword, pageSize });
          return [keyword, result] as const;
        } catch (error) {
          return [keyword, { error: (error as Error).message }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  async fetchNodes(params: CnbsNodeQuery): Promise<CnbsNodeResponse> {
    const cacheKey = CacheKeyGenerator.generateNodeKey(params.category, params.parentId);
    return this.nodeCache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(() =>
        CnbsErrorHandler.retryWithBackoff(async () => {
          const url = new URL(`${this.baseUrl}/new/queryIndexTreeAsync`);
          if (params.parentId) url.searchParams.set('pid', params.parentId);
          url.searchParams.set('code', params.category);
          log.debug({ url: url.toString() }, 'Node Request');
          const response = await loggedGet('node', url.toString(), { ...sharedAxiosConfig, timeout: this.timeout });
          validateCnbsApiResponse(url.toString(), response);
          return response.data as CnbsNodeResponse;
        }),
      ),
      CNBS_NODE_CACHE_TTL,
      30 * 60 * 1000, // 30 min stale grace for structural data
    ) as Promise<CnbsNodeResponse>;
  }

  async fetchAllEndNodes(category: CnbsCategory): Promise<CnbsRawNodeItem[]> {
    const allEnds: CnbsRawNodeItem[] = [];
    const CONCURRENCY_LIMIT = 5;

    // BFS with bounded concurrency
    const queue: Array<string | undefined> = [undefined];

    while (queue.length > 0) {
      const batch = queue.splice(0, CONCURRENCY_LIMIT);
      const results = await Promise.all(
        batch.map(async (parentId) => {
          try {
            const response = await this.fetchNodes({ parentId, category });
            return safePropertyAccess(response, 'data', []) as CnbsRawNodeItem[];
          } catch (error) {
            log.error({ err: error, parentId }, 'Node traversal failed');
            return [];
          }
        }),
      );

      for (const nodes of results) {
        for (const node of nodes) {
          if (node.isLeaf) {
            allEnds.push(node);
          } else {
            queue.push(node._id);
          }
        }
      }
    }

    return allEnds;
  }

  async fetchMetrics(params: CnbsMetricQuery): Promise<CnbsMetricResponse> {
    const cacheKey = CacheKeyGenerator.generateMetricKey(params.setId, params.name);
    return this.metricCache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(() =>
        CnbsErrorHandler.retryWithBackoff(async () => {
          const url = new URL(`${this.baseUrl}/new/queryIndicatorsByCid`);
          url.searchParams.set('cid', params.setId);
          if (params.dataType) url.searchParams.set('dt', params.dataType);
          if (params.name) url.searchParams.set('name', params.name);
          log.debug({ url: url.toString() }, 'Metric Request');
          const response = await loggedGet('metric', url.toString(), { ...sharedAxiosConfig, timeout: this.timeout });
          validateCnbsApiResponse(url.toString(), response);
          return response.data as CnbsMetricResponse;
        }),
      ),
      CNBS_METRIC_CACHE_TTL,
      15 * 60 * 1000, // 15 min stale grace
    );
  }

  async fetchSeries(params: CnbsSeriesQuery): Promise<CnbsSeriesResponse> {
    // Validate + drop future periods before touching cache or upstream.
    const periods = normalizePeriods(params.periods);
    const cacheKey = CacheKeyGenerator.generateSeriesKey(
      params.setId, params.metricIds, periods, params.areas,
    );
    return this.seriesCache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(() =>
        CnbsErrorHandler.retryWithBackoff(async () => {
          const payload = {
            cid: params.setId,
            indicatorIds: params.metricIds,
            das: (params.areas || [{ text: '全国', code: '000000000000' }])
              .map(area => ({ text: area.text, value: area.code })),
            daCatalogId: '',
            dts: periods,
            showType: params.displayMode || '1',
            rootId: params.rootId || this.rootId,
          };
          log.debug({ url: `${this.baseUrl}/stream/esData`, payload }, 'Series Request');
          const response = await loggedPost(
            'series',
            `${this.baseUrl}/stream/esData`, payload,
            { ...sharedAxiosConfig, timeout: this.timeout, headers: { ...sharedAxiosConfig.headers, 'Content-Type': 'application/json' } },
          );
          validateCnbsApiResponse(`${this.baseUrl}/stream/esData`, response);
          return response.data as CnbsSeriesResponse;
        }),
      ),
      CNBS_DATA_CACHE_TTL,
      10 * 60 * 1000, // 10 min stale grace
    );
  }

  // 批量获取数据系列
  async batchFetchSeries(queries: CnbsSeriesQuery[]): Promise<Array<{
    query: CnbsSeriesQuery;
    result: CnbsSeriesResponse | null;
    error?: string;
  }>> {
    return Promise.all(queries.map(async (query) => {
      try {
        const result = await this.fetchSeries(query);
        return { query, result };
      } catch (error) {
        return {
          query, 
          result: null, 
          error: (error as Error).message 
        };
      }
    }));
  }

  async findAndFetch(
    keyword: string,
    metricName?: string,
    startPeriod?: string,
    endPeriod?: string
  ): Promise<FindAndFetchResult> {
    const searchResponse = await this.findItems({ keyword, pageSize: 10 });

    const searchResults = Array.isArray(searchResponse?.data) ? searchResponse.data : [];
    if (searchResults.length === 0) {
      throw new Error(`No results found for keyword: ${keyword}`);
    }

    // Relevance-first selection; ties fall back to the latest dt.
    const target = pickBestSearchResult(searchResults, keyword);

    const setId = target.cid || this.extractSetIdFromGlobalRef(target.treeinfo_globalid);

    if (!setId) {
      throw new Error('Failed to extract setId from search result');
    }

    // Cross-board ambiguity: distinct datasets matched the same keyword.
    const candidates = buildCandidates(searchResults);
    const isAmbiguous = candidates.length > 1;

    const metricsResponse = await this.fetchMetrics({ setId });
    const metrics = metricsResponse?.data?.list || [];

    if (!metrics || metrics.length === 0) {
      throw new Error(`No metrics found for setId: ${setId}`);
    }

    let targetMetric: CnbsRawMetricItem | undefined;
    if (metricName) {
      targetMetric = matchMetricByName(metrics, metricName);
    } else {
      targetMetric = metrics[0];
    }

    if (!targetMetric) {
      const available = metrics
        .map((m) => m.i_showname)
        .filter(Boolean)
        .slice(0, 20);
      throw new Error(
        `Metric not found: ${metricName}. Available metrics in this dataset` +
        `${available.length ? `: ${available.join(' | ')}` : ' are empty'}.`,
      );
    }

    const now = new Date();
    const currentPeriod = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const periodRange = startPeriod && endPeriod
      ? `${startPeriod}-${endPeriod}`
      : `${target.dt || '202001'}MM-${currentPeriod}MM`;

    const fetchSeriesFor = (metricId: string) => this.fetchSeries({
      setId,
      metricIds: [metricId],
      areas: [{ text: '全国', code: '000000000000' }],
      periods: [periodRange],
    });

    let series = await fetchSeriesFor(targetMetric._id);

    // Empty-value fallback: when the auto-picked metric yields no data, try the
    // next sibling metric once (only when the caller did not pin a metricName).
    if (!metricName && isSeriesAllEmpty(series) && metrics.length > 1) {
      const fallback = metrics.find((m) => m._id !== targetMetric!._id);
      if (fallback) {
        const fallbackSeries = await fetchSeriesFor(fallback._id);
        if (!isSeriesAllEmpty(fallbackSeries)) {
          targetMetric = fallback;
          series = fallbackSeries;
        }
      }
    }

    const warnings: string[] = [];
    if (isSeriesAllEmpty(series)) {
      warnings.push(
        `命中指标「${targetMetric.i_showname}」无数据(全空值),可能为存量/年度类指标而非月度发布。` +
        `建议改用更具体的关键词(如「医药制造业增加值」)、传入 metricName 过滤,或先调用 cnbs_search 确认指标结构。`,
      );
    }
    if (isAmbiguous) {
      warnings.push(
        `关键词「${keyword}」较宽泛,命中多个数据集,已自动选取相关性最高的一个;如需其它板块请查看 candidates 或先调用 cnbs_search。`,
      );
    }

    const result: FindAndFetchResult = {
      setId,
      metric: targetMetric,
      series,
    };
    if (warnings.length > 0) result.warning = warnings.join(' ');
    if (isAmbiguous) result.candidates = candidates;
    return result;
  }

  private extractSetIdFromGlobalRef(globalRef?: string): string | null {
    if (!globalRef) return null;
    const parts = globalRef.split('.');
    return parts[parts.length - 1] || null;
  }

  async flushAllCaches(): Promise<void> {
    await this.nodeCache.flush();
    await this.metricCache.flush();
    await this.seriesCache.flush();
  }

  async getCacheStats(): Promise<Record<string, unknown>> {
    return cacheHub.getAllStats();
  }
}

// 扩展数据源接口
export interface DataSource<P = Record<string, unknown>, R = unknown> {
  name: string;
  description: string;
  fetchData(params: P): Promise<R>;
  getCategories(): Promise<CategoryItem[]>;
  search(keyword: string): Promise<SearchResult>;
}
