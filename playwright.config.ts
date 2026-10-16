import { defineConfig } from '@playwright/test';

// Browser tests drive the real client against the real Worker + Durable Objects
// (workerd via `wrangler dev`). Set E2E_BASE_URL to point at a deployed site
// instead (e.g. the preview), in which case no local server is started.
const PORT = Number(process.env.E2E_PORT ?? 8788);
const remote = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './e2e',
  // A full game takes ~1.5 min of wall-clock even with short round timers
  timeout: 4 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: remote ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  // `@stress` tests only run via `npm run e2e:stress`
  grepInvert: process.env.E2E_STRESS ? undefined : /@stress/,
  grep: process.env.E2E_STRESS ? /@stress/ : undefined,
  webServer: remote
    ? undefined
    : {
        command: `npm run build:client && npx wrangler dev --port ${PORT} --ip 127.0.0.1`,
        url: `http://127.0.0.1:${PORT}/api/health`,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'ignore',
      },
});
