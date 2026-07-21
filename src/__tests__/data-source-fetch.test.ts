jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(() => false),
}));

import axios from 'axios';
import { WorldBankDataSource } from '../services/data-sources/world-bank';
import { IMFDataSource } from '../services/data-sources/imf';

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
