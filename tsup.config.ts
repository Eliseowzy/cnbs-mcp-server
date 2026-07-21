import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: true,
  splitting: false,
  bundle: true,
  external: ['pino', 'pino-roll'],
  define: { __CNBS_VERSION__: JSON.stringify(version) },
  minify: true,
  shims: true,
  banner: {
    js: `import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);`,
  },
});
