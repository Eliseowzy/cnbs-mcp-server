import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { censusSource, departmentSource } from '../services/data-sources/index.js';
import { createToolErrorResult } from './common.js';

export function registerCnExtTools(server: McpServer) {


  // ─── 外部数据源：国家统计局普查 ────────────────────────────────
  server.registerTool(
    'ext_cn_census',
    {
      title: 'China NBS Census Data',
      description: `查询国家统计局普查数据（人口普查、经济普查、农业普查）。通过 NBS 官方 API 获取真实数据。

Args:
  - type (string): 普查类型 "population"（人口）| "economic"（经济）| "agriculture"（农业）
  - keyword (string): 自定义搜索关键词（可选，覆盖默认）
  - pageSize (number): 返回结果数，默认 20
`,
      inputSchema: z.object({
        type: z.enum(['population', 'economic', 'agriculture']).optional().default('population').describe('普查类型'),
        keyword: z.string().optional().describe('自定义搜索关键词'),
        pageSize: z.number().optional().default(20).describe('返回结果数'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const result = await censusSource.fetchData({
          type: args.type,
          keyword: args.keyword,
          pageSize: args.pageSize,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_cn_census', error);
      }
    }
  );


  // ─── 外部数据源：各部门统计 ─────────────────────────────────────
  server.registerTool(
    'ext_cn_department',
    {
      title: 'China Department Statistics',
      description: `查询各部门在国家统计局发布的统计数据。涵盖财政、工业、商务、农业、货币金融、社会保障、房地产、能源等。

Args:
  - department (string): 部门键
  - indicator (string): 具体指标关键词（可选，不填则用部门默认首个关键词）
  - pageSize (number): 返回数量，默认 20
  - fetchAll (boolean): 是否获取该部门所有关键词数据（较慢），默认 false

可用部门: finance（财政）| industry（工业）| trade（商务）| agriculture（农业）| monetary（货币金融）| social_security（社保）| housing（房地产）| energy（能源）
`,
      inputSchema: z.object({
        department: z.enum([
          'finance', 'industry', 'trade', 'agriculture',
          'monetary', 'social_security', 'housing', 'energy',
        ]).describe('部门键'),
        indicator: z.string().optional().describe('具体指标关键词，如 "财政收入"'),
        pageSize: z.number().optional().default(20).describe('返回数量'),
        fetchAll: z.boolean().optional().default(false).describe('是否获取该部门所有关键词数据'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        let result;
        if (args.fetchAll) {
          result = await departmentSource.fetchAllKeywordsForDepartment(args.department);
        } else {
          result = await departmentSource.fetchData({
            department: args.department,
            indicator: args.indicator,
            pageSize: args.pageSize,
          });
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        return createToolErrorResult('ext_cn_department', error);
      }
    }
  );


  server.registerTool(
    'ext_cn_department_list',
    {
      title: 'List Department Categories',
      description: '列出所有可查询的部门及其指标关键词列表。',
      inputSchema: z.object({}).strict(),
      outputSchema: {
        departments: z.array(z.object({}).passthrough()),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const categories = await departmentSource.getCategories();
        return {
          content: [{ type: 'text', text: JSON.stringify({ departments: categories }, null, 2) }],
          structuredContent: { departments: categories },
        };
      } catch (error) {
        return createToolErrorResult('ext_cn_department_list', error);
      }
    }
  );
}
