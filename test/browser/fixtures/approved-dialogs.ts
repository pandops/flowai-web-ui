import type { Locator, Page } from "@playwright/test";

// Accessible names of approved dialogs, taken from the mockups' labelled
// headings (ui-mockups/*.html dialog states). The title carries the resource
// and, after submission, the outcome; tests address dialogs by these titles.
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export type SourceMode = "poller" | "webhook";
const sourceTitles = {
  "Rotate key": "Rotate key",
  "Disable source": "Disable source",
  "Unblock polling": "Unblock polling",
  "Update version": "Update implementation",
} as const;
export type SourceCommand = keyof typeof sourceTitles;
export const sourceDialog = (
  page: Page,
  command: SourceCommand,
  name: string,
  mode?: SourceMode,
): Locator =>
  page.getByRole("dialog", {
    name: new RegExp(
      `^${escape(sourceTitles[command])} · ${escape(name)} \\(${mode ?? "(?:poller|webhook)"}\\)$`,
    ),
  });
// Source administration commands live in the Sources catalog record's
// "Actions for <name>" menu (ui-mockups/sources.html); Source detail is
// read-only. The trigger is where focus returns when a command dialog closes.
export const sourceActionsTrigger = (page: Page, name: string): Locator =>
  page
    .locator("#source-results")
    .getByRole("button", { name: `Actions for ${name}`, exact: true });
export const openSourceCommand = async (
  page: Page,
  name: string,
  command: SourceCommand,
): Promise<Locator> => {
  const trigger = sourceActionsTrigger(page, name);
  await trigger.click();
  await page
    .getByRole("menu", { name: `Actions for ${name}`, exact: true })
    .getByRole("menuitem", { name: command, exact: true })
    .click();
  return trigger;
};
// Outcome titles shown after a source command was submitted.
export const sourceOutcomeTitle = {
  "poller-unblock-pending": "Unblock polling pending",
  "poller-unblock-failure": "Unblock polling failed",
  "source-version-412": "Source revision changed",
  "source-version-conflict": "Unfinished poll",
} as const;
export const sourceOutcomeDialog = (
  page: Page,
  outcome: keyof typeof sourceOutcomeTitle,
  name: string,
): Locator =>
  page.getByRole("dialog", {
    name: `${sourceOutcomeTitle[outcome]} · ${name}`,
    exact: true,
  });
// One-time key result of rotation or implementation update.
export const newKeyDialog = (page: Page, name?: string): Locator =>
  page.getByRole("dialog", {
    name: name ? `New key · ${name}` : /^New key · /,
    ...(name ? { exact: true } : {}),
  });
export const cancelTaskDialog = (
  page: Page,
  phase: "confirm" | "pending" | "failure" = "confirm",
): Locator =>
  page.getByRole("dialog", {
    name:
      phase === "confirm"
        ? "Cancel task"
        : phase === "pending"
          ? "Cancel task request pending"
          : "Cancel task request failed",
    exact: true,
  });
// Cancel-task dialog in any phase (its title follows the request outcome).
export const anyCancelTaskDialog = (page: Page): Locator =>
  page.getByRole("dialog", {
    name: /^Cancel task(?: request (?:pending|failed))?$/,
  });
export const modelDialog = (
  page: Page,
  operation: "Pause" | "Resume" | "Archive" | "Unarchive",
  name: string,
): Locator =>
  page.getByRole("dialog", { name: `${operation} model ${name}`, exact: true });
