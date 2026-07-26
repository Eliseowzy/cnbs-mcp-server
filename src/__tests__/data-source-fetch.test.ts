jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(() => false),
}));

import axios from 'axios';
import { WorldBankDataSource } from '../services/data-sources/world-bank';
import { IMFDataSource } from '../services/data-sources/imf';
import { DepartmentDataSource } from '../services/data-sources/department';
import { CnbsServiceError, CnbsErrorType } from '../services/error';

const mockGet = axios.get as jest.MockedFunction<typeof axios.get>;

describe('WorldBankDataSource.fetchData', () => {
  beforeEach(() => mockGet.mockReset());

  it('maps World Bank response into structured data points and drops nulls', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: [
        { total: 2, page: 1, lastupdated: '2024-01-01' },
        [
          { value: 100, country: { value: 'China', id: 'CN' }, countryiso3code: 'CHN', date: '2020' },
          { value: null, country: { value: 'China', id: 'CN' }, countryiso3code: 'CHN', date: '2019' },
          { value: 200, country: { value: 'China', id: 'CN' }, countryiso3code: 'CHN', date: '2021' },
        ],
      ],
    });

    const wb = new WorldBankDataSource();
    const result = await wb.fetchData({ indicator: 'GDP', countries: ['CHN'], startYear: 2019, endYear: 2021 });

    expect(result.source).toBe('world_bank');
    expect(result.indicator.id).toBe('NY.GDP.MKTP.CD');
    expect(result.data).toHaveLength(2); // null filtered out
    expect(result.data.map((d) => d.period)).toEqual(['2020', '2021']); // sorted
    expect(result.meta.lastUpdated).toBe('2024-01-01');
  });

  it('throws when World Bank returns empty data', async () => {
    mockGet.mockResolvedValue({ status: 200, data: [{ total: 0 }, null] });
    const wb = new WorldBankDataSource();
    await expect(
      wb.fetchData({ indicator: 'CPI', countries: ['USA'], startYear: 2000, endYear: 2001 }),
    ).rejects.toThrow('World Bank API returned empty data');
  });
});

describe('WorldBankDataSource.fetchMulti', () => {
  it('starts all indicator fetches in parallel and maps failures to {error}', async () => {
    const wb = new WorldBankDataSource();
    const deferred: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];
    jest.spyOn(wb, 'fetchData').mockImplementation(
      () => new Promise((resolve, reject) => { deferred.push({ resolve, reject }); }) as never,
    );

    const promise = wb.fetchMulti({ indicators: ['GDP', 'CPI', 'POPULATION'] });
    await Promise.resolve();

    // 串行实现下第二个 fetchData 要等第一个 resolve 才会发起；并行实现下三个已全部发起。
    expect(deferred).toHaveLength(3);

    deferred[0].resolve({ source: 'world_bank', indicator: 'GDP' });
    deferred[1].reject(new Error('upstream down'));
    deferred[2].resolve({ source: 'world_bank', indicator: 'POPULATION' });

    const results = await promise;
    expect(results.GDP).toMatchObject({ indicator: 'GDP' });
    expect(results.CPI).toEqual({ error: 'upstream down' });
    expect(results.POPULATION).toMatchObject({ indicator: 'POPULATION' });
  });
});

describe('DepartmentDataSource retry behaviour', () => {
  let setTimeoutSpy: jest.SpyInstance;

  beforeEach(() => {
    mockGet.mockReset();
    // 重试退避与节流间隔立即回调，避免测试真实等待。
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('search retries only inside findItems (3 attempts, not 9)', async () => {
    mockGet.mockImplementation(async () => {
      throw new CnbsServiceError({
        type: CnbsErrorType.NETWORK_ISSUE,
        message: 'network down',
        canRetry: true,
      });
    });

    const dept = new DepartmentDataSource();
    await expect(dept.search('不会命中缓存的关键词')).rejects.toThrow('network down');
    // findItems 内部重试 3 次；department 层不再叠加外层重试放大到 9 次。
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('fetchAllKeywordsForDepartment queries all keywords in parallel', async () => {
    const dept = new DepartmentDataSource();
    const deferred: Array<(v: unknown) => void> = [];
    jest
      .spyOn((dept as unknown as { nbsClient: { findItems: (...args: unknown[]) => Promise<unknown> } }).nbsClient, 'findItems')
      .mockImplementation(() => new Promise((resolve) => { deferred.push(resolve); }));

    const promise = dept.fetchAllKeywordsForDepartment('finance');
    await Promise.resolve();

    // finance 预设 5 个关键词，并行实现下应全部同时发起。
    expect(deferred).toHaveLength(5);

    deferred.forEach((resolve, i) => resolve({ data: [{ id: i }] }));
    const result = await promise;
    expect(Object.keys(result.results)).toHaveLength(5);
  });
});

describe('IMFDataSource.fetchData', () => {
  beforeEach(() => mockGet.mockReset());

  it('flattens IMF values map into data points', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { values: { NGDP_RPCH: { CHN: { '2022': 3.0, '2023': 5.2 } } } },
    });

    const imf = new IMFDataSource();
    const result = await imf.fetchData({ indicator: 'GDP_GROWTH', countries: ['CHN'] });

    expect(result.source).toBe('imf');
    expect(result.indicator.id).toBe('NGDP_RPCH');
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({ country: 'CHN', period: '2022', value: 3.0 });
  });

  it('filters by requested periods using a set', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { values: { PCPIPCH: { USA: { '2020': 1, '2021': 2, '2022': 3 } } } },
    });

    const imf = new IMFDataSource();
    const result = await imf.fetchData({ indicator: 'CPI_INFLATION', countries: ['USA'], periods: ['2021'] });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].period).toBe('2021');
  });
});
