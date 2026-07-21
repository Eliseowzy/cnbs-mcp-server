<p align="center">
  <img src="https://img.alicdn.com/imgextra/i4/O1CN01LVIjqy1SCgr75ys5w_!!6000000002211-2-tps-1920-1913.png" alt="国家统计局标志" width="112" />
</p>

<h1 align="center">cnbs-mcp-server</h1>

<p align="center">
  一个只读 MCP 服务，让 AI Agent 直接查询中国国家统计局和国际公开统计数据，不再手工拼接分散 API。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cnbs-mcp-server"><img alt="version" src="https://img.shields.io/badge/version-1.1.0-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.12.0-339933">
  <img alt="mcp" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-7C3AED">
  <img alt="docker" src="https://img.shields.io/badge/docker-GHCR-2496ED">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

## 为什么需要它

官方统计数据可信，但并不天然适合 Agent 调用。新版国家统计局 API 使用 UUID 形式的目录和指标 ID，同一个业务指标可能按时间分片拆成多个数据集，单位、地区、期次、统计口径又分散在不同接口里。

`cnbs-mcp-server` 把这些摩擦封装成面向 Agent 的工具：搜索、最新值、历史序列、地区对比、宏观快照，以及 World Bank、IMF、OECD、BIS、普查和部门统计等多源数据查询与交叉核验。

## 能力速览

| 需求 | 工具族 | 能解决什么 |
|---|---|---|
| 搜索国家统计局指标 | `cnbs_search`, `cnbs_batch_search` | 按关键词查找官方指标和最新值。 |
| 获取历史序列 | `cnbs_fetch_series`, `cnbs_quick_query` | 解析数据集和指标 ID，并拉取时间序列。 |
| 地区或时间对比 | `cnbs_compare` | 对比不同省市、地区或年份下的同一指标。 |
| 获取中国宏观快照 | `cnbs_economic_snapshot` | 一次获取 GDP、CPI、PPI、PMI、失业率、工业、贸易、货币供应等核心指标。 |
| 查询国际数据源 | `ext_world_bank*`, `ext_imf*`, `ext_oecd*`, `ext_bis*` | 获取全球宏观、金融、贸易、就业和预测数据。 |
| 查询普查和部门统计 | `ext_cn_census`, `ext_cn_department*` | 查询人口、经济、农业普查，以及财政、工业、农业、货币、能源、房地产等部门数据。 |
| 多源交叉验证 | `ext_global_compare` | 对同一国家和指标意图比较 World Bank 与 IMF 数据。 |

## 快速开始

```bash
npm ci
npm run build
node dist/index.js --host 127.0.0.1 --port 12345
```

服务采用无状态 Streamable HTTP，仅接受 `POST /` 和 `POST /mcp`。可通过 `CNBS_MCP_SERVER_AUTH_TOKEN` 或 `--auth-token` 启用 Bearer 鉴权；请求体上限为 1 MB。

## MCP 客户端配置

先启动服务，然后在支持 Streamable HTTP 的 MCP 客户端中添加如下配置：

```json
{
  "mcpServers": {
    "cnbs": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:12345/mcp"
    }
  }
}
```

如果启用了 Bearer 鉴权，请在客户端配置中带上同一个 token：

```json
{
  "mcpServers": {
    "cnbs": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:12345/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      }
    }
  }
}
```

## Docker

已发布的 Docker 镜像托管在 GitHub Container Registry，支持 `linux/amd64` 和 `linux/arm64`。

```bash
docker pull ghcr.io/eliseowzy/cnbs-mcp-server:1.1.0-beta.2
```

运行已发布镜像：

```bash
docker run --rm \
  -p 12345:12345 \
  -e CNBS_MCP_SERVER_AUTH_TOKEN=your-token \
  -e LOG_LEVEL=info \
  -v "$PWD/logs:/app/logs" \
  ghcr.io/eliseowzy/cnbs-mcp-server:1.1.0-beta.2
```

MCP 访问地址：

```text
http://127.0.0.1:12345/mcp
```

从源码构建并通过 Docker Compose 启动：

```bash
docker compose up --build
```

如果希望 Compose 使用已发布镜像，可以将服务配置改为：

```yaml
services:
  cnbs-mcp-server:
    image: ghcr.io/eliseowzy/cnbs-mcp-server:1.1.0-beta.2
    ports:
      - "12345:12345"
    restart: unless-stopped
    environment:
      CNBS_MCP_SERVER_AUTH_TOKEN: "${CNBS_MCP_SERVER_AUTH_TOKEN:-}"
      LOG_LEVEL: "${LOG_LEVEL:-info}"
      LOG_DIR: /app/logs
    volumes:
      - ./logs:/app/logs
```

日志会以结构化 JSON 同时输出到 stdout 和 `./logs` 下的滚动文件，可通过 `LOG_LEVEL`、`LOG_DIR` 配置。

## 设计导览

这个仓库也记录了如何为 LLM Agent 构建数据工具：

| 如果你想理解... | 阅读 |
|---|---|
| 服务如何引导 Agent、归一化不稳定入参、返回稳定结构化结果，以及处理语义化错误 | [`docs/plans/agent-friendly-design.md`](docs/plans/agent-friendly-design.md) |
| 快速查询如何压缩“搜索 -> 指标解析 -> 序列拉取”的国家统计局查询流程 | [`docs/plans/quick-query-design.md`](docs/plans/quick-query-design.md) |
| 缓存如何使用 LRU、TTL、并发加载合并、stale-while-revalidate 和缓存中心 | [`docs/plans/cache-module-design.md`](docs/plans/cache-module-design.md) |
| 缓存键如何避免指标、期次、地区和外部数据源参数之间的碰撞 | [`docs/plans/cache-key-design.md`](docs/plans/cache-key-design.md) |

阅读路线：只想使用，先看快速开始；想理解核心产品设计，读面向 Agent 的设计；要维护性能和上游稳定性，读缓存相关文档。

## 开发验证

```bash
npm run lint
npm test
npm run build
```

调用 `cnbs_get_guide` 可查看完整工具列表和推荐查询流程。同一份面向 LLM 的使用指南也维护在 `llms.txt` 中。
