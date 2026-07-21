// src/services/data-sources/sdmx-parser.ts
// SDMX-JSON generic parser (used by BIS and OECD data sources).

export interface SDMXDataPoint {
  period: string;
  value: number | null;
  dimensions: Record<string, string>;
}

export function parseSdmxJson(data: any): SDMXDataPoint[] {
  const result: SDMXDataPoint[] = [];

  try {
    // Unwrap SDMX-JSON 2.0 envelope: { meta, data: { dataSets, structure|structures } }
    // If top-level lacks dataSets/structure/structures but has a `data` sub-object, descend into it.
    const root = (data && (data.dataSets || data.DataSets || data.structure || data.Structure || data.structures))
      ? data
      : (data?.data ?? data);

    // Support plural `structures` array (OECD 2.0 format)
    const structure = root.structure || root.Structure
      || (Array.isArray(root.structures) ? root.structures[0] : undefined);
    const dataSet = (root.dataSets || root.DataSets)?.[0];
    if (!structure || !dataSet) return result;

    const obsDims: any[] = structure.dimensions?.observation || [];
    const timeDim = obsDims.find((d: any) => d.id === 'TIME_PERIOD');
    const timePeriods: any[] = timeDim?.values || [];

    const seriesDims: any[] = structure.dimensions?.series || [];
    const series = dataSet.series || {};

    for (const [seriesKey, seriesData] of Object.entries(series) as [string, any][]) {
      const keyParts = seriesKey.split(':').map(Number);
      const dimensions: Record<string, string> = {};

      seriesDims.forEach((dim: any, i: number) => {
        const val = dim.values?.[keyParts[i]];
        dimensions[dim.id] = val?.name || val?.id || '';
      });

      const observations = seriesData.observations || {};
      for (const [obsIndex, obsValues] of Object.entries(observations) as [string, any][]) {
        const period = timePeriods[Number(obsIndex)]?.id || timePeriods[Number(obsIndex)] || '';
        const rawVal = Array.isArray(obsValues) ? obsValues[0] : obsValues;
        result.push({
          period,
          value: rawVal !== null && rawVal !== undefined && rawVal !== '' ? Number(rawVal) : null,
          dimensions,
        });
      }
    }
  } catch {
    // Parse failure returns empty array
  }

  return result.sort((a, b) => String(a.period).localeCompare(String(b.period)));
}
