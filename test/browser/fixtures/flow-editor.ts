import type { Locator, Page } from "@playwright/test";

// v0034 approved Flow editor contract (ui-mockups/flow-create.html): a
// standalone page titled "Flow editor" with one "Save flow" submit, opened by
// the "Create flow" link on Flows or an explicit "Edit flow" command.
export const flowEditor = (page: Page): Locator =>
  page.locator("main").filter({
    has: page.getByRole("heading", {
      name: "Flow editor",
      level: 1,
      exact: true,
    }),
  });
export const createFlowEntry = (page: Page): Locator =>
  page.getByRole("link", { name: "Create flow", exact: true });
export const saveFlow = (editor: Locator): Locator =>
  editor.getByRole("button", { name: "Save flow", exact: true });
// Cancel leaves the page back to Flows without saving.
export const cancelFlow = (editor: Locator): Locator =>
  editor.getByRole("link", { name: "Cancel", exact: true });
