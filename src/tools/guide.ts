import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LLMS_TXT_CONTENT } from './guide-content.js';

export function registerGuideTools(server: McpServer) {


  server.registerTool(
    'cnbs_get_guide',
    {
      title: 'Get CNBS MCP Guide',
      description: '获取本 MCP 服务器的使用指南，包括工具列表、使用建议和重要提示。建议首次使用时调用此工具了解如何正确使用其他工具。',
      inputSchema: z.object({}).strict(),
      outputSchema: {
        guide: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      return {
        content: [{ type: 'text', text: LLMS_TXT_CONTENT }],
        structuredContent: { guide: LLMS_TXT_CONTENT },
      };
    }
  );
}
