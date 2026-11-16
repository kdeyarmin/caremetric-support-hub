import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

// Vitest resolves an extensionless relative import; the production image runs plain Node, which does not. Load every module
// server/main.mjs imports (and so the src/ protocol files they share with the browser) the way the image does, without starting
// the server itself.
describe('server modules under plain Node', () => {
  it('resolve every import the runtime image will load', async () => {
    const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
    const modules = [...new Set([...main.matchAll(/from '(\.\/[^']+\.mjs)'/g)].map(match => match[1]))];
    expect(modules.length).toBeGreaterThan(20);
    const script = `for (const path of ${JSON.stringify(modules)}) await import(new URL(path, ${JSON.stringify(new URL('./', import.meta.url).href)}).href); console.log('loaded');`;
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { timeout: 30000 });
    expect(stdout.trim().split('\n').at(-1)).toBe('loaded');
  }, 40000);
});
