// src/types/api-responses.ts
// Typed response envelopes for upstream APIs.

import {
  CnbsRawNodeItem,
  CnbsRawMetricItem,
  CnbsRawSeriesDataItem,
  CnbsRawSearchItem,
} from './index.js';

// ─── CNBS (NBS) API Responses ──────────────────────────────────────────────

export interface CnbsSearchResponse {
  code?: number;
  msg?: string;
  data?: CnbsRawSearchItem[];
  total?: number;
}

export interface CnbsNodeResponse {
  code?: number;
  msg?: string;
  data?: CnbsRawNodeItem[];
}

export interface CnbsMetricListData {
  list?: CnbsRawMetricItem[];
  total?: number;
}

export interface CnbsMetricResponse {
  code?: number;
  msg?: string;
  data?: CnbsMetricListData;
}

export interface CnbsSeriesResponse {
  code?: number;
  msg?: string;
  data?: CnbsRawSeriesDataItem[];
}

// ─── World Bank API Responses ──────────────────────────────────────────────

export interface WorldBankDataPoint {
  country: string;
  countryCode: string;
  period: string;
  value: number | null;
  unit: string;
}

export interface WorldBankIndicatorInfo {
  id: string;
  name: string;
  unit: string;
}

export interface WorldBankFetchResult {
  source: 'world_bank';
  indicator: WorldBankIndicatorInfo;
  countries: string[];
  meta: {
    total?: number;
    page?: number;
    lastUpdated?: string;
  };
  data: WorldBankDataPoint[];
  [key: string]: unknown;
}

// ─── IMF API Responses ─────────────────────────────────────────────────────

export interface IMFDataPoint {
  country: string;
  period: string;
  value: number;
  unit: string;
}

export interface IMFFetchResult {
  source: 'imf';
  indicator: { id: string; name: string; unit: string };
  countries: string[];
  data: IMFDataPoint[];
  [key: string]: unknown;
}

// ─── OECD / BIS (SDMX) Responses ──────────────────────────────────────────

export interface SDMXFetchResult {
  source: 'oecd' | 'bis';
  dataset: Record<string, string>;
  key?: string;
  country?: string;
  count: number;
  data: Array<{
    period: string;
    value: number | null;
    dimensions: Record<string, string>;
  }>;
  [key: string]: unknown;
}

// ─── Generic Data Source Types ─────────────────────────────────────────────

export interface CategoryItem {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface SearchResult {
  keyword: string;
  source: string;
  results: unknown;
  [key: string]: unknown;
}
