// src/services/data-sources/census.ts
import { DataSource } from '../api.js';
import { cacheHub, CacheKeyGenerator } from '../cache.js';
import { CnbsErrorHandler } from '../error.js';
import { cnbsRequestThrottler } from '../throttler.js';
import { CnbsModernClient } from '../api.js';
import type { CategoryItem, SearchResult } from '../../types/index.js';

export interface CensusFetchParams {
  type?: string;
  keyword?: string;
  pageSize?: number;
}

export interface CensusFetchResult {
  source: string;
  censusType: string;
  name: string;
  latestYear?: string;
  searchKeyword: string;
  data: unknown;
  [key: string]: unknown;
}

export class CensusDataSource implements DataSource<CensusFetchParams, CensusFetchResult> {
  name = 'census';
  description = '国家统计局普查数据（人口/经济/农业）';

  private nbsClient = new CnbsModernClient();

  static readonly CENSUS_KEYWORDS: Record<string, { keywords: string[]; name: string; latestYear: string }> = {
    population: {
      keywords: ['人口普查', '第七次全国人口普查', '人口普查数据'],
      name: '人口普查（2020年第七次）',
      latestYear: '2020',
    },
    economic: {
      keywords: ['经济普查', '第四次全国经济普查'],
      name: '经济普查（2018年第四次）',
      latestYear: '2018',
    },
    agriculture: {
      keywords: ['农业普查', '第三次全国农业普查'],
      name: '农业普查（2016年第三次）',
      latestYear: '2016',
    },
  };

  private cache = cacheHub.getCache<CensusFetchResult>('census', {
    capacity: 500,
    defaultExpire: 24 * 60 * 60 * 1000,
  });

  async fetchData(params: CensusFetchParams): Promise<CensusFetchResult> {
    const censusType = params.type || 'population';
    const preset = CensusDataSource.CENSUS_KEYWORDS[censusType];

    const searchKeyword = params.keyword || (preset?.keywords[0] ?? '人口普查');
    const cacheKey = CacheKeyGenerator.generateDataSourceKey('census', {
      type: censusType,
      keyword: searchKeyword,
    });
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const searchResult = await this.nbsClient.findItems({
            keyword: searchKeyword,
            pageSize: params.pageSize || 20,
          });

          return {
            source: 'census_nbs',
            censusType,
            name: preset?.name || censusType,
            latestYear: preset?.latestYear,
            searchKeyword,
            data: searchResult,
          };
        });
      }),
      7 * 24 * 60 * 60 * 1000,
      24 * 60 * 60 * 1000,
    );
  }

  async getCategories(): Promise<CategoryItem[]> {
    return Object.entries(CensusDataSource.CENSUS_KEYWORDS).map(([key, val]) => ({
      id: key,
      name: val.name,
      latestYear: val.latestYear,
      keywords: val.keywords,
    }));
  }

  async search(keyword: string): Promise<SearchResult> {
    return cnbsRequestThrottler.execute(async () => {
      return CnbsErrorHandler.retryWithBackoff(async () => {
        const result = await this.nbsClient.findItems({ keyword, pageSize: 20 });
        return { keyword, source: 'census_nbs', results: result };
      });
    });
  }
}
