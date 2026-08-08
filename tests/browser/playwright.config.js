const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const remoteBaseURL = process.env.OSI_QA_BASE_URL;
const localPort = process.env.OSI_QA_PORT || '4173';

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: ['issue-26.spec.js', 'i18n.spec.js', 'case-navigation.spec.js', 'lifecycle-flow.spec.js', 'profile.spec.js'],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: remoteBaseURL || `http://127.0.0.1:${localPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: remoteBaseURL ? undefined : {
    command: `node node_modules/http-server/bin/http-server . -p ${localPort} -a 127.0.0.1 -c-1 --silent`,
    cwd: path.resolve(__dirname, '../..'),
    url: `http://127.0.0.1:${localPort}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
