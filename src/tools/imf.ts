import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { imfSource } from '../services/data-sources/index.js';
import { createToolErrorResult, createUnionResults, zUnionResultsOutputSchema, zUnknownObject } from './common.js';
import { zStrId } from './common.js';

export function registerImfTools(server: McpServer) {


  // ─── 外部数据源：IMF ────────────────────────────────────────────
  server.registerTool(
    'ext_imf',
    {
      title: 'IMF DataMapper Query',
      description: `查询 IMF 世界经济展望 (WEO) 数据。支持 GDP 增速、通胀、失业率、经常账户、政府债务等。支持同时查询多个指标。完全免费，无需认证。

Args:
  - indicators (string | string[]): 单个或多个指标名/IMF代码，如 "GDP_GROWTH" 或 ["GDP_GROWTH","CPI_INFLATION","GOVT_DEBT"]
  - countries (string[]): ISO 代码数组，如 ["CHN","USA","JPN"]；默认 ["CHN"]
  - periods (string[]): 年份数组，如 ["2020","2021","2022","2023"]；不传则返回全部

常用指标: GDP_GROWTH | GDP_USD | GDP_PER_CAPITA | CPI_INFLATION | UNEMPLOYMENT | CURRENT_ACCOUNT | GOVT_DEBT | GOVT_BALANCE | GROSS_SAVINGS | INVESTMENT | POPULATION
`,
      inputSchema: z.object({
        indicators: z.union([z.string(), z.array(z.string())]).describe('单个或多个指标名，如 "GDP_GROWTH" 或 ["GDP_GROWTH","CPI_INFLATION"]'),
        countries: z.array(z.string()).optional().default(['CHN']).describe('ISO 代码数组，如 ["CHN","USA"]'),
        periods: z.array(zStrId).optional().describe('年份数组，如 ["2020","2021","2022"]'),
      }).strict(),
      outputSchema: zUnionResultsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const indicatorList = Array.isArray(args.indicators) ? args.indicators : [args.indicators];
        if (indicatorList.length === 1) {
          const result = await imfSource.fetchData({ indicator: indicatorList[0], countries: args.countries, periods: args.periods });
          const structuredContent = { results: [{ key: indicatorList[0], data: result }], count: 1 };
          return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
        }
        const settled = await Promise.allSettled(
          indicatorList.map((ind) => imfSource.fetchData({ indicator: ind, countries: args.countries, periods: args.periods }))
        );
        const structuredContent = createUnionResults(indicatorList, settled);
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
      } catch (error) {
        return createToolErrorResult('ext_imf', error);
      }
    }
  );


  server.registerTool(
    'ext_imf_indicators',
    {
      title: 'List IMF Indicators',
      description: '列出 IMF DataMapper 支持的所有预置指标。',
      inputSchema: z.object({
        keyword: z.string().optional().describe('按关键词过滤'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = args.keyword
          ? await imfSource.search(args.keyword)
          : { indicators: await imfSource.getCategories() };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_imf_indicators', error);
      }
    }
  );


  server.registerTool(
    'ext_imf_all_indicators',
    {
      title: 'IMF All WEO Indicators',
      description: '获取 IMF DataMapper 完整指标目录（直接调用 IMF API）。',
      inputSchema: z.object({}).strict(),
      outputSchema: zUnknownObject,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const result = await imfSource.listAllIndicators();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        };
      } catch (error) {
        return createToolErrorResult('ext_imf_all_indicators', error);
      }
    }
  );
}
