import type { Locator, Page } from "@playwright/test";

// v0034 approved Source registration (ui-mockups/source-create.html and
// source-key.html): the "Create source" link opens a standalone three-step
// page titled "Register source"; step 3 is the "Source key" page whose
// one-time key region is headed "One-time key for <name>". Cancel is a link
// back to Sources. Key results of rotation stay dialogs.
export const createSourceEntry = (page: Page): Locator =>
  page.getByRole("link", { name: "Create source", exact: true });
export const sourceWizard = (page: Page): Locator =>
  page.locator("main").filter({
    has: page.getByRole("heading", {
      name: "Register source",
      level: 1,
      exact: true,
    }),
  });
export const sourceKeyPage = (page: Page, name?: string | RegExp): Locator =>
  page.locator("main").filter({
    has: page.getByRole("heading", {
      name: name ?? /^One-time key for /,
      ...(typeof name === "string" ? { exact: true } : {}),
    }),
  });
export const cancelSourceWizard = (wizard: Locator): Locator =>
  wizard.getByRole("link", { name: "Cancel", exact: true });
