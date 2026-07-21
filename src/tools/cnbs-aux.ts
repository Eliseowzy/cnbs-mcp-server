import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cnbsModernClient } from './context.js';
import { dataSourceManager, WorldBankDataSource, IMFDataSource, OECDDataSource, BISDataSource, CensusDataSource, DepartmentDataSource } from '../services/data-sources/index.js';
import { CNBS_REGIONS, CNBS_CATEGORY_INFO, searchRegions } from '../constants/index.js';
import { createToolErrorResult, zUnknownObject, zUnknownResult, zWrappedResultOutputSchema } from './common.js';

export function registerCnbsAuxTools(server: McpServer) {


  server.registerTool(
    'cnbs_get_regions',
    {
      title: 'Get CNBS Regions',
      description: `获取可用的地区列表，用于分省数据查询。返回地区代码和名称列表。

Args:
  - keyword (string): 搜索关键词，可选，用于过滤地区
  - level (string): 地区级别过滤，可选：province（省级）、city（市级）、county（县级）

Returns:
  地区列表，包含 code（地区代码）、name（全称）、shortName（简称）

示例：
  - 不传参数：返回所有省份
  - keyword="广东"：返回广东省
  - keyword="江"：返回名称包含"江"的省份（江苏、浙江等）
`,
      inputSchema: z.object({
        keyword: z.string().optional().describe('搜索关键词，如 "广东"、"北京"'),
        level: z.enum(['province', 'city', 'county']).optional().describe('地区级别过滤'),
      }).strict(),
      outputSchema: {
        regions: z.array(zUnknownObject),
        count: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        let regions = CNBS_REGIONS;

        if (args.keyword) {
          regions = searchRegions(args.keyword);
        }

        if (args.level) {
          regions = regions.filter(r => r.level === args.level);
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ regions, count: regions.length }, null, 2) }],
          structuredContent: { regions, count: regions.length },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_get_regions', error);
      }
    }
  );


  server.registerTool(
    'cnbs_get_categories',
    {
      title: 'Get CNBS Categories',
      description: `获取所有数据分类信息，包括分类代码、名称和时间粒度。

Returns:
  分类列表，包含代码、名称、时间粒度类型

示例返回：
  - 代码 1：月度数据（CPI、PPI等）
  - 代码 2：季度数据（GDP季度值等）
  - 代码 3：年度数据（GDP年度值、人口等）
  - 代码 6：分省年度数据
`,
      inputSchema: z.object({}).strict(),
      outputSchema: {
        categories: z.array(zUnknownObject),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const categories = Object.entries(CNBS_CATEGORY_INFO).map(([code, info]) => ({
          code,
          name: info.name,
          dtType: info.dtType,
        }));

        return {
          content: [{ type: 'text', text: JSON.stringify({ categories }, null, 2) }],
          structuredContent: { categories },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_get_categories', error);
      }
    }
  );


  // 列出数据源工具
  server.registerTool(
    'cnbs_list_data_sources',
    {
      title: 'List CNBS Data Sources',
      description: `列出所有可用的数据源，包括国家统计局数据、普查数据、国际数据等。

Returns:
  数据源列表，包括名称、描述、状态等信息

示例：
  cnbs_list_data_sources()
`,
      inputSchema: z.object({}).strict(),
      outputSchema: {
        dataSources: z.array(zUnknownObject),
        total: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const dataSources = [
          {
            name: 'cnbs',
            description: '国家统计局常规统计数据（月度/季度/年度/分省）',
            categories: ['1=月度', '2=季度', '3=年度', '5=分省季度', '6=分省年度'],
            status: 'active',
            auth: '无需认证',
            tool: 'cnbs_search / cnbs_fetch_series',
          },
          {
            name: 'world_bank',
            description: '世界银行开放数据 - GDP、CPI、贸易、人口等跨国指标',
            categories: Object.keys(WorldBankDataSource.INDICATORS),
            status: 'active',
            auth: '无需认证',
            tool: 'ext_world_bank',
          },
          {
            name: 'imf',
            description: 'IMF DataMapper - WEO 预测、经常账户、政府债务等',
            categories: Object.keys(IMFDataSource.INDICATORS),
            status: 'active',
            auth: '无需认证',
            tool: 'ext_imf',
          },
          {
            name: 'oecd',
            description: 'OECD SDMX - 季度GDP、就业、先行指标（成员国）',
            categories: Object.keys(OECDDataSource.DATASETS),
            status: 'active',
            auth: '无需认证',
            tool: 'ext_oecd',
          },
          {
            name: 'bis',
            description: 'BIS Statistics - 有效汇率、信贷缺口、跨境银行统计',
            categories: Object.keys(BISDataSource.DATASETS),
            status: 'active',
            auth: '无需认证',
            tool: 'ext_bis',
          },
          {
            name: 'census',
            description: '国家统计局普查数据（人口/经济/农业普查）',
            categories: Object.keys(CensusDataSource.CENSUS_KEYWORDS),
            status: 'active',
            auth: '无需认证',
            tool: 'ext_cn_census',
          },
          {
            name: 'department',
            description: '各部门统计数据（财政/工信/商务/农业/央行等）',
            categories: Object.keys(DepartmentDataSource.DEPARTMENTS),
            status: 'active',
            auth: '无需认证',
            tool: 'ext_cn_department',
          },
          {
            name: 'international',
            description: '国际统计聚合源（转发至 world_bank / imf / oecd / bis）',
            categories: ['world_bank', 'imf', 'oecd', 'bis'],
            status: 'active',
            auth: '无需认证',
            tool: 'cnbs_fetch_data_from_source(source="international")',
          },
        ];
        return {
          content: [{ type: 'text', text: JSON.stringify({ dataSources, total: dataSources.length }, null, 2) }],
          structuredContent: { dataSources, total: dataSources.length },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_list_data_sources', error);
      }
    }
  );


  // 从特定数据源获取数据工具
  server.registerTool(
    'cnbs_fetch_data_from_source',
    {
      title: 'Fetch Data from Specific Source',
      description: `从特定数据源获取数据，支持扩展数据源。通常直接使用对应 ext_* 工具即可；本工具用于统一或编程式访问。

Args:
  - source (string): 数据源名称，如 "cnbs"、"census"、"international"、"department"
  - params (object): 数据源特定的参数

Returns:
  数据源返回的数据


示例：
  cnbs_fetch_data_from_source(source="cnbs", params={keyword: "GDP"})
  cnbs_fetch_data_from_source(source="census", params={type: "population", year: "2020"})
  cnbs_fetch_data_from_source(source="international", params={source: "world_bank", indicator: "GDP", country: "CHN"})
  cnbs_fetch_data_from_source(source="department", params={department: "finance", indicator: "财政收入", period: "2024Q1"})
`,
      inputSchema: z.object({
        source: z.string().describe('数据源名称'),
        params: z.object({}).passthrough().describe('数据源特定的参数'),
      }).strict(),
      outputSchema: zWrappedResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.source === 'cnbs') {
          const keyword = args.params.keyword as string;
          if (keyword) {
            const result = await cnbsModernClient.findItems({ keyword });
            const structuredContent = { result: result as Record<string, unknown> };
            return {
              content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
              structuredContent,
            };
          } else {
            return createToolErrorResult('cnbs_fetch_data_from_source', new Error('Missing keyword parameter for cnbs source'));
          }
        } else {
          const result = await dataSourceManager.fetchData(args.source, args.params);
          const structuredContent = { result: result as Record<string, unknown> };
          return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
            structuredContent,
          };
        }
      } catch (error) {
        return createToolErrorResult('cnbs_fetch_data_from_source', error);
      }
    }
  );


  // 获取数据源分类工具
  server.registerTool(
    'cnbs_get_source_categories',
    {
      title: 'Get Source Categories',
      description: `获取特定数据源的分类信息。通常直接使用对应 ext_* 工具即可；本工具用于统一或编程式访问。

Args:
  - source (string): 数据源名称，如 "census"、"international"、"department"

Returns:
  数据源的分类信息

示例：
  cnbs_get_source_categories(source="census")
  cnbs_get_source_categories(source="international")
`,
      inputSchema: z.object({
        source: z.string().describe('数据源名称'),
      }).strict(),
      outputSchema: {
        categories: zUnknownResult,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const categories = await dataSourceManager.getCategories(args.source);
        return {
          content: [{ type: 'text', text: JSON.stringify({ categories }, null, 2) }],
          structuredContent: { categories },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_get_source_categories', error);
      }
    }
  );


  // 在特定数据源中搜索工具
  server.registerTool(
    'cnbs_search_in_source',
    {
      title: 'Search in Specific Source',
      description: `在特定数据源中搜索数据。通常直接使用对应 ext_* 工具即可；本工具用于统一或编程式访问。

Args:
  - source (string): 数据源名称，如 "census"、"international"、"department"
  - keyword (string): 搜索关键词

Returns:
  搜索结果

示例：
  cnbs_search_in_source(source="census", keyword="人口")
  cnbs_search_in_source(source="international", keyword="GDP")
`,
      inputSchema: z.object({
        source: z.string().describe('数据源名称'),
        keyword: z.string().describe('搜索关键词'),
      }).strict(),
      outputSchema: zWrappedResultOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await dataSourceManager.search(args.source, args.keyword);
        const structuredContent = { result };
        return {
          content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return createToolErrorResult('cnbs_search_in_source', error);
      }
    }
  );
}
