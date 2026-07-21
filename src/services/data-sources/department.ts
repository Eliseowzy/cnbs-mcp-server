// src/services/data-sources/department.ts
import { DataSource } from '../api.js';
import { cacheHub, CacheKeyGenerator } from '../cache.js';
import { CnbsErrorHandler } from '../error.js';
import { cnbsRequestThrottler } from '../throttler.js';
import { CnbsModernClient } from '../api.js';
import type { CategoryItem, SearchResult } from '../../types/index.js';

export interface DepartmentFetchParams {
  department: string;
  indicator?: string;
  pageSize?: number;
}

export interface DepartmentFetchResult {
  source: string;
  department: string;
  name: string;
  ministry: string;
  keyword: string;
  data: unknown;
  [key: string]: unknown;
}

export class DepartmentDataSource implements DataSource<DepartmentFetchParams, DepartmentFetchResult> {
  name = 'department';
  description = '各部门统计数据（财政、工信、商务、农业、央行等）—— 通过国家统计局发布';

  private nbsClient = new CnbsModernClient();

  static readonly DEPARTMENTS: Record<string, {
    name: string;
    ministry: string;
    keywords: string[];
  }> = {
    finance: {
      name: '财政统计',
      ministry: '财政部',
      keywords: ['财政收入', '财政支出', '税收收入', '国债余额', '一般公共预算'],
    },
    industry: {
      name: '工业统计',
      ministry: '工业和信息化部',
      keywords: ['工业增加值', '规模以上工业', '制造业', '高技术产业', '工业生产'],
    },
    trade: {
      name: '商务统计',
      ministry: '商务部',
      keywords: ['进出口总额', '出口总额', '进口总额', '实际利用外资', '对外贸易'],
    },
    agriculture: {
      name: '农业统计',
      ministry: '农业农村部',
      keywords: ['粮食产量', '农产品', '农村居民收入', '农业增加值', '耕地面积'],
    },
    monetary: {
      name: '货币金融统计',
      ministry: '中国人民银行',
      keywords: ['M2货币供应量', '社会融资规模', '银行贷款', '存款余额', '贷款利率'],
    },
    social_security: {
      name: '社会保障统计',
      ministry: '人力资源和社会保障部',
      keywords: ['城镇登记失业率', '就业人员', '养老保险', '医疗保险', '社会保障基金'],
    },
    housing: {
      name: '房地产统计',
      ministry: '住房和城乡建设部',
      keywords: ['商品房销售额', '房地产开发投资', '住宅价格', '新建商品房', '建筑业'],
    },
    energy: {
      name: '能源统计',
      ministry: '国家能源局',
      keywords: ['能源消耗', '电力消费', '发电量', '新能源', '煤炭产量'],
    },
  };

  private cache = cacheHub.getCache<DepartmentFetchResult>('department', {
    capacity: 800,
    defaultExpire: 12 * 60 * 60 * 1000,
  });

  async fetchData(params: DepartmentFetchParams): Promise<DepartmentFetchResult> {
    const preset = DepartmentDataSource.DEPARTMENTS[params.department];
    if (!preset) {
      throw new Error(
        `未知部门 "${params.department}"。可用: ${Object.keys(DepartmentDataSource.DEPARTMENTS).join(', ')}`
      );
    }

    const keyword = params.indicator || preset.keywords[0];
    const cacheKey = CacheKeyGenerator.generateDataSourceKey('department', {
      department: params.department,
      keyword,
    });
    return this.cache.fetchOrLoad(
      cacheKey,
      () => cnbsRequestThrottler.execute(async () => {
        return CnbsErrorHandler.retryWithBackoff(async () => {
          const result = await this.nbsClient.findItems({
            keyword,
            pageSize: params.pageSize || 20,
          });

          return {
            source: 'department_nbs',
            department: params.department,
            name: preset.name,
            ministry: preset.ministry,
            keyword,
            data: result,
          };
        });
      }),
      4 * 60 * 60 * 1000,
      30 * 60 * 1000,
    );
  }

  async getCategories(): Promise<CategoryItem[]> {
    return Object.entries(DepartmentDataSource.DEPARTMENTS).map(([key, val]) => ({
      id: key,
      name: val.name,
      ministry: val.ministry,
      keywords: val.keywords,
    }));
  }

  async search(keyword: string): Promise<SearchResult> {
    return cnbsRequestThrottler.execute(async () => {
      return CnbsErrorHandler.retryWithBackoff(async () => {
        const result = await this.nbsClient.findItems({ keyword, pageSize: 20 });
        return { keyword, source: 'department_nbs', results: result };
      });
    });
  }

  async fetchAllKeywordsForDepartment(department: string): Promise<any> {
    const preset = DepartmentDataSource.DEPARTMENTS[department];
    if (!preset) throw new Error(`未知部门 "${department}"`);

    const results: Record<string, any> = {};
    for (const kw of preset.keywords) {
      try {
        const result = await this.nbsClient.findItems({ keyword: kw, pageSize: 5 });
        results[kw] = result;
      } catch (e) {
        results[kw] = { error: (e as Error).message };
      }
    }
    return { department, name: preset.name, ministry: preset.ministry, results };
  }
}
