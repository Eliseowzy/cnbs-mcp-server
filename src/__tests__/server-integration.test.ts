import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCnbsServer } from '../server';

describe('Server Integration', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll((done) => {
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      const isMcpPath = url.pathname === '/' || url.pathname === '/mcp';
      if (!isMcpPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null }));
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not allowed' }, id: null }));
        return;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcpServer = createCnbsServer();
      res.on('close', () => {
        transport.close().catch(() => {});
        mcpServer.close().catch(() => {});
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  async function mcpRequest(method: string, params?: unknown, id: number = 1) {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
    });
    return response;
  }

  async function parseMcpResponse(res: Response): Promise<any> {
    const contentType = res.headers.get('content-type') || '';
    const text = await res.text();
    
    if (contentType.includes('text/event-stream')) {
      // Parse SSE format: "event: message\ndata: {...}\n\n"
      const dataMatch = text.match(/data: (.+)/);
      if (dataMatch) {
        return JSON.parse(dataMatch[1]);
      }
      throw new Error('No data found in SSE response');
    }
    return JSON.parse(text);
  }

  describe('MCP protocol', () => {
    it('should respond to initialize request', async () => {
      const res = await mcpRequest('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      });
      expect(res.status).toBe(200);
      const data = await parseMcpResponse(res);
      expect(data.result).toBeDefined();
      expect(data.result.serverInfo.name).toBe('cnbs-mcp-server');
    });

    it('should list tools', async () => {
      const res = await mcpRequest('tools/list', {});
      expect(res.status).toBe(200);
      const data = await parseMcpResponse(res);
      expect(data.result.tools).toBeDefined();
      expect(Array.isArray(data.result.tools)).toBe(true);
      expect(data.result.tools.length).toBeGreaterThan(0);

      const toolNames = data.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('cnbs_search');
      expect(toolNames).toContain('cnbs_get_guide');
    });

    it('should call cnbs_get_guide tool', async () => {
      const res = await mcpRequest('tools/call', {
        name: 'cnbs_get_guide',
        arguments: {},
      });
      expect(res.status).toBe(200);
      const data = await parseMcpResponse(res);
      expect(data.result).toBeDefined();
      expect(data.result.content).toBeDefined();
      expect(data.result.content.length).toBeGreaterThan(0);
    });
  });

  describe('HTTP edge cases', () => {
    it('should return 404 for unknown paths', async () => {
      const res = await fetch(`${baseUrl}/unknown`);
      expect(res.status).toBe(404);
    });

    it('should return 405 for GET on /mcp', async () => {
      const res = await fetch(`${baseUrl}/mcp`);
      expect(res.status).toBe(405);
    });

    it('should handle health check', async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.status).toBe('ok');
    });
  });
});
