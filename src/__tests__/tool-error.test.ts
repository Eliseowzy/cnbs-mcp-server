import { createToolErrorResult } from '../tools/common.js';

describe('tool error normalization', () => {
  it('converts thrown errors to structured MCP errors', () => {
    const result = createToolErrorResult('example', new Error('boom'));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.tool).toBe('example');
    expect(result.structuredContent.error.message).toContain('boom');
  });

  it('includes error type in structured content', () => {
    const result = createToolErrorResult('test_tool', new Error('validation failed'));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.type).toBeDefined();
  });
});
