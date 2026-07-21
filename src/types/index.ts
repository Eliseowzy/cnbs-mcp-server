export interface CnbsRawNodeItem {
  _id: string;
  _name: string;
  name: string;
  isLeaf: boolean;
  treeinfo_globalid?: string;
  sdate?: string;
  edate?: string;
  treeinfo_pid?: string;
  treeinfo_level?: number;
  type?: string;
  explain?: string;
}

export interface CnbsRawMetricItem {
  _id: string;
  i_showname: string;
  _name?: string;
  ek?: string;
  i_annotation?: string;
  i_mark?: string;
  dp?: string;
  num_accuracy_value?: string;
  order?: number;
  ds_order?: number;
}

export interface CnbsRawSeriesValue {
  _id: string;
  i_showname: string;
  _name?: string;
  ek?: string;
  value: string | number;
  du_name?: string;
  accuracy?: string;
  order?: number;
}

export interface CnbsRawSeriesDataItem {
  code: string;
  name: string;
  values: CnbsRawSeriesValue[];
}

export interface CnbsRawSearchItem {
  show_name: string;
  type_text: string;
  treeinfo_globalid?: string;
  cid?: string;
  dt?: string;
  explain?: string;
  indic_id?: string;
  ek?: string;
  i?: string;
  type_value?: string;
  da_name?: string;
  dt_name?: string;
  i_name?: string;
  dt_type?: string;
  da?: string;
  value?: string;
  ek_name?: string;
}

export interface CnbsArea {
  text: string;
  code: string;
}

export interface CnbsSeriesQuery {
  setId: string;
  metricIds: string[];
  areas: CnbsArea[];
  periods: string[];
  displayMode?: string;
  rootId?: string;
}

export interface CnbsNodeQuery {
  parentId?: string;
  category: string;
}

export interface CnbsMetricQuery {
  setId: string;
  dataType?: string;
  name?: string;
}

export interface CnbsSearchQuery {
  keyword: string;
  pageNum?: number;
  pageSize?: number;
}

export enum CnbsCategory {
  MONTHLY = '1',
  QUARTERLY = '2',
  YEARLY = '3',
  PROVINCE_QUARTERLY = '5',
  PROVINCE_YEARLY = '6',
  OTHER = '7',
}

export interface CnbsCacheSettings {
  treeTTL?: number;
  metricTTL?: number;
  dataTTL?: number;
}

export interface CnbsClientConfig {
  baseUrl?: string;
  timeout?: number;
  cache?: CnbsCacheSettings;
  rootId?: string;
}

// Re-export typed API response envelopes
export type {
  CnbsSearchResponse,
  CnbsNodeResponse,
  CnbsMetricListData,
  CnbsMetricResponse,
  CnbsSeriesResponse,
  WorldBankDataPoint,
  WorldBankIndicatorInfo,
  WorldBankFetchResult,
  IMFDataPoint,
  IMFFetchResult,
  SDMXFetchResult,
  CategoryItem,
  SearchResult,
} from './api-responses.js';

