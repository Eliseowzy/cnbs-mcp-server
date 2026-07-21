# cnbs_quick_query 的设计思想

> 面向读者:维护本服务的工程师,以及需要理解"为什么这样设计"的贡献者。
> 本文为说明性文档,不描述任何待办改动。

## 一、定位:把"三步"折叠成"一步"的编排工具

在本 MCP 服务里,查询一个指标的时间序列本来需要三次调用:`cnbs_search`(搜数据集)→ `cnbs_fetch_metrics`(取指标)→ `cnbs_fetch_series`(取数据)。`cnbs_quick_query` 的核心定位就是把这条最高频的链路封装成单次调用(见 `src/tools/cnbs-core.ts` 的 `cnbs_quick_query` 注册体)。

这背后是一个明确的判断:**服务的主要消费者是 LLM Agent,而非人**。对 Agent 而言,三次分步调用意味着三轮 tool-call 往返、三次 token 消耗、三次可能出错的中间态,以及需要正确地在步骤间传递 `setId`、`metricId` 这类内部标识。`quick_query` 用一次调用消除了这些中间态,把"我想看 GDP 的历史数据"这种自然意图直接映射成一次工具调用。工具描述里那句 "无需分步调用 cnbs_search / cnbs_fetch_metrics / cnbs_fetch_series" 就是这个意图的直白声明。

## 二、分层:工具层薄、服务层厚

工具注册体(`registerTool`)本身几乎不含逻辑,它只做四件事:声明 schema、声明 MCP annotations、委托给 `cnbsModernClient.findAndFetch`、统一包装错误(`createToolErrorResult`)。真正的编排逻辑全部沉在服务层 `src/services/api.ts` 的 `findAndFetch`。

这种"工具层只管协议与契约、服务层承载业务编排"的分层不是形式主义:它让 `findAndFetch` 可以被 mock 后独立测试(见 `src/__tests__/tools-core.test.ts`,工具测试只验证"委托 + 错误包装",不碰内部逻辑),也让编排逻辑能脱离 MCP 协议被复用和演进。

## 三、编排流水线:每一步都内置默认与兜底

`findAndFetch` 的五步流水线体现了"约定优于配置"的取舍——四个入参里三个是可选的,不传就走合理默认:

1. **搜索**:`findItems({ keyword, pageSize: 10 })`,内部经 `normalizeSearchResponse` 统一响应形态。
2. **选数据集**:用 `reduce` 按 `dt` 取**最新**的一个数据集,而不是取第一个。默认给用户"最新口径"。
3. **提取 setId**:优先 `cid`,退化到从 `treeinfo_globalid` 尾段解析(`extractSetIdFromGlobalRef`)。
4. **选指标**:传了 `metricName` 走 `matchMetricByName` 容错匹配,没传就取 `metrics[0]`。
5. **取序列**:时间范围默认从数据集的 `dt` 到当前月份,区域默认全国 `000000000000`。

关键设计点是:**便捷不等于封死**。可选参数(`metricName` / `startPeriod` / `endPeriod`)提供了精确控制的逃生舱;而分步工具依然存在,当 `quick_query` 的启发式选择不符合预期时,用户/Agent 可以退回到细粒度调用。这是一个"默认省心、需要时可控"的平衡,而不是把灵活性一刀切掉。

## 四、容错:三次提交打磨出的"渐进降级"匹配

从提交历史看,`quick_query` 的健壮性不是一次成型,而是被真实故障驱动迭代出来的——这是它最值得说的部分。

**第一层容错——响应归一化**(提交 `e0429ed` / `c697a46`):NBS 线上接口返回 `{ data: { data: [...], count } }` 嵌套结构,而旧版/mock 返回扁平数组。`normalizeSearchResponse` 把两种形态压平成统一的 `data: 数组`,让下游 `findAndFetch` 不必关心上游的形态漂移。

**第二层容错——指标名三级匹配**(提交 `25ebfdc` → `47f4ce5`):这是直接由线上故障催生的。根因是:用户传 `"卫生总费用占GDP比重"`,而 NBS 真名是 `"卫生总费用占GDP的比重"`(多一个"的"、全角括号、空格等),严格子串匹配直接失败并抛错。修复方案 `matchMetricByName` 是一个三级降级阶梯:

1. **精确子串**:保留原行为,最省,命中即返回;
2. **归一化双向包含**:经 `normalizeMetricName` 剥离"的/之"、全半角、标点、空白后做双向 `includes`;
3. **字符重叠率排序**:交集字符数 / 目标字符集大小,取最高分且 `>= 0.6` 才采纳,否则宁可返回 `undefined`。

这个阶梯的设计哲学很清晰:**从最廉价、最精确的策略开始,逐级放宽到更模糊、更昂贵的策略,并用阈值守住底线**,避免为了"匹配上"而乱匹配。

**第三层容错——报错即引导**:匹配失败时不再只抛 `Metric not found`,而是列出该数据集前 20 个可选指标名。这是专门为 LLM 消费者设计的——错误信息本身携带了纠错所需的上下文,让 Agent 能自我修正后重试,而不是撞墙。这是"fail informative,而非 fail silent"原则的体现。

## 五、继承而来的韧性:组合低层原语,白拿弹性

`quick_query` 自己没写任何缓存、限流、重试代码,但它天然具备这些能力——因为它调用的 `findItems` / `fetchMetrics` / `fetchSeries` 每一个都已经包裹了三件套:`ManagedCache.fetchOrLoad`(带 stale-grace 的分层缓存)、`cnbsRequestThrottler.execute`(限流)、`CnbsErrorHandler.retryWithBackoff`(指数退避重试)。通过组合已被加固的低层原语,`quick_query` 免费获得了整条链路的韧性。这是"编排层不重复造轮子、让韧性下沉到原语"的分层收益。

## 六、诚实的能力声明与契约

工具的 MCP annotations 明确标注 `readOnlyHint / idempotentHint = true`、`destructiveHint = false`、`openWorldHint = true`。这不是装饰——它如实告诉 MCP 宿主:这是一个只读、可安全重试、依赖外部世界的操作,宿主据此可以放心地做重试、缓存、并行等调度决策。输入 schema 用 `.strict()` 拒绝未知字段,配合返回契约 `{ setId, metric, series }`,形成一个边界清晰、可预测的接口。

## 七、坦率地说,它的边界与代价

要严谨,就不能只讲优点。`quick_query` 的便捷是以若干启发式假设换来的,这些假设在边缘场景会失效:

- **"取最新 dt 的数据集"是启发式**:当关键词模糊、命中多个不同口径的数据集时,"最新"未必是用户想要的那个。
- **无 `metricName` 时取 `metrics[0]` 是任意选择**:第一个指标不必然是最相关的,这一步没有语义排序。
- **字符重叠匹配是"字符袋"模型**:它对字符顺序不敏感,`0.6` 阈值是经验值而非理论最优,理论上存在字符高度重合却语义无关的误命中风险。
- **默认参数写死**:区域固定全国、一次只查单指标、时间后缀假定按月(`MM`)、搜索结果只取前 10 条。这些默认覆盖了主流场景,但一旦需求偏离(比如查省级、季度数据、多指标对比),就必须退回分步工具。

换句话说,`quick_query` 是一个**为高频主路径深度优化的便捷入口**,而不是一个万能查询器。它的设计克制地承认了这一点——保留了完整的分步工具作为它的下位替代,而没有试图用一个工具吞掉所有场景。

## 一句话总结

`cnbs_quick_query` 用"薄工具层 + 厚服务层编排"把最高频的三步查询折叠为一步,以合理默认换便捷、以可选参数留控制,并通过响应归一化、三级降级匹配、引导式报错三层容错和对底层缓存/限流/重试原语的组合,在真实上游不稳定的前提下为 LLM Agent 提供了一个可靠、可预测、能自我纠错的单指标查询入口——代价是若干在边缘场景会失效的启发式假设,而这些代价被"分步工具仍然可用"这一逃生设计所对冲。
