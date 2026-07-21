// src/services/data-sources/international.ts
import { DataSource } from '../api.js';
import { WorldBankDataSource } from './world-bank.js';
import { IMFDataSource } from './imf.js';
import { OECDDataSource } from './oecd.js';
import { BISDataSource } from './bis.js';
import type { CategoryItem, SearchResult } from '../../types/index.js';

export interface InternationalFetchParams {
  source?: string;
  [key: string]: unknown;
}

export class InternationalDataSource implements DataSource<InternationalFetchParams, unknown> {
  name = 'international';
  description = '国际统计数据聚合（世界银行 / IMF / OECD / BIS）';

  private worldBank = new WorldBankDataSource();
  private imf = new IMFDataSource();
  private oecd = new OECDDataSource();
  private bis = new BISDataSource();

  async fetchData(params: InternationalFetchParams): Promise<unknown> {
    const src = params.source || 'world_bank';
    switch (src) {
      case 'world_bank': return this.worldBank.fetchData(params as unknown as Parameters<WorldBankDataSource['fetchData']>[0]);
      case 'imf':        return this.imf.fetchData(params as unknown as Parameters<IMFDataSource['fetchData']>[0]);
      case 'oecd':       return this.oecd.fetchData(params as unknown as Parameters<OECDDataSource['fetchData']>[0]);
      case 'bis':        return this.bis.fetchData(params as unknown as Parameters<BISDataSource['fetchData']>[0]);
      default:
        throw new Error(`未知国际数据来源 "${src}"。可选: world_bank, imf, oecd, bis`);
    }
  }

  async getCategories(): Promise<CategoryItem[]> {
    return [
      { id: 'world_bank', name: '世界银行', description: '宏观发展指标、人口、贸易等' },
      { id: 'imf',        name: 'IMF',      description: 'WEO 预测、经常账户、政府债务等' },
      { id: 'oecd',       name: 'OECD',     description: '季度GDP、就业、先行指标等' },
      { id: 'bis',        name: 'BIS',      description: '有效汇率、信贷缺口、跨境银行统计等' },
    ];
  }

  async search(keyword: string): Promise<SearchResult> {
    const [wbRes, imfRes, oecdRes, bisRes] = await Promise.allSettled([
      this.worldBank.search(keyword),
      this.imf.search(keyword),
      this.oecd.search(keyword),
      this.bis.search(keyword),
    ]);
    return {
      keyword,
      source: 'international',
      results: {
        world_bank: wbRes.status === 'fulfilled' ? wbRes.value : null,
        imf:        imfRes.status === 'fulfilled' ? imfRes.value : null,
        oecd:       oecdRes.status === 'fulfilled' ? oecdRes.value : null,
        bis:        bisRes.status === 'fulfilled' ? bisRes.value : null,
      },
    };
  }
}
