// src/services/data-sources/bis.ts
import { DataSource } from '../api.js';
import { cacheHub, CacheKeyGenerator } from '../cache.js';
import { CnbsErrorHandler } from '../error.js';
import { cnbsRequestThrottler } from '../throttler.js';
import { sharedAxiosConfig, loggedGet } from '../http-client.js';
import { parseSdmxJson } from './sdmx-parser.js';
import type { SDMXFetchResult, CategoryItem, SearchResult } from '../../types/index.js';
import { filterIndicators } from './helpers.js';

export interface BISFetchParams {
  dataset: string;
  country?: string;
  key?: string;
  lastNObservations?: number;
  startPeriod?: string;
}

export class BISDataSource implements DataSource<BISFetchParams, SDMXFetchResult> {
  name = 'bis';
  description = '国际清算银行 (BIS Statistics)';

  static readonly DATASETS: Record<string, {
    dataflow: string;
    name: string;
    keyTemplate: string;
    description: string;
  }> = {
    EER: {
      dataflow: 'WS_EER',
      name: '有效汇率 (EER)',
      keyTemplate: 'M.N.B.{country}',
      description: '名义/实际有效汇率，基于 BIS 贸易加权',
    },
    CREDIT_GAP: {
      dataflow: 'WS_CREDIT_GAP',
      name: '信贷缺口',
      keyTemplate: 'Q.{country}',
      description: '私人非金融部门信贷占GDP缺口，BIS早期预警指标',
    },
    TOTAL_CREDIT: {
      dataflow: 'WS_TC',
      name: '私人非金融部门总信贷',
      keyTemplate: 'Q.P.{country}.A.770.A',
      description: '居民私人非金融部门总信贷，占GDP比',
    },
    PROPERTY_PRICES: {
      dataflow: 'WS_SPP',
      name: '住宅房价指数',
      keyTemplate: 'Q.N.{country}',
      description: '名义住宅房价指数（BIS汇编）',
    },
    DEBT_SERVICE: {
      dataflow: 'WS_DSR',
      name: '债务偿还比率 (DSR)',
      keyTemplate: 'Q.{country}.H.A',
      description: '住户部门债务偿还收入比',
    },
    CROSS_BORDER_BANKING: {
      dataflow: 'WS_LBS_D_PUB',
      name: '国际本地银行统计',
      keyTemplate: 'Q.S.B.{country}..A',
      description: 'BIS 汇报行对各国的跨境银行敞口',
    },
  };

  private cache = cacheHub.getCache<SDMXFetchResult>('bis', {
    capacity: 800,
    defaultExpire: 6 * 60 * 60 * 1000,
  });

  async fetchData(params: BISFetchParams): Promise<SDMXFetchResult> {
    const preset = BISDataSource.DATASETS[params.dataset?.toUpperCase()];
    if (!preset) {
      throw new Error(`未知 BIS 数据集 "${params.dataset}"。可用: ${Object.keys(BISDataSource.DATASETS).join(', ')}`);
    }

    const country = params.country || 'CN';
    const key = params.key || preset.keyTemplate.replace('{country}', country);
    const lastN = params.lastNObservations || 20;

    const cacheKey = CacheKeyGenerator.generateDataSourceKey('bis', {
      dataflow: preset.dataflow,
      key,
      lastN,
    });
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const url = `https://stats.bis.org/api/v1/data/${preset.dataflow}/${key}`;
          const queryParams: Record<string, any> = {
            lastNObservations: lastN,
          };
          if (params.startPeriod) queryParams.startPeriod = params.startPeriod;

          const response = await loggedGet('bis', url, {
            ...sharedAxiosConfig,
            params: queryParams,
            headers: { ...sharedAxiosConfig.headers, Accept: 'application/vnd.sdmx.data+json;version=1.0.0' },
          });
          const parsed = parseSdmxJson(response.data);

          return {
            source: 'bis',
            dataset: { dataflow: preset.dataflow, name: preset.name, description: preset.description },
            country,
            key,
            count: parsed.length,
            data: parsed,
            ...(parsed.length === 0 ? { warning: '上游返回成功但无观测值，请检查维度键是否正确' } : {}),
          };
        });
      }),
      12 * 60 * 60 * 1000,
      60 * 60 * 1000,
    );
  }

  async getCategories(): Promise<CategoryItem[]> {
    return Object.entries(BISDataSource.DATASETS).map(([key, val]) => ({
      id: key,
      dataflow: val.dataflow,
      name: val.name,
      description: val.description,
      keyTemplate: val.keyTemplate,
    }));
  }

  async search(keyword: string): Promise<SearchResult> {
    return filterIndicators(
      BISDataSource.DATASETS,
      keyword,
      'bis',
      (key, val) => ({ id: key, dataflow: val.dataflow, name: val.name }),
      ['name', 'description'],
    );
  }
}
