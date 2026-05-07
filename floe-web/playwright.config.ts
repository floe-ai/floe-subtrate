import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://127.0.0.1:5378",
    headless: true,
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } }
  ],
  webServer: {
    command: "npm run preview",
    url: "http://127.0.0.1:5378",
    reuseExistingServer: true,
    timeout: 15_000
  }
});
