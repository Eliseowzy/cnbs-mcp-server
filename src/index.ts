#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Command } from 'commander';
import { logger } from './logger.js';
import { createCnbsServer } from './server.js';
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDurationMs,
  startMetricsCollection,
} from './services/metrics.js';

const MAX_BODY_SIZE = 1024 * 1024;
const corsHeaders = {
  'Access-Control-Allow-Origin': process.env.CNBS_CORS_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version',
};

class BodyTooLargeError extends Error {}

function checkAuth(authToken: string | undefined, authHeader: string | undefined) {
  if (!authToken) return { authorized: true };
  const match = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (!match) return { authorized: false, error: 'Missing or invalid Authorization header' };
  const expected = Buffer.from(authToken);
  const actual = Buffer.from(match[1]);
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? { authorized: true }
    : { authorized: false, error: 'Invalid token' };
}

async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_SIZE): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError('Request body exceeds 1MB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendError(res: http.ServerResponse, status: number, code: number, message: string) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function launchCnbsServer() {
  const program = new Command()
    .option('-p, --port <port>', 'Port to listen on for HTTP mode', '12345')
    .option('-H, --host <host>', 'Host to listen on for HTTP mode', '127.0.0.1')
    .option('-a, --auth-token <token>', 'Authorization token (or CNBS_MCP_SERVER_AUTH_TOKEN)')
    .parse();
  const options = program.opts<{ port: string; host: string; authToken?: string }>();
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${options.port}`);
  const authToken = options.authToken || process.env.CNBS_MCP_SERVER_AUTH_TOKEN;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const startTime = Date.now();

    // Track HTTP metrics on response finish
    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const path = url.pathname === '/' || url.pathname === '/mcp' ? '/mcp' : url.pathname;
      httpRequestsTotal.inc({ path, method: req.method || 'UNKNOWN', status: String(res.statusCode) });
      httpRequestDurationMs.observe({ path, method: req.method || 'UNKNOWN' }, durationMs);
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    // Prometheus metrics endpoint (auth controlled by CNBS_METRICS_PUBLIC env var)
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const metricsPublic = process.env.CNBS_METRICS_PUBLIC === 'true';
      if (!metricsPublic) {
        const metricsAuth = checkAuth(authToken, req.headers.authorization);
        if (!metricsAuth.authorized) {
          sendError(res, 401, -32600, `Authentication failed: ${metricsAuth.error}`);
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': metricsRegistry.contentType, ...corsHeaders });
      res.end(await metricsRegistry.metrics());
      return;
    }
    const auth = checkAuth(authToken, req.headers.authorization);
    if (!auth.authorized) {
      sendError(res, 401, -32600, `Authentication failed: ${auth.error}`);
      return;
    }
    const isMcpPath = url.pathname === '/' || url.pathname === '/mcp';
    if (!isMcpPath) {
      sendError(res, 404, -32601, 'Method not found. Use POST / or POST /mcp.');
      return;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, -32601, 'Method not allowed. Stateless MCP supports POST only.');
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) sendError(res, 413, -32600, err.message);
      else sendError(res, 400, -32700, 'Parse error: Invalid JSON');
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createCnbsServer();
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([transport.close(), mcpServer.close()]);
    };
    res.on('close', () => void close());
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      logger.error({ err }, 'MCP request failed');
      if (!res.headersSent) sendError(res, 500, -32603, 'Internal server error');
      await close();
    }
  });

  server.on('listening', () => {
    logger.info({ host: options.host, port, auth: !!authToken }, 'CNBS MCP server running');
    startMetricsCollection();
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ err, port }, err.code === 'EADDRINUSE' ? 'Port is already in use' : 'HTTP server error');
  });
  server.listen(port, options.host);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const fallback = setTimeout(() => process.exit(0), 1000).unref();
    server.close(() => {
      clearTimeout(fallback);
      logger.flush(() => process.exit(0));
    });
    server.closeAllConnections();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

launchCnbsServer().catch((err) => {
  logger.fatal({ err }, 'Failed to launch CNBS server');
  logger.flush(() => process.exit(1));
  setTimeout(() => process.exit(1), 1000).unref();
});
