// src/services/data-sources/helpers.ts
// Shared helper for keyword-based indicator filtering across data sources.

import type { SearchResult } from '../../types/api-responses.js';

/**
 * Filter a static record of indicators by keyword match.
 * Matches against the entry key, `name` field, and any additional searchable fields.
 */
export function filterIndicators<V extends { name: string }>(
  entries: Record<string, V>,
  keyword: string,
  source: string,
  mapFn: (key: string, value: V) => Record<string, unknown>,
  searchFields: Array<keyof V> = ['name'],
): SearchResult {
  const kw = keyword.toLowerCase();
  const matches = Object.entries(entries)
    .filter(([k, v]) =>
      k.toLowerCase().includes(kw) ||
      searchFields.some((field) => {
        const val = v[field];
        return typeof val === 'string' && val.toLowerCase().includes(kw);
      }),
    )
    .map(([key, val]) => mapFn(key, val));
  return { keyword, source, results: matches };
}
