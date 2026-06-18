import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Mirror the path aliases declared in tsconfig.json so unit tests can resolve
// `@/*` (src) and `shared/*` (generated TS types) imports the same way the app
// build does.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      shared: fileURLToPath(new URL('../../shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
