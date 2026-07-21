import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { cnbsModernClient } from './context.js';
import { getRegionByName } from '../constants/index.js';
import { CnbsCategory } from '../types/index.js';
import { createToolErrorResult, createUnionResults, zUnionResultsOutputSchema } from './common.js';
import { zStrId } from './common.js';

interface RegionComparisonItem {
  region: string;
  value?: string;
  unit: string;
  period?: string;
  indicator: string;
}

interface TimeComparisonItem {
  year: string;
  value?: string;
  unit: string;
  region: string;
  indicator: string;
}

export function registerCnbsCoreTools(server: McpServer) {


  server.registerTool(
    'cnbs_search',
    {
      title: 'Search CNBS Data',
      description: `通过关键词搜索中国国家统计局指标和数据（推荐优先使用）。返回匹配的数据集列表。

Args:
  - keyword (string): 搜索关键词，如 "GDP"、"CPI"、"人口"
  - pageNum (number): 页码，默认1
  - pageSize (number): 每页数量，默认10

Returns:
  匹配的数据集列表。结果字段包括 cid（充当 setId）、indic_id（充当 metricId）、show_name、dt/dt_name、value；单位需从 show_name 括号中解析，无独立 unit/time 字段
`,
      inputSchema: z.object({
        keyword: z.string().describe('搜索关键词，如 "GDP"、"CPI"、"人口"'),
        pageNum: z.number().optional().default(1).describe('页码，默认1'),
        pageSize: z.number().optional().default(10).describe('每页数量，默认10'),
      }).strict(),
      outputSchema: {
        results: z.object({}).passthrough(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const results = await cnbsModernClient.findItems({
          keyword: args.keyword,
          pageNum: args.pageNum ?? 1,
          pageSize: args.pageSize ?? 10,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          structuredContent: { results },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_search', error);
      }
    }
  );


  server.registerTool(
    'cnbs_fetch_nodes',
    {
      title: 'Fetch CNBS Nodes',
      description: `获取中国国家统计局分类树节点。支持同时查询多个分类。isLeaf=true 的节点 _id 即为 setId。

Args:
  - categories (string | string[]): 单个或多个分类代码，如 "3" 或 ["1","2","3"]（1月度 2季度 3年度 5分省季度 6分省年度 7其他）
  - parentId (string): 父节点 _id，可空或省略表示从根开始；传入时必须是本工具返回节点的 _id

Returns:
  固定返回 { results, count }；每项 key 为 category，data 为分类树节点列表，error 为该分类错误
`,
      inputSchema: z.object({
        categories: z.union([zStrId, z.array(zStrId)]).describe('单个或多个分类代码，如 "3" 或 ["1","2","3"]'),
        parentId: zStrId.optional().describe('父节点 _id，可空表示从根开始；传入时必须是本工具返回节点的 _id'),
      }).strict(),
      outputSchema: zUnionResultsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const catList = Array.isArray(args.categories) ? args.categories : [args.categories];
        if (catList.length === 1) {
          const nodes = await cnbsModernClient.fetchNodes({ category: catList[0], parentId: args.parentId });
          const structuredContent = { results: [{ key: catList[0], data: nodes }], count: 1 };
          return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
        }
        const settled = await Promise.allSettled(catList.map((cat) => cnbsModernClient.fetchNodes({ category: cat, parentId: args.parentId })));
        const structuredContent = createUnionResults(catList, settled);
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
      } catch (error) {
        return createToolErrorResult('cnbs_fetch_nodes', error);
      }
    }
  );


  server.registerTool(
    'cnbs_fetch_metrics',
    {
      title: 'Fetch CNBS Metrics',
      description: `根据数据集ID (setId) 获取所有可用指标列表。支持同时查询多个数据集。

Args:
  - setIds (string | string[]): 单个或多个数据集ID，取自 cnbs_search 的 cid 或 cnbs_fetch_nodes 中 isLeaf=true 节点的 _id；不要使用 ek
  - name (string): 指标名称过滤（可选，单个 setId 时有效）

Returns:
  固定返回 { results, count }；每项 key 为 setId，data 为指标列表，error 为该 setId 错误
`,
      inputSchema: z.object({
        setIds: z.union([zStrId, z.array(zStrId)]).describe('数据集ID，取自 cnbs_search 的 cid 或 cnbs_fetch_nodes 中 isLeaf=true 节点的 _id；不要使用 ek'),
        name: z.string().optional().describe('指标名称过滤（可选）'),
      }).strict(),
      outputSchema: zUnionResultsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const idList = Array.isArray(args.setIds) ? args.setIds : [args.setIds];
        if (idList.length === 1) {
          const metrics = await cnbsModernClient.fetchMetrics({ setId: idList[0], name: args.name });
          const structuredContent = { results: [{ key: idList[0], data: metrics }], count: 1 };
          return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
        }
        const settled = await Promise.allSettled(idList.map((id) => cnbsModernClient.fetchMetrics({ setId: id, name: args.name })));
        const structuredContent = createUnionResults(idList, settled);
        return { content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent };
      } catch (error) {
        return createToolErrorResult('cnbs_fetch_metrics', error);
      }
    }
  );


  server.registerTool(
    'cnbs_fetch_series',
    {
      title: 'Fetch CNBS Series',
      description: `批量获取统计指标数据。value 可能为空（NBS API 限制），最新单值请优先使用 cnbs_search。

Args:
  - setId (string): cnbs_search 结果的 cid，不要使用 ek
  - metricIds (string[]): cnbs_search 结果的 indic_id
  - periods (string[]): 年度 2024YY、季度 2024A/B/C/D、月度 202401MM
  - areas (array): 地区维度，默认全国
  - rootId (string): 根节点ID，月度数据默认为 fc982599aa684be7969d7b90b1bd0e84

Returns:
  统计数据点列表
`,
      inputSchema: z.object({
        setId: zStrId.describe('数据集ID，取自 cnbs_search 返回的 cid；不要使用 ek'),
        metricIds: z.array(zStrId).describe('指标ID数组，取自 cnbs_search 返回的 indic_id'),
        periods: z.array(zStrId).describe('时间范围，如年度 2024YY、季度 2024A/B/C/D、月度 202401MM'),
        areas: z.array(z.object({
          text: zStrId,
          code: zStrId,
        })).optional().default([{ text: '全国', code: '000000000000' }]).describe('地区维度，默认全国'),
        rootId: zStrId.optional().describe('根节点ID，月度数据默认为 fc982599aa684be7969d7b90b1bd0e84'),
      }).strict(),
      outputSchema: {
        series: z.object({}).passthrough(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const series = await cnbsModernClient.fetchSeries({
          setId: args.setId,
          metricIds: args.metricIds,
          periods: args.periods,
          areas: args.areas ?? [{ text: '全国', code: '000000000000' }],
          rootId: args.rootId,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(series, null, 2) }],
          structuredContent: { series },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_fetch_series', error);
      }
    }
  );


  server.registerTool(
    'cnbs_fetch_end_nodes',
    {
      title: 'Fetch CNBS End Nodes',
      description: `递归获取指定分类代码下所有叶子节点（setId）。注意：耗时长，不建议频繁使用。

Args:
  - category (string): 分类代码：1月度 2季度 3年度 5分省季度 6分省年度 7其他

Returns:
  所有叶子节点列表
`,
      inputSchema: z.object({
        category: zStrId.describe('分类代码：1月度 2季度 3年度 5分省季度 6分省年度 7其他'),
      }).strict(),
      outputSchema: {
        endNodes: z.array(z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const endNodes = await cnbsModernClient.fetchAllEndNodes(args.category as CnbsCategory);
        return {
          content: [{ type: 'text', text: JSON.stringify(endNodes, null, 2) }],
          structuredContent: { endNodes },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_fetch_end_nodes', error);
      }
    }
  );


  server.registerTool(
    'cnbs_batch_search',
    {
      title: 'Batch Search CNBS Data',
      description: `批量搜索多个关键词的统计数据。一次性查询多个指标，提高效率。

Args:
  - keywords (string[]): 搜索关键词数组，如 ["GDP", "CPI", "人口"]
  - pageSize (number): 每个关键词返回的结果数量，默认5

Returns:
  固定返回 { results, count }；每项 key 为 keyword，data 为搜索结果，error 为该关键词错误

示例：
  cnbs_batch_search(keywords=["GDP", "CPI", "出生率"])
  返回三个关键词各自的搜索结果
`,
      inputSchema: z.object({
        keywords: z.array(z.string()).describe('搜索关键词数组'),
        pageSize: z.number().optional().default(5).describe('每个关键词返回的结果数量'),
      }).strict(),
      outputSchema: zUnionResultsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const results = await cnbsModernClient.batchFindItems(args.keywords, args.pageSize);
        const structuredContent = {
          results: args.keywords.map((keyword) => {
            const result = results[keyword];
            if (result && typeof result === 'object' && 'error' in result) {
              return { key: keyword, error: String(result.error) };
            }
            return { key: keyword, data: result };
          }),
          count: args.keywords.length,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return createToolErrorResult('cnbs_batch_search', error);
      }
    }
  );


  server.registerTool(
    'cnbs_compare',
    {
      title: 'Compare CNBS Data',
      description: `对比不同地区或不同时间的数据。支持地区对比和时间对比。该工具依赖搜索结果中的地区匹配，匹配不到时会返回空结果。

Args:
  - keyword (string): 搜索关键词
  - regions (string[]): 要对比的地区名称数组，如 ["北京", "上海", "广东"]
  - compareType (string): 对比类型，"region"（地区对比）或 "time"（时间对比）
  - years (string[]): 时间对比时的年份数组，如 ["2022", "2023", "2024"]

Returns:
  对比结果表格

示例：
  - 地区对比：cnbs_compare(keyword="GDP", regions=["北京", "上海"], compareType="region")
  - 时间对比：cnbs_compare(keyword="GDP", compareType="time", years=["2022", "2023", "2024"])
`,
      inputSchema: z.object({
        keyword: z.string().describe('搜索关键词'),
        regions: z.array(z.string()).optional().describe('要对比的地区名称数组'),
        compareType: z.enum(['region', 'time']).default('region').describe('对比类型'),
        years: z.array(zStrId).optional().describe('时间对比时的年份数组'),
      }).strict(),
      outputSchema: {
        keyword: z.string(),
        compareType: z.enum(['region', 'time']),
        comparison: z.record(z.string(), z.record(z.string(), z.object({}).passthrough())),
        summary: z.array(z.object({}).passthrough()),
        hint: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const searchResult = await cnbsModernClient.findItems({ keyword: args.keyword, pageSize: 20 });
        const dataList = Array.isArray(searchResult?.data) ? searchResult.data : [];

        if (dataList.length === 0) {
          const structuredContent = {
            keyword: args.keyword,
            compareType: args.compareType,
            comparison: {},
            summary: [],
            hint: `未找到关键词 "${args.keyword}" 的数据`,
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
            structuredContent,
          };
        }

        if (args.compareType === 'region' && args.regions) {
          const regionCodes = args.regions.map(name => {
            const region = getRegionByName(name);
            return { name, code: region?.code || '000000000000' };
          });

          const comparison: RegionComparisonItem[] = [];

          for (const item of dataList) {
            const regionInfo = regionCodes.find(r =>
              r.code === item.da ||
              item.da_name?.includes(r.name) ||
              r.name.includes(item.da_name || '')
            );

            if (regionInfo) {
              comparison.push({
                region: item.da_name || regionInfo.name,
                value: item.value,
                unit: item.show_name?.match(/\((.+)\)/)?.[1] || '',
                period: item.dt_name || item.dt,
                indicator: item.show_name,
              });
            }
          }

          const groupedByRegion: Record<string, Record<string, { value?: string; unit: string; period?: string }>> = {};
          for (const item of comparison) {
            if (!groupedByRegion[item.region]) {
              groupedByRegion[item.region] = {};
            }
            groupedByRegion[item.region][item.indicator] = {
              value: item.value,
              unit: item.unit,
              period: item.period,
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({
              keyword: args.keyword,
              compareType: 'region',
              comparison: groupedByRegion,
              summary: comparison,
            }, null, 2) }],
            structuredContent: {
              keyword: args.keyword,
              compareType: 'region',
              comparison: groupedByRegion,
              summary: comparison,
            },
          };
        }

        if (args.compareType === 'time' && args.years) {
          const comparison: TimeComparisonItem[] = [];

          for (const item of dataList) {
            const year = item.dt?.toString();
            if (year && args.years.includes(year)) {
              comparison.push({
                year: item.dt_name || year,
                value: item.value,
                unit: item.show_name?.match(/\((.+)\)/)?.[1] || '',
                region: item.da_name || '全国',
                indicator: item.show_name,
              });
            }
          }

          const groupedByYear: Record<string, Record<string, { value?: string; unit: string; region: string }>> = {};
          for (const item of comparison) {
            if (!groupedByYear[item.year]) {
              groupedByYear[item.year] = {};
            }
            groupedByYear[item.year][item.indicator] = {
              value: item.value,
              unit: item.unit,
              region: item.region,
            };
          }

          return {
            content: [{ type: 'text', text: JSON.stringify({
              keyword: args.keyword,
              compareType: 'time',
              comparison: groupedByYear,
              summary: comparison,
            }, null, 2) }],
            structuredContent: {
              keyword: args.keyword,
              compareType: 'time',
              comparison: groupedByYear,
              summary: comparison,
            },
          };
        }

        const structuredContent = {
            keyword: args.keyword,
          compareType: args.compareType,
          comparison: {},
          summary: [],
            hint: '请指定 regions 参数（地区对比）或 years 参数（时间对比）',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (error) {
        return createToolErrorResult('cnbs_compare', error);
      }
    }
  );


  // 中国宏观经济一览
  server.registerTool(
    'cnbs_economic_snapshot',
    {
      title: 'China Economic Snapshot',
      description: `一次性获取中国当前核心宏观经济指标的最新值，覆盖 GDP、CPI、PPI、PMI、失业率、工业、消费、投资、贸易、货币供应。
适合需要快速了解中国经济全貌的场景，避免多次单独调用 cnbs_search。

Returns:
  10 项核心指标的最新值及元数据（指标名、值、单位、时间）

示例：
  cnbs_economic_snapshot()
`,
      inputSchema: z.object({}).strict(),
      outputSchema: {
        snapshot: z.array(z.object({}).passthrough()),
        count: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const keywords = [
          'GDP',
          '居民消费价格指数',
          '工业生产者出厂价格指数',
          '制造业采购经理指数',
          '城镇调查失业率',
          '规模以上工业增加值',
          '社会消费品零售总额',
          '固定资产投资',
          '货物进出口总额',
          'M2货币供应量',
        ];
        const results = await cnbsModernClient.batchFindItems(keywords, 1);
        const snapshot = keywords.map((keyword) => {
          const entry = results[keyword];
          const item = entry && !('error' in entry) ? entry.data?.[0] : undefined;
          return {
            indicator: keyword,
            value: item?.value ?? null,
            unit: item?.show_name?.match(/[（(](.+)[)）]/)?.[1] ?? null,
            period: item?.dt_name ?? item?.dt ?? null,
            name: item?.show_name ?? null,
          };
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ snapshot, count: snapshot.length }, null, 2) }],
          structuredContent: { snapshot, count: snapshot.length },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_economic_snapshot', error);
      }
    }
  );


  // 一步式快速查询：搜索 → 取指标 → 取数据
  server.registerTool(
    'cnbs_quick_query',
    {
      title: 'Quick Query CNBS Data',
      description: `一步完成"搜索→取指标→取数据",适合"已知指标名、只想快速拿单个指标时间序列"的场景,无需分步调用 cnbs_search / cnbs_fetch_metrics / cnbs_fetch_series。

注意:面对"医疗""医药"等模糊的行业级关键词时,请先调用 cnbs_search 确认指标名称、数据集ID与时间粒度,或用 metricName 过滤;否则可能命中存量/年度类指标而返回空值。

Args:
  - keyword (string): 搜索关键词,越具体越好,如 "医药制造业增加值" 优于 "医药"
  - metricName (string): 指标名称过滤(可选),不传则取相关性最高数据集下的第一个指标
  - startPeriod (string): 起始时间(可选),如 "202001MM"
  - endPeriod (string): 结束时间(可选),如 "202412MM"

Returns:
  { setId, metric, series, warning?, candidates? }
  - setId/metric/series: 命中的数据集ID、指标信息和时间序列数据
  - warning: 当结果全为空值或关键词宽泛命中多板块时的提示与建议
  - candidates: 宽泛关键词命中的其它数据集清单(name/setId/granularity/dt),供精准复查

示例：
  cnbs_quick_query(keyword="医药制造业增加值")
`,
      inputSchema: z.object({
        keyword: z.string().describe('搜索关键词，如 "GDP"、"CPI"'),
        metricName: z.string().optional().describe('指标名称过滤（可选）'),
        startPeriod: zStrId.optional().describe('起始时间（可选），如 "202001MM"'),
        endPeriod: zStrId.optional().describe('结束时间（可选），如 "202412MM"'),
      }).strict(),
      outputSchema: z.object({}).passthrough(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = await cnbsModernClient.findAndFetch(
          args.keyword,
          args.metricName,
          args.startPeriod,
          args.endPeriod,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return createToolErrorResult('cnbs_quick_query', error);
      }
    }
  );


  // 批量获取多组时间序列
  server.registerTool(
    'cnbs_batch_series',
    {
      title: 'Batch Fetch CNBS Series',
      description: `一次性并行获取多组统计指标时间序列，每组独立返回结果或错误，互不影响。

Args:
  - queries (array): 查询数组，每项包含 setId、metricIds、periods，可选 areas / rootId

Returns:
  每条查询对应的 { query, result, error? } 列表

示例：
  cnbs_batch_series(queries=[{ setId: "xxx", metricIds: ["yyy"], periods: ["2024YY"] }])
`,
      inputSchema: z.object({
        queries: z.array(z.object({
          setId: zStrId.describe('数据集ID，取自 cnbs_search 返回的 cid'),
          metricIds: z.array(zStrId).describe('指标ID数组，取自 cnbs_search 返回的 indic_id'),
          periods: z.array(zStrId).describe('时间范围，如年度 2024YY、季度 2024A/B/C/D、月度 202401MM'),
          areas: z.array(z.object({
            text: zStrId,
            code: zStrId,
          })).optional().default([{ text: '全国', code: '000000000000' }]).describe('地区维度，默认全国'),
          rootId: zStrId.optional().describe('根节点ID（可选）'),
        })).describe('查询数组'),
      }).strict(),
      outputSchema: {
        results: z.array(z.object({}).passthrough()),
        count: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const results = await cnbsModernClient.batchFetchSeries(
          args.queries.map((q) => ({
            setId: q.setId,
            metricIds: q.metricIds,
            periods: q.periods,
            areas: q.areas ?? [{ text: '全国', code: '000000000000' }],
            rootId: q.rootId,
          })),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify({ results, count: results.length }, null, 2) }],
          structuredContent: { results, count: results.length },
        };
      } catch (error) {
        return createToolErrorResult('cnbs_batch_series', error);
      }
    }
  );
}
