<p align="center">
  <img src="https://img.alicdn.com/imgextra/i4/O1CN01LVIjqy1SCgr75ys5w_!!6000000002211-2-tps-1920-1913.png" alt="China National Bureau of Statistics logo" width="112" />
</p>

<h1 align="center">cnbs-mcp-server</h1>

<p align="center">
  A read-only MCP server that lets AI agents query official China NBS and international statistics without hand-stitching scattered public APIs.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cnbs-mcp-server"><img alt="version" src="https://img.shields.io/badge/version-1.1.0-blue"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22.12.0-339933">
  <img alt="mcp" src="https://img.shields.io/badge/MCP-Streamable%20HTTP-7C3AED">
  <img alt="docker" src="https://img.shields.io/badge/docker-GHCR-2496ED">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
</p>

## Why this exists

Official statistics are easy to trust but hard for agents to use correctly. The newer NBS API uses UUID-based catalog and indicator IDs, the same business indicator may be split across time slices, and useful fields such as unit, region, period, and statistical notes are spread across multiple calls.

`cnbs-mcp-server` turns that friction into agent-friendly tools. It gives LLMs a guided path for search, latest values, historical series, regional comparison, macro snapshots, and international cross-checks across World Bank, IMF, OECD, BIS, census, and department statistics.

## Capabilities

| Need | Tool family | What it helps with |
|---|---|---|
| Search China NBS indicators | `cnbs_search`, `cnbs_batch_search` | Find official indicators and latest values by keyword. |
| Fetch historical series | `cnbs_fetch_series`, `cnbs_quick_query` | Resolve dataset and indicator IDs, then fetch time series. |
| Compare regions or periods | `cnbs_compare` | Compare a metric across provinces, cities, or years. |
| Get a macro snapshot | `cnbs_economic_snapshot` | Pull GDP, CPI, PPI, PMI, unemployment, industry, trade, money supply, and more in one call. |
| Query international sources | `ext_world_bank*`, `ext_imf*`, `ext_oecd*`, `ext_bis*` | Access global macro, finance, trade, employment, and forecast data. |
| Check China census and departments | `ext_cn_census`, `ext_cn_department*` | Query census, fiscal, industry, agriculture, monetary, energy, housing, and other department statistics. |
| Cross-check sources | `ext_global_compare` | Compare World Bank and IMF values for the same country/indicator idea. |

## Quick start

```bash
npm ci
npm run build
node dist/index.js --host 127.0.0.1 --port 12345
```

The stateless Streamable HTTP endpoint accepts `POST /` and `POST /mcp`. Set `CNBS_MCP_SERVER_AUTH_TOKEN` or pass `--auth-token` to require a Bearer token. Request bodies are limited to 1 MB.

## MCP client configuration

Start the server first, then add it to any MCP client that supports Streamable HTTP:

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

If you enabled Bearer authentication, include the same token in the client configuration:

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

Published Docker images are available from GitHub Container Registry for `linux/amd64` and `linux/arm64`.

```bash
docker pull ghcr.io/eliseowzy/cnbs-mcp-server:1.1.0-beta.2
```

Run the published image:

```bash
docker run --rm \
  -p 12345:12345 \
  -e CNBS_MCP_SERVER_AUTH_TOKEN=your-token \
  -e LOG_LEVEL=info \
  -v "$PWD/logs:/app/logs" \
  ghcr.io/eliseowzy/cnbs-mcp-server:1.1.0-beta.2
```

The MCP endpoint is:

```text
http://127.0.0.1:12345/mcp
```

To build and run from source with Docker Compose:

```bash
docker compose up --build
```

To use the published image with Compose, override the service image:

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

Logs are emitted as structured JSON to stdout and daily rotating files under `./logs`. Configure `LOG_LEVEL` and `LOG_DIR` as needed.

## Design notes

This repository is also a map of how to build data tools for LLM agents:

| If you want to understand... | Read |
|---|---|
| How the service guides agents, normalizes noisy inputs, returns stable structured output, and handles semantic errors | [`docs/plans/agent-friendly-design.md`](docs/plans/agent-friendly-design.md) |
| How quick query compresses the NBS flow from search to indicator resolution to series fetch | [`docs/plans/quick-query-design.md`](docs/plans/quick-query-design.md) |
| How caching uses LRU, TTL, in-flight request deduplication, stale-while-revalidate, and a cache hub | [`docs/plans/cache-module-design.md`](docs/plans/cache-module-design.md) |
| How cache keys avoid collisions between metric, period, area, and external-source parameters | [`docs/plans/cache-key-design.md`](docs/plans/cache-key-design.md) |

Reading path: start with Quick start if you only want to run it; read the agent-friendly design if you want the core product thinking; read the cache docs if you are maintaining performance and upstream reliability.

## Development

```bash
npm run lint
npm test
npm run build
```

Use the `cnbs_get_guide` tool for the complete tool catalog and query workflows. The same guide content is maintained in `llms.txt` for LLM-oriented usage.
