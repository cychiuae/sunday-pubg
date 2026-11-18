import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const serverPort = Number(process.env.PORT ?? 8797);
// Dev client port. `npm run dev:office` uses 5174 so it can run next to a normal `npm run dev`.
const clientPort = Number(process.env.CLIENT_PORT ?? 5173);

export default defineConfig({
  server: {
    port: clientPort,
    strictPort: true,
    proxy: {
      '/ws': {
        target: `ws://localhost:${serverPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
    fs: {
      // Allow imports from anywhere in the repo (e.g. docs/design/balance.json).
      allow: [rootDir],
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'server/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    // Used by `npm run test:coverage` (v8 provider). Output in coverage/ (gitignored).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'server/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', 'server/tools/**', 'server/testClient.ts'],
    },
  },
});
