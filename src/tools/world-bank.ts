import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { worldBankSource } from '../services/data-sources/index.js';
import { createToolErrorResult } from './common.js';

export function registerWorldBankTools(server: McpServer) {


  // ─── 外部数据源：世界银行 ───────────────────────────────────────
  server.registerTool(
    'ext_world_bank',
    {
      title: 'World Bank Open Data',
      description: `查询世界银行开放数据。支持 GDP、CPI、贸易、人口、失业率等全球 200+ 国家数据。完全免费，无需认证。

Args:
  - indicator (string): 指标名（如 "GDP"、"CPI"、"UNEMPLOYMENT"）或 WB 指标代码（如 "NY.GDP.MKTP.CD"）
  - countries (string[]): ISO3 国家代码数组，如 ["CHN","USA","JPN"]；默认 ["CHN"]
  - startYear (number): 起始年份，默认 2000
  - endYear (number): 结束年份，默认当前年

常用指标: GDP | GDP_GROWTH | GDP_PER_CAPITA | CPI | UNEMPLOYMENT | POPULATION | EXPORTS | IMPORTS | FDI_INFLOWS | GOVT_DEBT | GINI | LIFE_EXPECTANCY | CO2_EMISSIONS | CURRENT_ACCOUNT
`,
      inputSchema: z.object({
        indicator: z.string().describe('指标名如 "GDP" 或 WB 代码如 "NY.GDP.MKTP.CD"'),
        countries: z.array(z.string()).optional().default(['CHN']).describe('ISO3 代码数组，如 ["CHN","USA"]'),
        startYear: z.number().optional().default(2000).describe('起始年份'),
        endYear: z.number().optional().describe('结束年份，默认当前年'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await worldBankSource.fetchData({
          indicator: args.indicator,
          countries: args.countries,
          startYear: args.startYear,
          endYear: args.endYear,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_world_bank', error);
      }
    }
  );


  server.registerTool(
    'ext_world_bank_multi',
    {
      title: 'World Bank Multi-Indicator Query',
      description: `同时查询世界银行多个指标，跨国对比。

Args:
  - indicators (string[]): 指标数组，如 ["GDP_GROWTH","CPI","UNEMPLOYMENT"]
  - countries (string[]): ISO3 代码数组，如 ["CHN","USA","DEU"]
  - startYear (number): 起始年份
  - endYear (number): 结束年份
`,
      inputSchema: z.object({
        indicators: z.array(z.string()).describe('指标数组'),
        countries: z.array(z.string()).optional().default(['CHN']).describe('ISO3 代码数组'),
        startYear: z.number().optional().default(2015).describe('起始年份'),
        endYear: z.number().optional().describe('结束年份'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await worldBankSource.fetchMulti({
          indicators: args.indicators,
          countries: args.countries,
          startYear: args.startYear,
          endYear: args.endYear,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_world_bank_multi', error);
      }
    }
  );


  server.registerTool(
    'ext_world_bank_indicators',
    {
      title: 'List World Bank Indicators',
      description: '列出世界银行数据源支持的所有预置指标及其代码和说明。',
      inputSchema: z.object({
        keyword: z.string().optional().describe('按关键词过滤'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = args.keyword
          ? await worldBankSource.search(args.keyword)
          : { indicators: await worldBankSource.getCategories() };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_world_bank_indicators', error);
      }
    }
  );
}
