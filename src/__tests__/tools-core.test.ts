jest.mock('../tools/context', () => ({
  cnbsModernClient: {
    findItems: jest.fn(),
    fetchNodes: jest.fn(),
    fetchMetrics: jest.fn(),
    fetchSeries: jest.fn(),
    fetchAllEndNodes: jest.fn(),
    batchFindItems: jest.fn(),
    findAndFetch: jest.fn(),
    batchFetchSeries: jest.fn(),
  },
}));

import { registerCnbsCoreTools } from '../tools/cnbs-core';
import { cnbsModernClient } from '../tools/context';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

const client = cnbsModernClient as unknown as Record<string, jest.Mock>;

function buildTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as Parameters<typeof registerCnbsCoreTools>[0];
  registerCnbsCoreTools(server);
  return tools;
}

describe('cnbs-core tools', () => {
  let tools: Map<string, ToolHandler>;

  beforeEach(() => {
    Object.values(client).forEach((fn) => fn.mockReset());
    tools = buildTools();
  });

  it('registers the expected core tools', () => {
    expect([...tools.keys()]).toEqual(
      expect.arrayContaining([
        'cnbs_search',
        'cnbs_fetch_nodes',
        'cnbs_fetch_metrics',
        'cnbs_fetch_series',
        'cnbs_fetch_end_nodes',
        'cnbs_batch_search',
        'cnbs_compare',
        'cnbs_economic_snapshot',
        'cnbs_quick_query',
        'cnbs_batch_series',
      ]),
    );
  });

  describe('cnbs_search', () => {
    it('returns search results', async () => {
      client.findItems.mockResolvedValue({ data: [{ show_name: 'GDP' }] });
      const res = await tools.get('cnbs_search')!({ keyword: 'GDP', pageNum: 1, pageSize: 10 });
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toEqual({ results: { data: [{ show_name: 'GDP' }] } });
    });

    it('returns a tool error on failure', async () => {
      client.findItems.mockRejectedValue(new Error('boom'));
      const res = await tools.get('cnbs_search')!({ keyword: 'GDP' });
      expect(res.isError).toBe(true);
    });
  });

  describe('cnbs_fetch_nodes', () => {
    it('handles a single category', async () => {
      client.fetchNodes.mockResolvedValue({ data: [{ _id: 'n1', isLeaf: true }] });
      const res = await tools.get('cnbs_fetch_nodes')!({ categories: '3' });
      expect(client.fetchNodes).toHaveBeenCalledTimes(1);
      expect(res.structuredContent).toEqual({
        results: [{ key: '3', data: { data: [{ _id: 'n1', isLeaf: true }] } }],
        count: 1,
      });
    });

    it('handles multiple categories with per-category grouping', async () => {
      client.fetchNodes
        .mockResolvedValueOnce({ data: [{ _id: 'a' }] })
        .mockResolvedValueOnce({ data: [{ _id: 'b' }] });
      const res = await tools.get('cnbs_fetch_nodes')!({ categories: ['1', '2'] });
      expect(client.fetchNodes).toHaveBeenCalledTimes(2);
      expect(res.structuredContent).toMatchObject({ count: 2 });
      expect((res.structuredContent?.results as Array<{ key: string }>).map((item) => item.key)).toEqual(['1', '2']);
    });
  });

  describe('cnbs_fetch_metrics', () => {
    it('handles a single setId', async () => {
      client.fetchMetrics.mockResolvedValue({ data: { list: [{ _id: 'm1' }] } });
      const res = await tools.get('cnbs_fetch_metrics')!({ setIds: 'set1' });
      expect(res.structuredContent).toEqual({
        results: [{ key: 'set1', data: { data: { list: [{ _id: 'm1' }] } } }],
        count: 1,
      });
    });
  });

  describe('cnbs_fetch_series', () => {
    it('returns series data', async () => {
      client.fetchSeries.mockResolvedValue({ data: [{ code: '00', values: [] }] });
      const res = await tools.get('cnbs_fetch_series')!({
        setId: 'set1',
        metricIds: ['m1'],
        periods: ['2024YY'],
        areas: [{ text: '全国', code: '000000000000' }],
      });
      expect(res.structuredContent).toHaveProperty('series');
    });
  });

  describe('cnbs_fetch_end_nodes', () => {
    it('returns leaf nodes', async () => {
      client.fetchAllEndNodes.mockResolvedValue([{ _id: 'leaf', isLeaf: true }]);
      const res = await tools.get('cnbs_fetch_end_nodes')!({ category: '3' });
      expect(res.structuredContent).toHaveProperty('endNodes');
    });
  });

  describe('cnbs_batch_search', () => {
    it('returns batched results', async () => {
      client.batchFindItems.mockResolvedValue({ GDP: { data: [] }, CPI: { data: [] } });
      const res = await tools.get('cnbs_batch_search')!({ keywords: ['GDP', 'CPI'], pageSize: 5 });
      expect(res.structuredContent).toEqual({
        results: [
          { key: 'GDP', data: { data: [] } },
          { key: 'CPI', data: { data: [] } },
        ],
        count: 2,
      });
    });
  });

  describe('cnbs_economic_snapshot', () => {
    it('extracts the first data item per keyword', async () => {
      client.batchFindItems.mockResolvedValue({
        GDP: { data: [{ value: '100', show_name: '国内生产总值(亿元)', dt: '2024' }] },
      });
      const res = await tools.get('cnbs_economic_snapshot')!({});
      const snapshot = (res.structuredContent as { snapshot: Array<Record<string, unknown>> }).snapshot;
      const gdp = snapshot.find((s) => s.indicator === 'GDP');
      expect(gdp?.value).toBe('100');
      expect(gdp?.unit).toBe('亿元');
    });

    it('handles error entries gracefully', async () => {
      client.batchFindItems.mockResolvedValue({ GDP: { error: 'blocked' } });
      const res = await tools.get('cnbs_economic_snapshot')!({});
      const snapshot = (res.structuredContent as { snapshot: Array<Record<string, unknown>> }).snapshot;
      const gdp = snapshot.find((s) => s.indicator === 'GDP');
      expect(gdp?.value).toBeNull();
    });
  });

  describe('cnbs_quick_query', () => {
    it('delegates to findAndFetch', async () => {
      client.findAndFetch.mockResolvedValue({ setId: 's', metric: { _id: 'm' }, series: { data: [] } });
      const res = await tools.get('cnbs_quick_query')!({ keyword: 'GDP' });
      expect(client.findAndFetch).toHaveBeenCalledWith('GDP', undefined, undefined, undefined);
      expect(res.structuredContent).toHaveProperty('setId', 's');
    });

    it('returns a tool error on failure', async () => {
      client.findAndFetch.mockRejectedValue(new Error('not found'));
      const res = await tools.get('cnbs_quick_query')!({ keyword: 'zzz' });
      expect(res.isError).toBe(true);
    });

    it('passes through warning and candidates to structuredContent', async () => {
      client.findAndFetch.mockResolvedValue({
        setId: 's1',
        metric: { _id: 'm1' },
        series: { data: [] },
        warning: '关键词较宽泛，命中多个数据集；如需其它板块请参见 candidates 列表。',
        candidates: [
          { name: '医疗卫生', setId: 's1', granularity: '月度', dt: '202401' },
          { name: '医药制造', setId: 's2', granularity: '年度', dt: '2024' },
        ],
      });
      const res = await tools.get('cnbs_quick_query')!({ keyword: '医疗' });
      expect(res.structuredContent).toHaveProperty('warning');
      expect(res.structuredContent).toHaveProperty('candidates');
      expect((res.structuredContent as Record<string, unknown>).candidates).toHaveLength(2);
    });
  });

  describe('cnbs_batch_series', () => {
    it('delegates to batchFetchSeries with normalized areas', async () => {
      client.batchFetchSeries.mockResolvedValue([{ query: {}, result: { data: [] } }]);
      const res = await tools.get('cnbs_batch_series')!({
        queries: [{ setId: 's1', metricIds: ['m1'], periods: ['2024YY'] }],
      });
      expect(client.batchFetchSeries).toHaveBeenCalledTimes(1);
      const passed = client.batchFetchSeries.mock.calls[0][0];
      expect(passed[0].areas).toEqual([{ text: '全国', code: '000000000000' }]);
      expect(res.structuredContent).toHaveProperty('count', 1);
    });
  });

  describe('cnbs_compare', () => {
    it('groups a region comparison', async () => {
      client.findItems.mockResolvedValue({
        data: [
          { da_name: '北京', da: '110000000000', value: '100', show_name: 'GDP(亿元)', dt_name: '2024', dt: '2024' },
        ],
      });
      const res = await tools.get('cnbs_compare')!({ keyword: 'GDP', regions: ['北京'], compareType: 'region' });
      expect(res.structuredContent).toMatchObject({ compareType: 'region' });
      expect(res.structuredContent).toHaveProperty('comparison');
    });

    it('groups a time comparison', async () => {
      client.findItems.mockResolvedValue({
        data: [
          { value: '100', show_name: 'GDP(亿元)', dt: '2024', dt_name: '2024', da_name: '全国' },
        ],
      });
      const res = await tools.get('cnbs_compare')!({ keyword: 'GDP', compareType: 'time', years: ['2024'] });
      expect(res.structuredContent).toMatchObject({ compareType: 'time' });
    });

    it('returns a message when no data is found', async () => {
      client.findItems.mockResolvedValue({ data: [] });
      const res = await tools.get('cnbs_compare')!({ keyword: 'zzz', compareType: 'region', regions: ['北京'] });
      expect(res.content[0].text).toContain('未找到');
      expect(res.structuredContent).toEqual({
        keyword: 'zzz',
        compareType: 'region',
        comparison: {},
        summary: [],
        hint: '未找到关键词 "zzz" 的数据',
      });
    });

    it('returns structured content when compare dimensions are missing', async () => {
      client.findItems.mockResolvedValue({ data: [{ value: '100', show_name: 'GDP(亿元)', dt: '2024' }] });
      const res = await tools.get('cnbs_compare')!({ keyword: 'GDP', compareType: 'region' });
      expect(res.structuredContent).toEqual({
        keyword: 'GDP',
        compareType: 'region',
        comparison: {},
        summary: [],
        hint: '请指定 regions 参数（地区对比）或 years 参数（时间对比）',
      });
    });

    it('returns a tool error on failure', async () => {
      client.findItems.mockRejectedValue(new Error('down'));
      const res = await tools.get('cnbs_compare')!({ keyword: 'GDP', compareType: 'region', regions: ['北京'] });
      expect(res.isError).toBe(true);
    });
  });
});
