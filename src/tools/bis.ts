import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { bisSource } from '../services/data-sources/index.js';
import { createToolErrorResult, createUnionResults, zUnionResultsOutputSchema } from './common.js';

export function registerBisTools(server: McpServer) {


  // ─── 外部数据源：BIS ────────────────────────────────────────────
  server.registerTool(
    'ext_bis',
    {
      title: 'BIS Statistics Query',
      description: `查询国际清算银行 (BIS) 统计数据。涵盖有效汇率、信贷缺口、住宅房价、债务偿还比率等金融稳定指标。支持同时查询多个国家。完全免费，无需认证。

Args:
  - dataset (string): 数据集名，如 "EER"（有效汇率）、"CREDIT_GAP"（信贷缺口）、"PROPERTY_PRICES"（房价）
  - countries (string | string[]): 单个或多个 ISO2 代码，如 "CN" 或 ["CN","US","DE"]；默认 "CN"
  - key (string): 覆盖默认键模板（高级用法，单国）
  - lastNObservations (number): 最近 N 期，默认 20
  - startPeriod (string): 起始期间，如 "2015-Q1" 或 "2015-01"

预置数据集: EER | CREDIT_GAP | TOTAL_CREDIT | PROPERTY_PRICES | DEBT_SERVICE | CROSS_BORDER_BANKING
`,
      inputSchema: z.object({
        dataset: z.string().describe('数据集: EER | CREDIT_GAP | TOTAL_CREDIT | PROPERTY_PRICES | DEBT_SERVICE | CROSS_BORDER_BANKING'),
        countries: z.union([z.string(), z.array(z.string())]).optional().default('CN').describe('单个或多个 ISO2 代码，如 "CN" 或 ["CN","US","DE"]'),
        key: z.string().optional().describe('覆盖默认键模板（高级用法，单国）'),
        lastNObservations: z.number().optional().default(20).describe('最近 N 期数据'),
        startPeriod: z.string().optional().describe('起始期间，如 "2015-Q1" 或 "2015-01"'),
      }).strict(),
      outputSchema: zUnionResultsOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const countryList = Array.isArray(args.countries) ? args.countries : [args.countries ?? 'CN'];
        const params = { dataset: args.dataset, key: args.key, lastNObservations: args.lastNObservations, startPeriod: args.startPeriod };
        if (countryList.length === 1) {
          const result = await bisSource.fetchData({ ...params, country: countryList[0] });
          const structuredContent = { results: [{ key: countryList[0], data: result }], count: 1 };
          return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
        }
        const settled = await Promise.allSettled(countryList.map((c) => bisSource.fetchData({ ...params, country: c })));
        const structuredContent = createUnionResults(countryList, settled);
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
      } catch (error) {
        return createToolErrorResult('ext_bis', error);
      }
    }
  );


  server.registerTool(
    'ext_bis_datasets',
    {
      title: 'List BIS Datasets',
      description: '列出 BIS 数据源支持的所有预置数据集及键模板。',
      inputSchema: z.object({
        keyword: z.string().optional().describe('按关键词过滤'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = args.keyword
          ? await bisSource.search(args.keyword)
          : { datasets: await bisSource.getCategories() };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_bis_datasets', error);
      }
    }
  );
}
