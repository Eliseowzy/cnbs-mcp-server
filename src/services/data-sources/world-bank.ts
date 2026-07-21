// src/services/data-sources/world-bank.ts
import { DataSource } from '../api.js';
import { cacheHub, CacheKeyGenerator } from '../cache.js';
import { CnbsErrorHandler } from '../error.js';
import { cnbsRequestThrottler } from '../throttler.js';
import { sharedAxiosConfig, loggedGet } from '../http-client.js';
import type { WorldBankFetchResult, CategoryItem, SearchResult } from '../../types/index.js';
import { filterIndicators } from './helpers.js';

export interface WorldBankFetchParams {
  indicator: string;
  countries?: string[];
  startYear?: number;
  endYear?: number;
  mrv?: number;
}

export class WorldBankDataSource implements DataSource<WorldBankFetchParams, WorldBankFetchResult> {
  name = 'world_bank';
  description = '世界银行开放数据 (World Bank Open Data)';

  static readonly INDICATORS: Record<string, { id: string; name: string; unit: string }> = {
    GDP:              { id: 'NY.GDP.MKTP.CD',      name: 'GDP（现价美元）',       unit: '美元' },
    GDP_GROWTH:       { id: 'NY.GDP.MKTP.KD.ZG',   name: 'GDP增速（年）',         unit: '%' },
    GDP_PER_CAPITA:   { id: 'NY.GDP.PCAP.CD',      name: '人均GDP（现价美元）',   unit: '美元' },
    CPI:              { id: 'FP.CPI.TOTL.ZG',      name: 'CPI通胀率（年）',       unit: '%' },
    UNEMPLOYMENT:     { id: 'SL.UEM.TOTL.ZS',      name: '失业率',               unit: '%' },
    POPULATION:       { id: 'SP.POP.TOTL',         name: '总人口',               unit: '人' },
    EXPORTS:          { id: 'NE.EXP.GNFS.CD',      name: '商品和服务出口（美元）', unit: '美元' },
    IMPORTS:          { id: 'NE.IMP.GNFS.CD',      name: '商品和服务进口（美元）', unit: '美元' },
    FDI_INFLOWS:      { id: 'BX.KLT.DINV.CD.WD',   name: '外商直接投资净流入',    unit: '美元' },
    GOVT_DEBT:        { id: 'GC.DOD.TOTL.GD.ZS',   name: '政府债务占GDP比',       unit: '%' },
    GROSS_SAVINGS:    { id: 'NY.GNS.ICTR.ZS',      name: '总储蓄率占GNI比',       unit: '%' },
    TRADE_PCT_GDP:    { id: 'NE.TRD.GNFS.ZS',      name: '贸易占GDP比',          unit: '%' },
    GINI:             { id: 'SI.POV.GINI',          name: '基尼系数',             unit: '' },
    LIFE_EXPECTANCY:  { id: 'SP.DYN.LE00.IN',      name: '预期寿命',             unit: '岁' },
    CO2_EMISSIONS:    { id: 'EN.ATM.CO2E.PC',      name: '人均CO2排放',          unit: '吨' },
    INTERNET_USERS:   { id: 'IT.NET.USER.ZS',      name: '互联网用户占比',        unit: '%' },
    INFLATION:        { id: 'NY.GDP.DEFL.KD.ZG',   name: 'GDP平减指数通胀率',    unit: '%' },
    CURRENT_ACCOUNT:  { id: 'BN.CAB.XOKA.GD.ZS',   name: '经常账户余额占GDP比',  unit: '%' },
  };

  private cache = cacheHub.getCache<WorldBankFetchResult>('world_bank', {
    capacity: 2000,
    defaultExpire: 24 * 60 * 60 * 1000,
  });

  async fetchData(params: WorldBankFetchParams): Promise<WorldBankFetchResult> {
    const resolved = WorldBankDataSource.INDICATORS[params.indicator?.toUpperCase()]
      || { id: params.indicator, name: params.indicator, unit: '' };
    const indicatorId = resolved.id;
    const countries = params.countries?.join(';') || 'CHN';
    const startYear = params.startYear || 2000;
    const endYear = params.endYear || new Date().getFullYear();

    const cacheKey = CacheKeyGenerator.generateDataSourceKey('world_bank', {
      indicator: indicatorId,
      countries,
      startYear,
      endYear,
    });
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const url = `https://api.worldbank.org/v2/country/${countries}/indicator/${indicatorId}`;
          const response = await loggedGet('world_bank', url, {
            ...sharedAxiosConfig,
            params: {
              format: 'json',
              date: `${startYear}:${endYear}`,
              per_page: 200,
              ...(params.mrv ? { mrv: params.mrv } : {}),
            },
          });

          const [meta, dataPoints] = response.data as [
            { total?: number; page?: number; lastupdated?: string } | null,
            Array<{
              value: number | null;
              country?: { value?: string; id?: string };
              countryiso3code?: string;
              date: string;
            }> | null,
          ];
          if (!dataPoints) throw new Error('World Bank API returned empty data');

          return {
            source: 'world_bank',
            indicator: { id: indicatorId, name: resolved.name, unit: resolved.unit },
            countries: countries.split(';'),
            meta: {
              total: meta?.total,
              page: meta?.page,
              lastUpdated: meta?.lastupdated,
            },
            data: dataPoints
              .filter(d => d.value !== null)
              .map(d => ({
                country: d.country?.value ?? '',
                countryCode: d.countryiso3code || d.country?.id || '',
                period: d.date,
                value: d.value,
                unit: resolved.unit,
              }))
              .sort((a, b) => String(a.period).localeCompare(String(b.period))),
          };
        });
      }),
      24 * 60 * 60 * 1000,
      2 * 60 * 60 * 1000,
    );
  }

  async getCategories(): Promise<CategoryItem[]> {
    return Object.entries(WorldBankDataSource.INDICATORS).map(([key, val]) => ({
      id: key,
      wbId: val.id,
      name: val.name,
      unit: val.unit,
    }));
  }

  async search(keyword: string): Promise<SearchResult> {
    return filterIndicators(
      WorldBankDataSource.INDICATORS,
      keyword,
      'world_bank',
      (key, val) => ({ id: key, wbId: val.id, name: val.name, unit: val.unit }),
      ['name', 'id'],
    );
  }

  async fetchMulti(params: {
    indicators: string[];
    countries?: string[];
    startYear?: number;
    endYear?: number;
  }): Promise<Record<string, WorldBankFetchResult | { error: string }>> {
    const results: Record<string, WorldBankFetchResult | { error: string }> = {};
    for (const ind of params.indicators) {
      try {
        results[ind] = await this.fetchData({ ...params, indicator: ind });
      } catch (e) {
        results[ind] = { error: (e as Error).message };
      }
    }
    return results;
  }
}
