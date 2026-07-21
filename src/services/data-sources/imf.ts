// src/services/data-sources/imf.ts
import { DataSource } from '../api.js';
import { cacheHub, CacheKeyGenerator } from '../cache.js';
import { CnbsErrorHandler } from '../error.js';
import { cnbsRequestThrottler } from '../throttler.js';
import { sharedAxiosConfig, loggedGet } from '../http-client.js';
import type { IMFFetchResult, IMFDataPoint, CategoryItem, SearchResult } from '../../types/index.js';
import { filterIndicators } from './helpers.js';

export interface IMFFetchParams {
  indicator: string;
  countries?: string[];
  periods?: string[];
}

export class IMFDataSource implements DataSource<IMFFetchParams, IMFFetchResult> {
  name = 'imf';
  description = '国际货币基金组织 (IMF DataMapper)';

  static readonly INDICATORS: Record<string, { id: string; name: string; unit: string }> = {
    GDP_GROWTH:        { id: 'NGDP_RPCH',     name: 'GDP实际增速（%）',           unit: '%' },
    GDP_USD:           { id: 'NGDPD',         name: 'GDP（十亿美元）',            unit: '十亿美元' },
    GDP_PER_CAPITA:    { id: 'NGDPDPC',       name: '人均GDP（美元）',            unit: '美元' },
    CPI_INFLATION:     { id: 'PCPIPCH',       name: 'CPI通胀率（%）',            unit: '%' },
    UNEMPLOYMENT:      { id: 'LUR',           name: '失业率（%）',               unit: '%' },
    CURRENT_ACCOUNT:   { id: 'BCA_NGDPD',     name: '经常账户余额占GDP（%）',    unit: '%' },
    GOVT_DEBT:         { id: 'GGXWDG_NGDP',   name: '政府总债务占GDP（%）',      unit: '%' },
    GOVT_BALANCE:      { id: 'GGXONLB_NGDP',  name: '政府净贷款占GDP（%）',      unit: '%' },
    GROSS_SAVINGS:     { id: 'NGSD_NGDP',     name: '总储蓄率占GDP（%）',        unit: '%' },
    INVESTMENT:        { id: 'NID_NGDP',      name: '固定资本形成占GDP（%）',    unit: '%' },
    TRADE_BALANCE:     { id: 'BCA',           name: '经常账户余额（十亿美元）',   unit: '十亿美元' },
    POPULATION:        { id: 'LP',            name: '总人口（百万）',             unit: '百万' },
    OUTPUT_GAP:        { id: 'NGAP_NPGDP',    name: '产出缺口占潜在GDP（%）',    unit: '%' },
    COMMODITY_PRICE:   { id: 'PALLFNFW',      name: '大宗商品价格指数',          unit: '' },
  };

  private cache = cacheHub.getCache<IMFFetchResult>('imf', {
    capacity: 1000,
    defaultExpire: 12 * 60 * 60 * 1000,
  });

  async fetchData(params: IMFFetchParams): Promise<IMFFetchResult> {
    const resolved = IMFDataSource.INDICATORS[params.indicator?.toUpperCase()]
      || { id: params.indicator, name: params.indicator, unit: '' };
    const indicatorId = resolved.id;
    const countries = params.countries || ['CHN'];

    const cacheKey = CacheKeyGenerator.generateDataSourceKey('imf', {
      indicator: indicatorId,
      countries: countries.join('_'),
    });
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const countryStr = countries.join(',');
          const url = `https://www.imf.org/external/datamapper/api/v1/${indicatorId}/${countryStr}`;
          const response = await loggedGet('imf', url, { ...sharedAxiosConfig, params: { periods: 30 } });

          const rawValues = response.data?.values?.[indicatorId] || {};
          const data: IMFDataPoint[] = [];

          for (const country of countries) {
            const countryData = rawValues[country] || {};
            for (const [year, value] of Object.entries(countryData)) {
              if (value !== null && value !== undefined) {
                data.push({ country, period: year, value: Number(value), unit: resolved.unit });
              }
            }
          }

          const filtered = params.periods
            ? (() => { const periodSet = new Set(params.periods); return data.filter(d => periodSet.has(d.period)); })()
            : data;

          return {
            source: 'imf',
            indicator: { id: indicatorId, name: resolved.name, unit: resolved.unit },
            countries,
            data: filtered.sort((a, b) => `${a.country}${a.period}`.localeCompare(`${b.country}${b.period}`)),
          };
        });
      }),
      24 * 60 * 60 * 1000,
      4 * 60 * 60 * 1000,
    );
  }

  async getCategories(): Promise<CategoryItem[]> {
    return Object.entries(IMFDataSource.INDICATORS).map(([key, val]) => ({
      id: key,
      imfId: val.id,
      name: val.name,
      unit: val.unit,
    }));
  }

  async search(keyword: string): Promise<SearchResult> {
    return filterIndicators(
      IMFDataSource.INDICATORS,
      keyword,
      'imf',
      (key, val) => ({ id: key, imfId: val.id, name: val.name }),
      ['name', 'id'],
    );
  }

  async listAllIndicators(): Promise<unknown> {
    const cacheKey = 'imf_indicators_list';
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const response = await loggedGet('imf', 'https://www.imf.org/external/datamapper/api/v1/indicators', sharedAxiosConfig);
          return response.data;
        });
      }),
      7 * 24 * 60 * 60 * 1000,
      12 * 60 * 60 * 1000,
    );
  }
}
