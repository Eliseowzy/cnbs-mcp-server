import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LLMS_TXT_CONTENT } from '../tools/guide-content.js';

describe('guide synchronization', () => {
  it('keeps llms.txt identical to the runtime guide', () => {
    const file = readFileSync(path.resolve(process.cwd(), 'llms.txt'), 'utf8');
    expect(file).toBe(`${LLMS_TXT_CONTENT}\n`);
  });
});
