const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const remoteBaseURL = process.env.OSI_QA_BASE_URL;

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: 'issue-26.spec.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: remoteBaseURL || 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: remoteBaseURL ? undefined : {
    command: 'npx --yes http-server@14.1.1 . -p 4173 -c-1',
    cwd: path.resolve(__dirname, '../..'),
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
