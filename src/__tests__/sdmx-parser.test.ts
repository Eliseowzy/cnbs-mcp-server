import { parseSdmxJson } from '../services/data-sources/sdmx-parser';

// Minimal SDMX-JSON fixture with two observations across one series.
const sdmxFixture = {
  structure: {
    dimensions: {
      observation: [
        { id: 'TIME_PERIOD', values: [{ id: '2023' }, { id: '2024' }] },
      ],
      series: [
        { id: 'REF_AREA', values: [{ id: 'CN', name: 'China' }] },
        { id: 'MEASURE', values: [{ id: 'GDP', name: 'Gross Domestic Product' }] },
      ],
    },
  },
  dataSets: [
    {
      series: {
        '0:0': {
          observations: {
            '0': [1.5],
            '1': [2.5],
          },
        },
      },
    },
  ],
};

describe('parseSdmxJson', () => {
  it('parses observations into typed data points', () => {
    const points = parseSdmxJson(sdmxFixture);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      period: '2023',
      value: 1.5,
      dimensions: { REF_AREA: 'China', MEASURE: 'Gross Domestic Product' },
    });
    expect(points[1].period).toBe('2024');
    expect(points[1].value).toBe(2.5);
  });

  it('sorts results by period ascending', () => {
    const points = parseSdmxJson(sdmxFixture);
    expect(points.map(p => p.period)).toEqual(['2023', '2024']);
  });

  it('maps empty/null observation values to null', () => {
    const fixture = {
      ...sdmxFixture,
      dataSets: [{ series: { '0:0': { observations: { '0': [''], '1': [null] } } } }],
    };
    const points = parseSdmxJson(fixture);
    expect(points[0].value).toBeNull();
    expect(points[1].value).toBeNull();
  });

  it('returns empty array when structure or dataSet is missing', () => {
    expect(parseSdmxJson({})).toEqual([]);
    expect(parseSdmxJson({ structure: {} })).toEqual([]);
  });

  it('returns empty array on malformed input without throwing', () => {
    expect(parseSdmxJson(null)).toEqual([]);
    expect(parseSdmxJson(undefined)).toEqual([]);
    expect(parseSdmxJson('not-an-object')).toEqual([]);
  });

  it('supports capitalized Structure/DataSets keys', () => {
    const fixture = {
      Structure: sdmxFixture.structure,
      DataSets: sdmxFixture.dataSets,
    };
    const points = parseSdmxJson(fixture);
    expect(points).toHaveLength(2);
  });

  it('unwraps SDMX-JSON 2.0 envelope (BIS shape: data.structure)', () => {
    const fixture = {
      meta: { id: 'test' },
      data: {
        structure: {
          dimensions: {
            observation: [
              { id: 'TIME_PERIOD', values: [{ id: '2023-01' }, { id: '2023-02' }] },
            ],
            series: [
              { id: 'FREQ', values: [{ id: 'M', name: 'Monthly' }] },
              { id: 'EER_TYPE', values: [{ id: 'N', name: 'Nominal' }] },
              { id: 'EER_BASKET', values: [{ id: 'B', name: 'Broad' }] },
              { id: 'REF_AREA', values: [{ id: 'CN', name: 'China' }] },
            ],
          },
        },
        dataSets: [
          {
            series: {
              '0:0:0:0': {
                observations: {
                  '0': [111.34],
                  '1': [111.83],
                },
              },
            },
          },
        ],
      },
    };
    const points = parseSdmxJson(fixture);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      period: '2023-01',
      value: 111.34,
      dimensions: { FREQ: 'Monthly', EER_TYPE: 'Nominal', EER_BASKET: 'Broad', REF_AREA: 'China' },
    });
    expect(points[1].value).toBe(111.83);
  });

  it('unwraps SDMX-JSON 2.0 envelope (OECD shape: data.structures array)', () => {
    const fixture = {
      meta: { id: 'test-oecd' },
      data: {
        structures: [
          {
            dimensions: {
              observation: [
                { id: 'TIME_PERIOD', values: [{ id: '2024-Q1' }, { id: '2024-Q2' }] },
              ],
              series: [
                { id: 'REF_AREA', values: [{ id: 'CHN', name: 'China' }] },
                { id: 'MEASURE', values: [{ id: 'CPI', name: 'Consumer Price Index' }] },
              ],
            },
          },
        ],
        dataSets: [
          {
            series: {
              '0:0': {
                observations: {
                  '0': [102.5],
                  '1': [103.1],
                },
              },
            },
          },
        ],
      },
    };
    const points = parseSdmxJson(fixture);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      period: '2024-Q1',
      value: 102.5,
      dimensions: { REF_AREA: 'China', MEASURE: 'Consumer Price Index' },
    });
    expect(points[1].period).toBe('2024-Q2');
    expect(points[1].value).toBe(103.1);
  });
});
