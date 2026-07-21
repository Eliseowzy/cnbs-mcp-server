import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { patchRegisterTool } from './common.js';
import { registerGuideTools } from './guide.js';
import { registerCnbsCoreTools } from './cnbs-core.js';
import { registerCnbsAuxTools } from './cnbs-aux.js';
import { registerWorldBankTools } from './world-bank.js';
import { registerImfTools } from './imf.js';
import { registerOecdTools } from './oecd.js';
import { registerBisTools } from './bis.js';
import { registerCnExtTools } from './cn-ext.js';
import { registerGlobalCompareTools } from './global-compare.js';

export { zStrId } from './common.js';

export function registerCnbsTools(server: McpServer) {
  patchRegisterTool(server);
  registerGuideTools(server);
  registerCnbsCoreTools(server);
  registerCnbsAuxTools(server);
  registerWorldBankTools(server);
  registerImfTools(server);
  registerOecdTools(server);
  registerBisTools(server);
  registerCnExtTools(server);
  registerGlobalCompareTools(server);
}
