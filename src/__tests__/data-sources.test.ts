import { filterIndicators } from '../services/data-sources/helpers';
import { WorldBankDataSource } from '../services/data-sources/world-bank';
import { IMFDataSource } from '../services/data-sources/imf';
import { OECDDataSource } from '../services/data-sources/oecd';
import { BISDataSource } from '../services/data-sources/bis';

describe('filterIndicators helper', () => {
  const testData: Record<string, { name: string; id: string }> = {
    GDP: { name: 'Gross Domestic Product', id: 'gdp_001' },
    CPI: { name: 'Consumer Price Index', id: 'cpi_001' },
    UNEMPLOYMENT: { name: 'Unemployment Rate', id: 'unemp_001' },
  };

  it('should match by key', () => {
    const result = filterIndicators(testData, 'gdp', 'test', (k, v) => ({ id: k, name: v.name }));
    expect(result.results).toHaveLength(1);
    expect((result.results as any[])[0].id).toBe('GDP');
  });

  it('should match by name field', () => {
    const result = filterIndicators(testData, 'consumer', 'test', (k, v) => ({ id: k, name: v.name }), ['name']);
    expect(result.results).toHaveLength(1);
    expect((result.results as any[])[0].id).toBe('CPI');
  });

  it('should match by additional search fields', () => {
    const result = filterIndicators(testData, 'gdp_001', 'test', (k, v) => ({ id: k, name: v.name }), ['name', 'id']);
    expect(result.results).toHaveLength(1);
    expect((result.results as any[])[0].id).toBe('GDP');
  });

  it('should be case-insensitive', () => {
    const result = filterIndicators(testData, 'GDP', 'test', (k, v) => ({ id: k, name: v.name }));
    expect(result.results).toHaveLength(1);
  });

  it('should return empty results for no match', () => {
    const result = filterIndicators(testData, 'nonexistent', 'test', (k, v) => ({ id: k, name: v.name }));
    expect(result.results).toHaveLength(0);
  });

  it('should include keyword and source in result', () => {
    const result = filterIndicators(testData, 'gdp', 'my_source', (k) => ({ id: k }));
    expect(result.keyword).toBe('gdp');
    expect(result.source).toBe('my_source');
  });
});

describe('WorldBankDataSource', () => {
  const wb = new WorldBankDataSource();

  describe('search', () => {
    it('should find GDP indicator', async () => {
      const result = await wb.search('GDP');
      expect(result.source).toBe('world_bank');
      expect((result.results as any[]).length).toBeGreaterThan(0);
    });

    it('should return empty for unknown keyword', async () => {
      const result = await wb.search('zzzznonexistent');
      expect(result.results).toHaveLength(0);
    });
  });

  describe('getCategories', () => {
    it('should return all indicators as categories', async () => {
      const categories = await wb.getCategories();
      expect(categories.length).toBeGreaterThan(10);
      expect(categories[0]).toHaveProperty('id');
      expect(categories[0]).toHaveProperty('name');
    });
  });
});

describe('IMFDataSource', () => {
  const imf = new IMFDataSource();

  describe('search', () => {
    it('should find GDP indicators', async () => {
      const result = await imf.search('GDP');
      expect(result.source).toBe('imf');
      expect((result.results as any[]).length).toBeGreaterThan(0);
    });
  });

  describe('getCategories', () => {
    it('should return all indicators', async () => {
      const categories = await imf.getCategories();
      expect(categories.length).toBeGreaterThan(5);
    });
  });
});

describe('OECDDataSource', () => {
  const oecd = new OECDDataSource();

  describe('search', () => {
    it('should find datasets by keyword', async () => {
      const result = await oecd.search('GDP');
      expect(result.source).toBe('oecd');
      expect((result.results as any[]).length).toBeGreaterThan(0);
    });
  });

  describe('getCategories', () => {
    it('should return all datasets', async () => {
      const categories = await oecd.getCategories();
      expect(categories.length).toBeGreaterThan(0);
    });
  });
});

describe('BISDataSource', () => {
  const bis = new BISDataSource();

  describe('search', () => {
    it('should find datasets by keyword', async () => {
      const result = await bis.search('EER');
      expect(result.source).toBe('bis');
      expect((result.results as any[]).length).toBeGreaterThan(0);
    });
  });

  describe('getCategories', () => {
    it('should return all datasets', async () => {
      const categories = await bis.getCategories();
      expect(categories.length).toBeGreaterThan(0);
    });
  });
});
