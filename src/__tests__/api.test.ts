// 模拟 axios 模块
import { CnbsModernClient } from '../services/api.js';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(() => false)
}));

import axios from 'axios';

const mockAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;
const mockAxiosPost = axios.post as jest.MockedFunction<typeof axios.post>;

describe('CnbsModernClient', () => {
  let client: CnbsModernClient;

  beforeEach(async () => {
    client = new CnbsModernClient();
    await client.flushAllCaches();
    mockAxiosGet.mockClear();
    mockAxiosPost.mockClear();
  });

  describe('findItems', () => {
    it('should return search results', async () => {
      const mockResponse = {
        data: {
          data: [
            {
              id: '1',
              name: 'GDP',
              value: '123456'
            }
          ]
        }
      };

      mockAxiosGet.mockResolvedValue(mockResponse);

      const result = await client.findItems({ keyword: 'GDP' });

      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('query'),
        expect.any(Object)
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should handle errors', async () => {
      mockAxiosGet.mockRejectedValue(new Error('API error'));

      await expect(client.findItems({ keyword: 'GDP' })).rejects.toThrow('API error');
    });

    it('should flatten the live NBS nested response shape', async () => {
      // Live API wraps results as { data: { types, data: [...], count } }
      const mockResponse = {
        data: {
          data: {
            types: [{ name: '年度数据', code: '3', dtType: 'YY' }],
            count: 2,
            data: [
              { show_name: '医疗卫生机构诊疗人次数', cid: 'a1', dt: '2024' },
              { show_name: '门诊部诊疗人次数', cid: 'a2', dt: '2024' },
            ],
          },
        },
      };

      mockAxiosGet.mockResolvedValue(mockResponse);

      const result = await client.findItems({ keyword: '总诊疗人数' });

      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data?.[0].show_name).toBe('医疗卫生机构诊疗人次数');
      expect(result.total).toBe(2);
    });
  });

  describe('fetchNodes', () => {
    it('should return node data', async () => {
      const mockResponse = {
        data: {
          data: [
            {
              _id: '1',
              name: 'GDP',
              isLeaf: true
            }
          ]
        }
      };

      mockAxiosGet.mockResolvedValue(mockResponse);

      const result = await client.fetchNodes({ category: '3' });

      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('queryIndexTreeAsync'),
        expect.any(Object)
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should handle errors', async () => {
      mockAxiosGet.mockRejectedValue(new Error('API error'));

      await expect(client.fetchNodes({ category: '3' })).rejects.toThrow('API error');
    });
  });

  describe('fetchMetrics', () => {
    it('should return metric data', async () => {
      const mockResponse = {
        data: {
          data: [
            {
              id: '1',
              name: 'GDP'
            }
          ]
        }
      };

      mockAxiosGet.mockResolvedValue(mockResponse);

      const result = await client.fetchMetrics({ setId: '1' });

      expect(mockAxiosGet).toHaveBeenCalledWith(
        expect.stringContaining('queryIndicatorsByCid'),
        expect.any(Object)
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should handle errors', async () => {
      mockAxiosGet.mockRejectedValue(new Error('API error'));

      await expect(client.fetchMetrics({ setId: '1' })).rejects.toThrow('API error');
    });
  });

  describe('fetchSeries', () => {
    it('should return series data', async () => {
      const mockResponse = {
        data: {
          data: [
            {
              value: '123456',
              period: '2024'
            }
          ]
        }
      };

      mockAxiosPost.mockResolvedValue(mockResponse);

      const result = await client.fetchSeries({
        setId: '1',
        metricIds: ['1'],
        periods: ['2024'],
        areas: [{ text: '全国', code: '000000000000' }]
      });

      expect(mockAxiosPost).toHaveBeenCalledWith(
        expect.stringContaining('stream/esData'),
        expect.objectContaining({
          das: [{ text: '全国', value: '000000000000' }],
          daCatalogId: '',
        }),
        expect.any(Object)
      );
      expect(result).toEqual(mockResponse.data);
    });

    it('should handle errors', async () => {
      mockAxiosPost.mockRejectedValue(new Error('API error'));

      await expect(client.fetchSeries({
        setId: '1',
        metricIds: ['1'],
        periods: ['2024'],
        areas: [{ text: '全国', code: '000000000000' }]
      })).rejects.toThrow('API error');
    });
  });

  describe('batchFindItems', () => {
    it('should return batch search results', async () => {
      const mockResponse1 = {
        data: {
          data: [
            {
              id: '1',
              name: 'GDP',
              value: '123456'
            }
          ]
        }
      };

      const mockResponse2 = {
        data: {
          data: [
            {
              id: '2',
              name: 'CPI',
              value: '105'
            }
          ]
        }
      };

      mockAxiosGet.mockResolvedValueOnce(mockResponse1).mockResolvedValueOnce(mockResponse2);

      const result = await client.batchFindItems(['GDP', 'CPI']);

      expect(mockAxiosGet).toHaveBeenCalledTimes(2);
      expect(result).toHaveProperty('GDP');
      expect(result).toHaveProperty('CPI');
    });
  });

  describe('getCacheStats', () => {
    it('should return cache statistics', async () => {
      const stats = await client.getCacheStats();
      expect(stats).toHaveProperty('node');
      expect(stats).toHaveProperty('metric');
      expect(stats).toHaveProperty('series');
    });
  });

  describe('findAndFetch', () => {
    it('selects dataset by relevance over pure dt recency', async () => {
      // Search returns two items: one with higher dt but lower relevance,
      // one with lower dt but higher relevance to keyword "诊疗人次"
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            data: [
              { show_name: '医疗卫生机构数', cid: 'cid_a', dt: '202501', dt_type: 'MM' },
              { show_name: '诊疗人次数', cid: 'cid_b', dt: '202401', dt_type: 'MM' },
            ],
          },
        })
        // fetchMetrics for cid_b (the relevant one)
        .mockResolvedValueOnce({
          data: { data: { list: [{ _id: 'm1', i_showname: '诊疗人次数' }] } },
        });

      mockAxiosPost.mockResolvedValueOnce({
        data: { data: [{ code: '00', values: [{ _id: 'v1', i_showname: 'x', value: '123' }] }] },
      });

      const result = await client.findAndFetch('诊疗人次');
      expect(result.setId).toBe('cid_b');
      // Two distinct cids → candidates + ambiguity warning expected
      expect(result.candidates).toBeDefined();
      expect(result.candidates!.length).toBe(2);
      expect(result.warning).toContain('命中多个数据集');
    });

    it('triggers single fallback when first metric is all empty, produces warning if still empty', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: { data: [{ show_name: 'GDP当季值', cid: 'cid_gdp', dt: '202401', dt_type: 'Q' }] },
        })
        .mockResolvedValueOnce({
          data: {
            data: {
              list: [
                { _id: 'm_empty', i_showname: 'GDP存量' },
                { _id: 'm_good', i_showname: 'GDP当季同比' },
              ],
            },
          },
        });

      // First fetchSeries: all empty
      mockAxiosPost
        .mockResolvedValueOnce({
          data: { data: [{ code: '00', values: [{ _id: 'v1', i_showname: 'x', value: '' }] }] },
        })
        // Fallback fetchSeries: has data
        .mockResolvedValueOnce({
          data: { data: [{ code: '00', values: [{ _id: 'v2', i_showname: 'y', value: '5.2' }] }] },
        });

      const result = await client.findAndFetch('GDP');
      // Should have used the fallback metric
      expect(result.metric._id).toBe('m_good');
      expect(result.series.data![0].values[0].value).toBe('5.2');
      expect(result.warning).toBeUndefined();
    });

    it('produces warning when fallback also returns empty', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: { data: [{ show_name: '某指标', cid: 'cid_x', dt: '202401', dt_type: 'MM' }] },
        })
        .mockResolvedValueOnce({
          data: {
            data: {
              list: [
                { _id: 'm1', i_showname: '指标A' },
                { _id: 'm2', i_showname: '指标B' },
              ],
            },
          },
        });

      // Both fetchSeries calls return empty
      mockAxiosPost
        .mockResolvedValueOnce({ data: { data: [] } })
        .mockResolvedValueOnce({ data: { data: [] } });

      const result = await client.findAndFetch('某指标');
      expect(result.warning).toContain('建议改用更具体的关键词');
    });

    it('produces candidates when multiple distinct cids are found', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            data: [
              { show_name: '医疗收入', cid: 'cid_1', dt: '202401', dt_type: 'MM' },
              { show_name: '医疗机构数', cid: 'cid_2', dt: '2024', dt_type: 'YY' },
              { show_name: '医疗支出', cid: 'cid_3', dt: '202401', dt_type: 'MM' },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: { data: { list: [{ _id: 'm1', i_showname: '医疗收入' }] } },
        });

      mockAxiosPost.mockResolvedValueOnce({
        data: { data: [{ code: '00', values: [{ _id: 'v1', i_showname: 'x', value: '999' }] }] },
      });

      const result = await client.findAndFetch('医疗');
      expect(result.candidates).toBeDefined();
      expect(result.candidates!.length).toBe(3);
      expect(result.candidates![0]).toHaveProperty('granularity');
      expect(result.warning).toContain('命中多个数据集');
    });

    it('does not produce candidates for single cid results', async () => {
      mockAxiosGet
        .mockResolvedValueOnce({
          data: {
            data: [
              { show_name: 'CPI当月同比', cid: 'cid_cpi', dt: '202401', dt_type: 'MM' },
              { show_name: 'CPI累计同比', cid: 'cid_cpi', dt: '202401', dt_type: 'MM' },
            ],
          },
        })
        .mockResolvedValueOnce({
          data: { data: { list: [{ _id: 'm1', i_showname: 'CPI当月同比' }] } },
        });

      mockAxiosPost.mockResolvedValueOnce({
        data: { data: [{ code: '00', values: [{ _id: 'v1', i_showname: 'x', value: '0.3' }] }] },
      });

      const result = await client.findAndFetch('CPI');
      expect(result.candidates).toBeUndefined();
      expect(result.warning).toBeUndefined();
    });
  });
});
