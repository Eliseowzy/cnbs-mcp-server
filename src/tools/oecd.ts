import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { oecdSource } from '../services/data-sources/index.js';
import { createToolErrorResult } from './common.js';

export function registerOecdTools(server: McpServer) {


  // ─── 外部数据源：OECD ───────────────────────────────────────────
  server.registerTool(
    'ext_oecd',
    {
      title: 'OECD SDMX Data Query',
      description: `查询 OECD 统计数据（SDMX-JSON）。支持季度GDP、就业、先行指标等。完全免费，无需认证。

Args:
  - dataset (string): 预置数据集名，如 "QNA_GDP"、"KEI_CPI"、"EMPLOYMENT"
  - key (string): SDMX 维度键，如 "Q.G20.B1GQ....V.N"（可选，默认 "all"，注意数据量可能较大）
  - agencyId (string): 自定义 agencyId，与 dataflowId 配合使用
  - dataflowId (string): 自定义 dataflowId
  - startPeriod (string): 起始期间，如 "2015-Q1" 或 "2015-01"
  - endPeriod (string): 结束期间
  - lastNObservations (number): 返回最近 N 期，默认 20

预置数据集: QNA_GDP | KEI_CPI | EMPLOYMENT | TRADE
`,
      inputSchema: z.object({
        dataset: z.string().describe('预置数据集: QNA_GDP | KEI_CPI | EMPLOYMENT | TRADE，或自定义 agencyId+dataflowId'),
        key: z.string().optional().describe('SDMX 维度键，默认 "all"'),
        agencyId: z.string().optional().describe('自定义 agencyId，与 dataflowId 配合使用'),
        dataflowId: z.string().optional().describe('自定义 dataflowId'),
        startPeriod: z.string().optional().describe('起始期间，如 "2015-Q1"'),
        endPeriod: z.string().optional().describe('结束期间'),
        lastNObservations: z.number().optional().default(20).describe('最近 N 期数据'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await oecdSource.fetchData({
          dataset: args.dataset,
          key: args.key,
          agencyId: args.agencyId,
          dataflowId: args.dataflowId,
          startPeriod: args.startPeriod,
          endPeriod: args.endPeriod,
          lastNObservations: args.lastNObservations,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_oecd', error);
      }
    }
  );


  server.registerTool(
    'ext_oecd_datasets',
    {
      title: 'List OECD Datasets',
      description: '列出 OECD 数据源支持的所有预置数据集。',
      inputSchema: z.object({
        keyword: z.string().optional().describe('按关键词过滤'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const result = args.keyword
          ? await oecdSource.search(args.keyword)
          : { datasets: await oecdSource.getCategories() };
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_oecd_datasets', error);
      }
    }
  );
}
