export const LLMS_TXT_CONTENT = `# cnbs-mcp-server — LLM 使用指南

cnbs-mcp-server 是一个无状态 Streamable HTTP MCP 服务器，用于查询中国国家统计局 (NBS) 及国际多源统计数据。所有工具均为只读查询工具，数据来自真实公开 API，不返回模拟数据。

## 当前服务形态

- 运行环境：Node.js >= 22.12.0
- 传输协议：Streamable HTTP
- MCP 入口：\`POST /\` 或 \`POST /mcp\`
- 默认地址：\`http://127.0.0.1:12345/mcp\`
- 鉴权：默认无需鉴权；设置 \`CNBS_MCP_SERVER_AUTH_TOKEN\` 或启动参数 \`--auth-token\` 后需要 Bearer token
- 请求体限制：1 MB
- Docker：\`docker compose up --build\`
- 日志：结构化 JSON 输出到 stdout，并写入 \`./logs\`；可配置 \`LOG_LEVEL\` 和 \`LOG_DIR\`

## 项目文档阅读路径

新来的员工或接手本项目的 LLM 代理，建议按下面顺序渐进式阅读。先理解服务做什么，再了解如何运行、如何改代码，最后进入具体技术方案。

1. \`README.zh-CN.md\`：中文快速入口，了解项目定位、运行方式、MCP 客户端配置、Docker 启动和开发验证命令。
2. \`README.md\`：英文 README，面向公开仓库和英文使用者；当修改用户向说明时，应与中文 README 保持信息一致。
3. \`AGENTS.md\`：开发规范入口，说明源码目录职责、Node/ESM/TypeScript 约定、测试要求、文档同步规则和变更边界。
4. \`llms.txt\`：LLM 使用指南，适合首次连接服务后快速理解工具选择、推荐查询流程、数据源能力和常见参数格式。
5. \`src/tools/guide-content.ts\`：MCP 内置指南内容来源；当工具列表、推荐查询流程或 LLM 提示变化时，需要与 \`llms.txt\` 一起检查。
6. \`docs/plans/cache-module-design.md\`：缓存模块完整技术方案，介绍 LRU、TTL、并发加载合并、stale-while-revalidate、缓存中心和生命周期。
7. \`docs/plans/cache-key-design.md\`：缓存键专项方案，说明搜索、节点、指标、序列和外部数据源缓存键格式及碰撞规避原则。

文档维护约定：

- 面向使用者的能力、启动方式、客户端配置和环境变量变化，应同步更新 \`README.md\` 与 \`README.zh-CN.md\`。
- 技术方案统一放在 \`docs/plans/\` 中。
- 工具注册、工具入参、推荐工作流或 LLM 使用提示变化，应同步检查 \`llms.txt\` 和 \`src/tools/guide-content.ts\`。
- \`docs/plans/\` 中的方案文档应尽量链接到实际源码位置，避免只描述抽象设计。

## 数据源概览

| 数据源 | 工具前缀 | 认证 | 覆盖范围 |
|--------|---------|------|---------|
| 国家统计局 (NBS) | \`cnbs_*\` | 无需 | 国内月度、季度、年度、分省数据 |
| 世界银行 (World Bank) | \`ext_world_bank*\` | 无需 | 200+ 国家，GDP、贸易、人口、FDI 等 |
| IMF DataMapper | \`ext_imf*\` | 无需 | WEO 预测、通胀、政府债务、经常账户等 |
| OECD SDMX | \`ext_oecd*\` | 无需 | 季度 GDP、就业、先行指标、贸易等 |
| BIS Statistics | \`ext_bis*\` | 无需 | 有效汇率、信贷缺口、房价、跨境银行等 |
| NBS 普查数据 | \`ext_cn_census\` | 无需 | 人口、经济、农业普查 |
| NBS 部门统计 | \`ext_cn_department*\` | 无需 | 财政、工业、商务、农业、货币、能源等 |

## 核心使用原则

1. 国内最新单值优先调用 \`cnbs_search(keyword)\`，读取结果中的 \`value\`；单位需从 \`show_name\` 括号中解析，期次读取 \`dt/dt_name\`。
2. 国内历史序列先调用 \`cnbs_search(keyword)\` 获取 \`cid\` 和 \`indic_id\`，再调用 \`cnbs_fetch_series(setId, metricIds, periods)\`。
3. \`cnbs_fetch_series\` 的 \`value\` 字段可能为空，这是 NBS API 限制；需要最新值时不要用它替代 \`cnbs_search\`。
4. 国际数据优先直接调用对应 \`ext_*\` 工具，不要绕到统一访问工具，除非需要编程式统一入口。
5. \`cnbs_fetch_end_nodes(category)\` 会递归遍历叶子节点，耗时较长，不建议在普通问答中频繁调用。
6. 搜索结果字段含义：\`cid\` = \`setId\`，\`indic_id\` = \`metricId\`；\`ek\` 是指标唯一键，其 \`|\` 前缀不是 \`parentId\`。

## 推荐工作流

### 国内最新单指标值

使用：

\`cnbs_search(keyword="GDP")\`

读取返回结果的 \`value\` 字段作为最新值。这是查询中国国内单个宏观指标时的首选路径。

### 国内历史时间序列

使用：

\`cnbs_search(keyword="GDP")\`

然后从搜索结果取 \`cid\` 和 \`indic_id\`，继续调用：

\`cnbs_fetch_series(setId, metricIds, periods)\`

### 国内多指标批量查询

使用：

\`cnbs_batch_search(keywords=["GDP", "CPI", "人口", "出生率"])\`

### 国内地区或时间横向对比

地区对比：

\`cnbs_compare(keyword="GDP", regions=["北京", "上海", "广东"], compareType="region")\`

时间对比：

\`cnbs_compare(keyword="GDP", years=["2020", "2021", "2022"], compareType="time")\`

### 中国宏观经济快照

使用：

\`cnbs_economic_snapshot()\`

一次性获取 GDP、CPI、PPI、PMI、失业率、工业、消费、投资、贸易、货币供应等核心指标的最新值。

### 世界银行国际对比

使用：

\`ext_world_bank(indicator="GDP_GROWTH", countries=["CHN", "USA", "DEU", "JPN"], startYear=2015)\`

### IMF WEO 预测数据

使用：

\`ext_imf(indicators="GDP_GROWTH", countries=["CHN", "USA"], periods=["2023", "2024", "2025"])\`

### 双源交叉验证

使用：

\`ext_global_compare(wbIndicator="GDP_GROWTH", imfIndicator="GDP_GROWTH", countries=["CHN", "USA"], startYear=2015)\`

### BIS 金融稳定指标

使用：

\`ext_bis(dataset="CREDIT_GAP", countries="CN", lastNObservations=20)\`

或：

\`ext_bis(dataset="EER", countries=["CN", "US"], lastNObservations=24)\`

### NBS 普查和部门数据

使用：

\`ext_cn_census(type="population")\`

或：

\`ext_cn_department(department="monetary", indicator="M2货币供应量")\`

## MCP Resources

- \`/health\`：返回服务健康状态、时间戳、版本和缓存统计。
- \`/info\`：返回服务名称、版本、数据源能力、运行时长和时间戳。

## NBS 分类代码

| 代码 | 分类 | 典型指标 |
|------|------|---------|
| 1 | 月度数据 | CPI、PPI、工业增加值、PMI |
| 2 | 季度数据 | GDP 季度增速 |
| 3 | 年度数据 | GDP 年度值、人口、城镇化率 |
| 5 | 分省季度 | 各省 GDP 季度值 |
| 6 | 分省年度 | 各省 GDP、人口年度值 |
| 7 | 其他/调查 | 居民调查、专项调查 |

## NBS 时间格式

- 年度：\`2024YY\`，范围示例 \`["2020YY-2024YY"]\`
- 季度：\`2024A\` / \`2024B\` / \`2024C\` / \`2024D\`，分别代表 Q1 / Q2 / Q3 / Q4；可用快捷值 \`LAST6\`、\`LAST12\`、\`LAST18\`
- 月度：\`202401MM\`，范围示例 \`["202301MM-202412MM"]\`

## NBS 常用地区代码

全国：\`000000000000\`

北京：\`110000000000\`

上海：\`310000000000\`

广东：\`440000000000\`

浙江：\`330000000000\`

江苏：\`320000000000\`

完整地区列表调用：\`cnbs_get_regions()\`

## 指标和数据集速查

### 世界银行指标

\`GDP\` | \`GDP_GROWTH\` | \`GDP_PER_CAPITA\` | \`CPI\` | \`UNEMPLOYMENT\` | \`POPULATION\`

\`EXPORTS\` | \`IMPORTS\` | \`FDI_INFLOWS\` | \`GOVT_DEBT\` | \`GROSS_SAVINGS\`

\`TRADE_PCT_GDP\` | \`GINI\` | \`LIFE_EXPECTANCY\` | \`CO2_EMISSIONS\` | \`INTERNET_USERS\` | \`INFLATION\` | \`CURRENT_ACCOUNT\`

完整列表调用：\`ext_world_bank_indicators()\`

### IMF 指标

\`GDP_GROWTH\` | \`GDP_USD\` | \`GDP_PER_CAPITA\` | \`CPI_INFLATION\` | \`UNEMPLOYMENT\`

\`CURRENT_ACCOUNT\` | \`GOVT_DEBT\` | \`GOVT_BALANCE\` | \`GROSS_SAVINGS\`

\`INVESTMENT\` | \`TRADE_BALANCE\` | \`POPULATION\` | \`OUTPUT_GAP\`

完整预置列表调用：\`ext_imf_indicators()\`

完整 IMF API 指标目录调用：\`ext_imf_all_indicators()\`

### OECD 数据集

\`QNA_GDP\`（季度 GDP） | \`KEI_CPI\`（综合先行指标） | \`EMPLOYMENT\`（就业） | \`TRADE\`（贸易）

完整列表调用：\`ext_oecd_datasets()\`

### BIS 数据集

\`EER\`（有效汇率） | \`CREDIT_GAP\`（信贷缺口） | \`TOTAL_CREDIT\`（总信贷）

\`PROPERTY_PRICES\`（房价） | \`DEBT_SERVICE\`（债务偿还） | \`CROSS_BORDER_BANKING\`（跨境银行）

完整列表调用：\`ext_bis_datasets()\`

### 部门统计

\`finance\`（财政） | \`industry\`（工业） | \`trade\`（商务） | \`agriculture\`（农业）

\`monetary\`（货币金融/央行） | \`social_security\`（社保） | \`housing\`（房地产） | \`energy\`（能源）

完整列表调用：\`ext_cn_department_list()\`

## 全量工具速查

### NBS 核心查询

- \`cnbs_search(keyword, pageNum, pageSize)\`：搜索指标并返回最新值，推荐首选
- \`cnbs_batch_search(keywords, pageSize)\`：批量搜索多个关键词
- \`cnbs_fetch_nodes(categories, parentId)\`：获取分类树节点，\`isLeaf=true\` 的节点 \`_id\` 是 \`setId\`
- \`cnbs_fetch_metrics(setIds, name)\`：获取一个或多个数据集的指标列表
- \`cnbs_fetch_series(setId, metricIds, periods)\`：获取历史时间序列
- \`cnbs_fetch_end_nodes(category)\`：递归获取叶子节点，耗时工具，谨慎使用
- \`cnbs_compare(keyword, regions, years, compareType)\`：地区或时间横向对比
- \`cnbs_economic_snapshot()\`：中国核心宏观指标快照

### NBS 辅助和统一入口

- \`cnbs_get_regions(keyword, level)\`：地区代码列表
- \`cnbs_get_categories()\`：分类代码列表
- \`cnbs_list_data_sources()\`：所有数据源列表
- \`cnbs_fetch_data_from_source(source, params)\`：统一入口，从指定数据源取数
- \`cnbs_get_source_categories(source)\`：统一入口，获取指定数据源分类
- \`cnbs_search_in_source(source, keyword)\`：统一入口，在指定数据源中搜索

### 国际数据

- \`ext_world_bank(indicator, countries, startYear, endYear)\`：世界银行单指标查询
- \`ext_world_bank_multi(indicators, countries, startYear, endYear)\`：世界银行多指标查询
- \`ext_world_bank_indicators(keyword)\`：世界银行指标列表
- \`ext_imf(indicators, countries, periods)\`：IMF DataMapper 查询，支持单个或多个指标
- \`ext_imf_indicators(keyword)\`：IMF 预置指标列表
- \`ext_imf_all_indicators()\`：IMF 完整指标目录
- \`ext_oecd(dataset, key, startPeriod, lastNObservations)\`：OECD SDMX 查询
- \`ext_oecd_datasets(keyword)\`：OECD 数据集列表
- \`ext_bis(dataset, countries, lastNObservations, startPeriod)\`：BIS 查询，支持单个或多个国家
- \`ext_bis_datasets(keyword)\`：BIS 数据集列表
- \`ext_global_compare(wbIndicator, imfIndicator, countries, startYear)\`：世界银行和 IMF 双源对比

### 国内扩展数据

- \`ext_cn_census(type, keyword, pageSize)\`：NBS 普查数据
- \`ext_cn_department(department, indicator, pageSize, fetchAll)\`：部门统计数据
- \`ext_cn_department_list()\`：部门统计分类列表

### 指南

- \`cnbs_get_guide()\`：返回本指南，适合首次连接后调用

## 返回数据提示

1. 所有工具的 \`structuredContent\` 都是 JSON 对象；不会返回裸数组或展开的动态 map。
2. 支持单值/多值输入的 union 工具统一返回 \`{ results, count }\`，其中 \`results[]\` 为 \`{ key, data?, error? }\`；即使只传一个值也保持相同形状。
3. \`cnbs_search\` 的结果字段包括 \`cid\`（setId）、\`indic_id\`（metricId）、\`show_name\`、\`dt/dt_name\`、\`value\`；单位需从 \`show_name\` 括号中解析。
4. 世界银行和 IMF 返回标准化对象，通常读取 \`data\` 数组；BIS 和 OECD 返回 SDMX 转换后的观测数组，常见形态为 \`{ period, value, dimensions }\`。
5. 所有数据源均有本地内存 LRU 缓存，重复查询会自动命中缓存。
6. 服务器是无状态 HTTP MCP；每个请求会创建独立 MCP transport，不依赖长期会话。`;
