import { defineConfig } from '@playwright/test';

declare const process: {
  cwd(): string;
  env: Record<string, string | undefined>;
};

const testPath = [
  `${process.cwd()}/.playwright-bin`,
  process.env.PATH ?? '',
].join(':');

const skipWebServer = process.env.PLAYWRIGHT_SKIP_WEBSERVER === '1';
const backendHost = process.env.PLAYWRIGHT_BACKEND_HOST ?? '127.0.0.1';
const backendPort = process.env.PLAYWRIGHT_BACKEND_PORT ?? '4100';
const frontendHost = process.env.PLAYWRIGHT_FRONTEND_HOST ?? '127.0.0.1';
const frontendPort = process.env.PLAYWRIGHT_FRONTEND_PORT ?? '3100';
const baseURL =
  process.env.PLAYWRIGHT_BASE_URL ??
  `http://${frontendHost}:${frontendPort}`;
const backendBaseUrl = `http://${backendHost}:${backendPort}`;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL,
    headless: true,
  },
  webServer: skipWebServer
    ? undefined
    : [
        {
          command:
            'pnpm --filter shared build && pnpm --filter server exec tsx watch src/index.ts',
          env: {
            ...process.env,
            PATH: testPath,
            PLAYWRIGHT_USE_MOCK_COPILOT: '1',
            HOST: backendHost,
            PORT: backendPort,
          },
          url: `${backendBaseUrl}/api/health`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command:
            `pnpm --filter shared build && pnpm --filter web exec vite --host ${frontendHost} --port ${frontendPort}`,
          env: {
            ...process.env,
            PATH: testPath,
            VITE_BACKEND_URL: backendBaseUrl,
          },
          url: `http://${frontendHost}:${frontendPort}`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ],
});
