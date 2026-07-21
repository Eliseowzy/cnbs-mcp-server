// src/services/data-sources/index.ts
// Unified exports and DataSourceManager for all data sources.
import { DataSource } from '../api.js';
import { WorldBankDataSource } from './world-bank.js';
import { IMFDataSource } from './imf.js';
import { OECDDataSource } from './oecd.js';
import { BISDataSource } from './bis.js';
import { CensusDataSource } from './census.js';
import { DepartmentDataSource } from './department.js';
import { InternationalDataSource } from './international.js';
import type { CategoryItem, SearchResult } from '../../types/index.js';

// Re-export all data source classes
export { WorldBankDataSource } from './world-bank.js';
export { IMFDataSource } from './imf.js';
export { OECDDataSource } from './oecd.js';
export { BISDataSource } from './bis.js';
export { CensusDataSource } from './census.js';
export { DepartmentDataSource } from './department.js';
export { InternationalDataSource } from './international.js';
export { filterIndicators } from './helpers.js';
export { parseSdmxJson } from './sdmx-parser.js';
export type { SDMXDataPoint } from './sdmx-parser.js';

// Re-export param/result types
export type { WorldBankFetchParams } from './world-bank.js';
export type { IMFFetchParams } from './imf.js';
export type { OECDFetchParams } from './oecd.js';
export type { BISFetchParams } from './bis.js';
export type { CensusFetchParams, CensusFetchResult } from './census.js';
export type { DepartmentFetchParams, DepartmentFetchResult } from './department.js';
export type { InternationalFetchParams } from './international.js';

// Singleton instances for direct tool usage
export const worldBankSource = new WorldBankDataSource();
export const imfSource = new IMFDataSource();
export const oecdSource = new OECDDataSource();
export const bisSource = new BISDataSource();
export const censusSource = new CensusDataSource();
export const departmentSource = new DepartmentDataSource();

// ─── DataSourceManager ─────────────────────────────────────────────────────

export class DataSourceManager {
  private sources: Map<string, DataSource<any, any>> = new Map();

  constructor() {
    this.registerDefaultSources();
  }

  private registerDefaultSources() {
    this.registerSource('world_bank',    worldBankSource);
    this.registerSource('imf',           imfSource);
    this.registerSource('oecd',          oecdSource);
    this.registerSource('bis',           bisSource);
    this.registerSource('census',        censusSource);
    this.registerSource('department',    departmentSource);
    this.registerSource('international', new InternationalDataSource());
  }

  registerSource(name: string, source: DataSource<any, any>) {
    this.sources.set(name, source);
  }

  getSource(name: string): DataSource<any, any> | null {
    return this.sources.get(name) || null;
  }

  listSources(): Array<{ name: string; description: string }> {
    return Array.from(this.sources.entries()).map(([name, source]) => ({
      name,
      description: source.description,
    }));
  }

  async fetchData(sourceName: string, params: Record<string, unknown>): Promise<unknown> {
    const source = this.getSource(sourceName);
    if (!source) throw new Error(`DataSource "${sourceName}" not found`);
    return source.fetchData(params);
  }

  async getCategories(sourceName: string): Promise<CategoryItem[]> {
    const source = this.getSource(sourceName);
    if (!source) throw new Error(`DataSource "${sourceName}" not found`);
    return source.getCategories();
  }

  async search(sourceName: string, keyword: string): Promise<SearchResult> {
    const source = this.getSource(sourceName);
    if (!source) throw new Error(`DataSource "${sourceName}" not found`);
    return source.search(keyword);
  }

  async batchFetchData(batchRequests: Array<{ sourceName: string; params: Record<string, unknown> }>): Promise<Array<{
    sourceName: string;
    params: Record<string, unknown>;
    result: unknown;
    error?: string;
  }>> {
    return Promise.all(batchRequests.map(async (request) => {
      try {
        const result = await this.fetchData(request.sourceName, request.params);
        return { sourceName: request.sourceName, params: request.params, result };
      } catch (error) {
        return {
          sourceName: request.sourceName,
          params: request.params,
          result: null,
          error: (error as Error).message,
        };
      }
    }));
  }

  async batchGetCategories(sourceNames: string[]): Promise<Array<{
    sourceName: string;
    categories: CategoryItem[];
    error?: string;
  }>> {
    return Promise.all(sourceNames.map(async (sourceName) => {
      try {
        const categories = await this.getCategories(sourceName);
        return { sourceName, categories };
      } catch (error) {
        return { sourceName, categories: [] as CategoryItem[], error: (error as Error).message };
      }
    }));
  }

  async batchSearch(batchRequests: Array<{ sourceName: string; keyword: string }>): Promise<Array<{
    sourceName: string;
    keyword: string;
    result: SearchResult | null;
    error?: string;
  }>> {
    return Promise.all(batchRequests.map(async (request) => {
      try {
        const result = await this.search(request.sourceName, request.keyword);
        return { sourceName: request.sourceName, keyword: request.keyword, result };
      } catch (error) {
        return {
          sourceName: request.sourceName,
          keyword: request.keyword,
          result: null,
          error: (error as Error).message,
        };
      }
    }));
  }
}

export const dataSourceManager = new DataSourceManager();
