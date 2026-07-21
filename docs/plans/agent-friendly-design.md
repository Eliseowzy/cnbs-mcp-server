# cnbs-mcp-server 面向 Agent 的设计

本文梳理 `cnbs-mcp-server` 在架构与实现上如何专门服务于 LLM Agent 消费，供接手本项目的开发者和 AI 代理理解设计意图。文中示例均链接到实际源码位置。

## 定位

本项目不是给人直接调用的 REST API，而是一个通过 **MCP（Model Context Protocol）** 暴露的**只读统计数据服务**，消费方是接入 MCP 的 LLM Agent。所有工具查询真实公开 API（NBS、世界银行、IMF、OECD、BIS、普查、部门统计），不返回模拟数据。因此"面向 Agent"体现在：让模型能自主发现工具、正确选择工具、稳定解析结果、并在失败时自我修复。

## 一、自描述与渐进式引导

Agent 在没有人工文档的情况下必须靠服务自身"讲清楚怎么用"。本项目提供三层引导：

1. **服务级 instructions**：在 [`createCnbsServer`](file:///Users/eliseo/cnbs-mcp-server/src/server.ts#L29-L39) 注册时注入 `INSTRUCTIONS`，用简短中文说明数据源、推荐工作流，并直接提示"调用 `cnbs_get_guide()` 获取完整指南"。这是 Agent 连接后拿到的第一份上下文。
2. **内置指南工具** [`cnbs_get_guide`](file:///Users/eliseo/cnbs-mcp-server/src/tools/guide.ts#L8-L30)：返回完整的工具目录、选择原则和参数格式，内容来源于 [`guide-content.ts`](file:///Users/eliseo/cnbs-mcp-server/src/tools/guide-content.ts)，与仓库根部的 [`llms.txt`](file:///Users/eliseo/cnbs-mcp-server/llms.txt) 保持同步。Agent 首次使用时可一次性加载完整心智模型。
3. **MCP Resources** [`/health` 与 `/info`](file:///Users/eliseo/cnbs-mcp-server/src/server.ts#L42-L89)：暴露版本、数据源能力、缓存状态，供 Agent 做能力探测与健康判断。

这种"instructions → guide → 单工具描述"的分层，让 Agent 既能快速起步，又能按需深入。

## 二、工具描述即 Prompt

每个工具的 `description` 不是给人看的 API 注释，而是**面向模型的结构化提示词**。以 [`cnbs_search`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L28-L73) 为例，描述统一采用：

- **一句话定位 + 选择建议**（"推荐优先使用"）——帮助模型在多个相似工具间决策；
- **`Args:` 段**逐参数说明含义与示例值；
- **`Returns:` 段**说明返回字段的确切语义，甚至包含数据坑（如"单位需从 `show_name` 括号中解析，无独立 unit 字段"）；
- 部分工具附**调用示例**，如 [`cnbs_batch_search`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L257-L307) 直接给出 `cnbs_batch_search(keywords=[...])`。

关键字段间的映射关系被显式写入描述以消除歧义，例如反复强调"`cid` 充当 `setId`、`indic_id` 充当 `metricId`、不要使用 `ek`"（见 [`cnbs_fetch_metrics`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L119-L159) 与 [`cnbs_fetch_series`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L162-L215)）。这是针对模型常犯错误的定向纠偏。

## 三、输入容错与归一化

模型生成的参数经常类型不稳定（数字 vs 字符串），本项目在 schema 边界做归一化：

- [`zStrId`](file:///Users/eliseo/cnbs-mcp-server/src/tools/common.ts#L9) 用 `z.union([string, number]).transform(String)`，让模型无论传 `6331` 还是 `"6331"` 都被强制转成字符串 ID，行为由 [`schema-coercion.test.ts`](file:///Users/eliseo/cnbs-mcp-server/src/__tests__/schema-coercion.test.ts) 锁定。
- 所有入参对象使用 `.strict()`，拒绝多余字段，促使模型严格按 schema 调用。
- 单值/多值统一：如 `categories`、`setIds` 接受 `string | string[]`，模型无需区分单批场景（见 [`cnbs_fetch_nodes`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L76-L116)）。
- 合理默认值：`pageNum`、`pageSize`、`areas`（默认全国）等都有默认，降低模型必填负担。

## 四、稳定的输出契约

Agent 需要可预测的返回结构才能稳定解析，本项目在 [`common.ts`](file:///Users/eliseo/cnbs-mcp-server/src/tools/common.ts#L13-L36) 统一约定：

- 每个工具同时返回 `content`（文本 JSON，供模型直接阅读）与 `structuredContent`（结构化对象，供程序化消费）。
- **永不返回裸数组或展开的动态 map**：支持批量的工具统一返回 `{ results, count }`，其中 `results[]` 为 `{ key, data?, error? }`（见 [`createUnionResults`](file:///Users/eliseo/cnbs-mcp-server/src/tools/common.ts#L33-L36)）。即使只传一个值也保持相同形状，模型解析逻辑无需分支。
- 批量工具**部分失败不影响整体**：用 `Promise.allSettled` 逐项返回成功数据或错误字符串，Agent 可对成功项继续推理（见 [`cnbs_batch_series`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L605-L662)、[`ext_global_compare`](file:///Users/eliseo/cnbs-mcp-server/src/tools/global-compare.ts#L34-L54)）。

## 五、行为语义标注（Annotations）

每个工具都声明 MCP [annotations](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L50-L55)：`readOnlyHint`、`destructiveHint: false`、`idempotentHint: true`、`openWorldHint`。这让 Agent（及其上层框架）能在无需试探的情况下判断工具是否安全、可重试、幂等——例如可放心并行调用或自动重试，而不用担心副作用。

## 六、降低多步编排负担的"聚合工具"

朴素的 NBS 查询需要"搜索 → 取指标 → 取数据"多步串联，每一步都是模型出错和消耗 token 的机会。项目提供了一批**高层聚合工具**把常见意图一步完成：

- [`cnbs_quick_query`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L548-L601)：一步完成"搜索→取指标→取数据"。
- [`cnbs_economic_snapshot`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L485-L544)：一次拿到 GDP/CPI/PPI/PMI 等 10 项核心指标最新值，避免多次单查。
- [`cnbs_compare`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L310-L481)：封装地区/时间横向对比。
- [`ext_global_compare`](file:///Users/eliseo/cnbs-mcp-server/src/tools/global-compare.ts)：世界银行 + IMF 双源交叉核验。

同时 `llms.txt` 的[推荐工作流](file:///Users/eliseo/cnbs-mcp-server/llms.txt#L56-L136)把"意图 → 工具序列"显式列出，进一步减少模型自由发挥导致的路径偏差。

## 七、结果内嵌自纠偏提示

当查询语义模糊或结果异常时，工具不只是返回空值，而是主动给出**下一步建议**：

- [`cnbs_quick_query`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L562-L566) 在结果全空或关键词过宽时返回 `warning` 与 `candidates`（其它候选数据集清单），引导模型精准复查。
- [`cnbs_compare`](file:///Users/eliseo/cnbs-mcp-server/src/tools/cnbs-core.ts#L354-L365) 在无匹配时返回 `hint`（如"请指定 regions 或 years 参数"）。

这类字段把"排错知识"直接喂给模型，减少来回试错。

## 八、Agent 友好的错误处理

外部 API 不稳定，Agent 需要能理解并应对错误。[`CnbsErrorHandler`](file:///Users/eliseo/cnbs-mcp-server/src/services/error.ts#L86-L242) 把各类底层异常归一化为带语义的 [`CnbsErrorDetails`](file:///Users/eliseo/cnbs-mcp-server/src/services/error.ts#L26-L41)：

- 明确的错误 **类型枚举**（超时、限流、访问被拦截、数据问题等）与 `canRetry` 标志，模型可据此决定是否重试或换路径。
- 针对反爬/WAF 等场景附带 `hints` 数组给出人类可读的处置建议（见 [redirect 循环处理](file:///Users/eliseo/cnbs-mcp-server/src/services/error.ts#L117-L131)）。
- 工具层统一通过 [`createToolErrorResult`](file:///Users/eliseo/cnbs-mcp-server/src/tools/common.ts#L38-L45) 返回 `isError: true` + 文本消息 + `structuredContent.error`，符合 MCP 错误契约，Agent 能一致地捕获。
- 传输侧带指数退避重试 [`retryWithBackoff`](file:///Users/eliseo/cnbs-mcp-server/src/services/error.ts#L245-L300)，对模型透明地吸收瞬时故障。

## 九、无状态传输与并发安全

服务采用**无状态 Streamable HTTP**：入口 [`index.ts`](file:///Users/eliseo/cnbs-mcp-server/src/index.ts#L120-L131) 为每个请求新建独立 transport 与 MCP server 实例（`sessionIdGenerator: undefined`），不依赖长会话。这契合 Agent 多为无状态、可并发、可重放的调用模式，也便于水平扩展和容器化部署。请求体限制 1 MB、可选 Bearer 鉴权、CORS 支持均在同一入口处理。

## 十、可观测性

工具注册被 [`patchRegisterTool`](file:///Users/eliseo/cnbs-mcp-server/src/tools/common.ts#L47-L79) 统一包裹，为每次调用记录耗时、成功与否并打点 Prometheus 指标（`mcpToolCallsTotal`、`mcpToolDurationMs`）。这让运维者能观测 Agent 实际如何使用各工具，反哺工具描述与工作流优化。此外该包裹层还幂等去重工具名，避免重复注册。

## 小结

本项目把"面向 Agent"落到实处的核心手段是：**用自然语言描述作提示词、用 schema 归一化吸收模型输入噪声、用稳定结构化契约保证可解析、用聚合工具压缩多步编排、用内嵌提示与语义化错误支撑自纠偏**。修改工具或工作流时，请同步维护 [`llms.txt`](file:///Users/eliseo/cnbs-mcp-server/llms.txt) 与 [`guide-content.ts`](file:///Users/eliseo/cnbs-mcp-server/src/tools/guide-content.ts)，保持 Agent 侧引导与实现一致（约定见 [`AGENTS.md`](file:///Users/eliseo/cnbs-mcp-server/docs/%20laws/AGENTS.md)）。
