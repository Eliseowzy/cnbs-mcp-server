// src/services/data-sources/oecd.ts
import { DataSource } from '../api.js';
import { cacheHub, CacheKeyGenerator } from '../cache.js';
import { CnbsErrorHandler } from '../error.js';
import { cnbsRequestThrottler } from '../throttler.js';
import { sharedAxiosConfig, loggedGet } from '../http-client.js';
import { parseSdmxJson } from './sdmx-parser.js';
import type { SDMXFetchResult, CategoryItem, SearchResult } from '../../types/index.js';
import { filterIndicators } from './helpers.js';

export interface OECDFetchParams {
  dataset: string;
  key?: string;
  agencyId?: string;
  dataflowId?: string;
  startPeriod?: string;
  endPeriod?: string;
  lastNObservations?: number;
}

export class OECDDataSource implements DataSource<OECDFetchParams, SDMXFetchResult> {
  name = 'oecd';
  description = '经济合作与发展组织 (OECD SDMX REST API)';

  static readonly DATASETS: Record<string, {
    agencyId: string;
    dataflowId: string;
    version?: string;
    defaultKey?: string;
    defaultStartPeriod?: string;
    name: string;
    description: string;
  }> = {
    QNA_GDP: {
      agencyId: 'OECD.SDD.NAD',
      dataflowId: 'DSD_NAAG@DF_NAAG_I',
      version: '1.0',
      defaultKey: 'A..CHN+USA.S1..B1GQ.......',
      defaultStartPeriod: '2021',
      name: '年度国民账户 - GDP',
      description: '年度GDP，各成员国及主要经济体',
    },
    KEI_CPI: {
      agencyId: 'OECD.SDD.STES',
      dataflowId: 'DSD_STES@DF_CLI',
      name: '综合先行指标 (CLI)',
      description: 'OECD 综合先行指标，用于预判经济周期拐点',
    },
    EMPLOYMENT: {
      agencyId: 'OECD.ELS.SAE',
      dataflowId: 'DSD_LFS@DF_IALFS_UNE_M',
      name: '劳动力统计 - 失业',
      description: '月度失业率，LFS 口径',
    },
    TRADE: {
      agencyId: 'OECD.STD.TBS',
      dataflowId: 'DSD_TBS@DF_TRED_GOS',
      name: '商品贸易统计',
      description: 'OECD 成员国商品进出口',
    },
  };

  private cache = cacheHub.getCache<SDMXFetchResult>('oecd', {
    capacity: 1000,
    defaultExpire: 6 * 60 * 60 * 1000,
  });

  async fetchData(params: OECDFetchParams): Promise<SDMXFetchResult> {
    const preset = OECDDataSource.DATASETS[params.dataset?.toUpperCase()] || null;
    const agencyId = params.agencyId || preset?.agencyId;
    const dataflowId = params.dataflowId || preset?.dataflowId;
    const version = preset?.version;

    if (!agencyId || !dataflowId) {
      throw new Error(`未知 OECD 数据集 "${params.dataset}"。可用预置: ${Object.keys(OECDDataSource.DATASETS).join(', ')}`);
    }

    const key = params.key || preset?.defaultKey || 'all';
    const startPeriod = params.startPeriod || preset?.defaultStartPeriod;
    const cacheKey = CacheKeyGenerator.generateDataSourceKey('oecd', {
      agencyId,
      dataflowId,
      version: version || '',
      key,
      startPeriod: startPeriod || '',
      lastN: params.lastNObservations || 20,
    });
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const flowRef = version ? `${agencyId},${dataflowId},${version}` : `${agencyId},${dataflowId}`;
          const url = `https://sdmx.oecd.org/public/rest/data/${flowRef}/${key}`;
          const queryParams: Record<string, any> = {};
          if (startPeriod) queryParams.startPeriod = startPeriod;
          if (params.endPeriod) queryParams.endPeriod = params.endPeriod;
          if (params.lastNObservations) queryParams.lastNObservations = params.lastNObservations;
          queryParams.dimensionAtObservation = 'AllDimensions';

          const response = await loggedGet('oecd', url, {
            ...sharedAxiosConfig,
            params: queryParams,
            headers: { ...sharedAxiosConfig.headers, Accept: 'application/vnd.sdmx.data+json;version=2.0.0' },
          });
          const parsed = parseSdmxJson(response.data);

          return {
            source: 'oecd',
            dataset: { agencyId, dataflowId, ...(version ? { version } : {}), name: preset?.name || dataflowId },
            key,
            count: parsed.length,
            data: parsed,
            ...(parsed.length === 0 ? { warning: '上游返回成功但无观测值，请检查维度键是否正确' } : {}),
          };
        });
      }),
      24 * 60 * 60 * 1000,
      2 * 60 * 60 * 1000,
    );
  }

  async getCategories(): Promise<CategoryItem[]> {
    return Object.entries(OECDDataSource.DATASETS).map(([key, val]) => ({
      id: key,
      agencyId: val.agencyId,
      dataflowId: val.dataflowId,
      name: val.name,
      description: val.description,
    }));
  }

  async search(keyword: string): Promise<SearchResult> {
    return filterIndicators(
      OECDDataSource.DATASETS,
      keyword,
      'oecd',
      (key, val) => ({ id: key, agencyId: val.agencyId, dataflowId: val.dataflowId, name: val.name, description: val.description }),
      ['name', 'description'],
    );
  }
}
