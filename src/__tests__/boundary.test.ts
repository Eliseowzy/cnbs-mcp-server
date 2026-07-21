import { safePropertyAccess, validateParams } from '../services/boundary';

describe('safePropertyAccess', () => {
  const obj = {
    a: { b: { c: 42 } },
    list: [1, 2, 3],
    zero: 0,
    empty: '',
    flag: false,
  };

  it('resolves a deep nested path', () => {
    expect(safePropertyAccess(obj, 'a.b.c', -1)).toBe(42);
  });

  it('returns default when an intermediate segment is missing', () => {
    expect(safePropertyAccess(obj, 'a.x.c', 'fallback')).toBe('fallback');
  });

  it('returns default when the root is null/undefined', () => {
    expect(safePropertyAccess(null, 'a.b', 'd')).toBe('d');
    expect(safePropertyAccess(undefined, 'a.b', 'd')).toBe('d');
  });

  it('returns default when the root is a primitive', () => {
    expect(safePropertyAccess('a string', 'length', 0)).toBe(0);
  });

  it('preserves falsy leaf values (0, "", false)', () => {
    expect(safePropertyAccess(obj, 'zero', -1)).toBe(0);
    expect(safePropertyAccess(obj, 'empty', 'x')).toBe('');
    expect(safePropertyAccess(obj, 'flag', true)).toBe(false);
  });

  it('accesses a single-level property', () => {
    expect(safePropertyAccess(obj, 'list', [])).toEqual([1, 2, 3]);
  });
});

describe('validateParams', () => {
  it('reports valid when all required fields are present', () => {
    const result = validateParams({ a: 1, b: 'x' }, ['a', 'b']);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports missing fields (null/undefined)', () => {
    const result = validateParams({ a: 1, b: null, c: undefined }, ['a', 'b', 'c', 'd']);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(['b', 'c', 'd']);
  });

  it('treats falsy-but-present values as valid', () => {
    const result = validateParams({ a: 0, b: '', c: false }, ['a', 'b', 'c']);
    expect(result.valid).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
