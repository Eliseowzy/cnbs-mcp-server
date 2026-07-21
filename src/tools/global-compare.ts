import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { worldBankSource, imfSource } from '../services/data-sources/index.js';
import { createToolErrorResult } from './common.js';

export function registerGlobalCompareTools(server: McpServer) {


  // ─── 跨源对比工具 ───────────────────────────────────────────────
  server.registerTool(
    'ext_global_compare',
    {
      title: 'Global Economic Indicator Comparison',
      description: `同时从世界银行和 IMF 获取同一指标的多国数据，快速进行国际横向对比。

Args:
  - wbIndicator (string): 世界银行指标，如 "GDP_GROWTH"
  - imfIndicator (string): IMF 指标，如 "GDP_GROWTH"（可选；不填则只查 WB）
  - countries (string[]): ISO 代码，如 ["CHN","USA","DEU","JPN"]；默认 ["CHN","USA","DEU","JPN"]
  - startYear (number): 起始年份
`,
      inputSchema: z.object({
        wbIndicator: z.string().describe('世界银行指标名，如 "GDP_GROWTH"'),
        imfIndicator: z.string().optional().describe('IMF 指标名，如 "GDP_GROWTH"（不填则只查 WB）'),
        countries: z.array(z.string()).optional().default(['CHN', 'USA', 'DEU', 'JPN']).describe('ISO3 代码数组'),
        startYear: z.number().optional().default(2015).describe('起始年份'),
      }).strict(),
      outputSchema: {
        world_bank: z.union([z.object({}).passthrough(), z.null()]),
        imf: z.union([z.object({}).passthrough(), z.null()]),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const [wbResult, imfResult] = await Promise.allSettled([
          worldBankSource.fetchData({
            indicator: args.wbIndicator,
            countries: args.countries,
            startYear: args.startYear,
          }),
          args.imfIndicator
            ? imfSource.fetchData({ indicator: args.imfIndicator, countries: args.countries })
            : Promise.resolve(null),
        ]);

        const result = {
          world_bank: wbResult.status === 'fulfilled' ? wbResult.value : { error: (wbResult as PromiseRejectedResult).reason?.message },
          imf: imfResult.status === 'fulfilled' ? imfResult.value : { error: (imfResult as PromiseRejectedResult).reason?.message },
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_global_compare', error);
      }
    }
  );
}
