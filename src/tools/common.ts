import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CnbsErrorHandler } from '../services/error.js';
import { createLogger } from '../logger.js';
import { mcpToolCallsTotal, mcpToolDurationMs } from '../services/metrics.js';
import { z } from 'zod';

const log = createLogger('tools');

export const zStrId = z.union([z.string(), z.number()]).transform(String);
export const zUnknownObject = z.object({}).passthrough();
export const zUnknownArray = z.array(z.unknown());
export const zUnknownResult = z.union([zUnknownObject, zUnknownArray]);
export const zUnionResultsOutputSchema = {
  results: z.array(z.object({
    key: z.string(),
    data: zUnknownResult.optional(),
    error: z.string().optional(),
  }).strict()),
  count: z.number(),
};
export const zWrappedResultOutputSchema = {
  result: zUnknownResult,
};

export function toUnionResult(key: string, result: PromiseSettledResult<unknown>) {
  if (result.status === 'fulfilled') {
    return { key, data: result.value as object };
  }
  const reason = result.reason;
  return { key, error: reason instanceof Error ? reason.message : String(reason) };
}

export function createUnionResults(keys: string[], settled: PromiseSettledResult<unknown>[]) {
  const results = settled.map((result, index) => toUnionResult(keys[index], result));
  return { results, count: results.length };
}

export function createToolErrorResult(tool: string, error: unknown) {
  const { message, details } = CnbsErrorHandler.toToolErrorData(error, tool);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { error: { tool, ...details } },
  };
}

export function patchRegisterTool(server: McpServer) {
  const seenToolNames = new Set<string>();
  const originalRegisterTool = server.registerTool.bind(server);
  type RegisterArgs = Parameters<typeof originalRegisterTool>;
  server.registerTool = ((name: string, config: RegisterArgs[1], handler: RegisterArgs[2]) => {
    if (seenToolNames.has(name)) {
      log.warn({ tool: name }, 'Skipping duplicate MCP tool registration');
      return;
    }
    seenToolNames.add(name);
    const wrapped = (async (...args: unknown[]) => {
      const startedAt = Date.now();
      const call = handler as (...a: unknown[]) => Promise<{ isError?: boolean }>;
      try {
        const result = await call(...args);
        const ok = result?.isError !== true;
        const durationMs = Date.now() - startedAt;
        log.info({ tool: name, durationMs, ok }, ok ? 'Tool call completed' : 'Tool call failed');
        mcpToolCallsTotal.inc({ tool: name, ok: String(ok) });
        mcpToolDurationMs.observe({ tool: name }, durationMs);
        return result;
      } catch (error) {
        const result = createToolErrorResult(name, error);
        const durationMs = Date.now() - startedAt;
        log.info({ tool: name, durationMs, ok: false }, 'Tool call failed');
        mcpToolCallsTotal.inc({ tool: name, ok: 'false' });
        mcpToolDurationMs.observe({ tool: name }, durationMs);
        return result;
      }
    }) as unknown as RegisterArgs[2];
    return originalRegisterTool(name, config, wrapped);
  }) as typeof server.registerTool;
}
