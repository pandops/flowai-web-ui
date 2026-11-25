module.exports = {
  globalSetup: "./fixtures/owned-browser-setup.ts",
  testDir: "./tests",
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  // Preserve baseline case isolation while scheduling one worker on the hosted VM.
  fullyParallel: true,
  forbidOnly: true,
  timeout: 30_000,
  outputDir: "test-results",
  preserveOutput: "always",
  use: {
    // A missing element fails as an ordinary error instead of holding the
    // body past its test timeout, which would block the shared group.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Recording every passing case costs CPU on every worker; failures keep
    // their trace.
    trace: "retain-on-failure",
    video: "off",
    // The mocked registry computes calendar periods in UTC; the browser uses
    // the same zone so dates near midnight fall in the same day and week.
    timezoneId: "UTC",
    viewport: { width: 1440, height: 900 },
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/results.json" }],
  ],
};
