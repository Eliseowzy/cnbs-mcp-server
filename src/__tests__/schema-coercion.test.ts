import { zStrId } from '../tools/index.js';
import { registerCnbsTools } from '../tools/index.js';

describe('numeric ID coercion', () => {
  it('accepts string and numeric identifiers', () => {
    expect(zStrId.parse('601020100002')).toBe('601020100002');
    expect(zStrId.parse(601020100002)).toBe('601020100002');
  });

  it('coerces numeric identifiers in real tool schemas', () => {
    const tools = new Map<string, any>();
    const server = {
      registerTool(name: string, config: any) {
        tools.set(name, config);
      },
    };
    registerCnbsTools(server as any);

    expect(tools.get('cnbs_fetch_nodes').inputSchema.parse({
      categories: 3,
      parentId: 601020100002,
    })).toEqual({ categories: '3', parentId: '601020100002' });
    expect(tools.get('cnbs_fetch_end_nodes').inputSchema.parse({ category: 3 }))
      .toEqual({ category: '3' });
    expect(tools.get('cnbs_fetch_series').inputSchema.parse({
      setId: 6331,
      metricIds: [8060],
      periods: [2024],
    })).toMatchObject({ setId: '6331', metricIds: ['8060'], periods: ['2024'] });
  });
});
