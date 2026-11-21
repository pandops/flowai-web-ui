import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { aliases, flowFixture, flowID } from "../fixtures/v0034-flow";
import { createFlowEntry, flowEditor, saveFlow } from "../fixtures/flow-editor";
import {
  MATRIX,
  expectNoHorizontalScroll,
  usePresentation,
} from "../fixtures/v0048-ui";

// web-ui: Web UI configures Flow failure retries and pending release (v0048).
// Behavior tests run at the supported desktop resolution (1440 x 900);
// the matrix tests below set each supported resolution themselves.
test.use({ actionTimeout: 10_000, viewport: { width: 1440, height: 900 } });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

const group = (editor: Locator) =>
  editor
    .locator("section,fieldset")
    .filter({
      has: editor.page().getByRole("heading", {
        name: "Retries and release",
        exact: true,
      }),
    })
    .last();
const detailValue = (page: Page, label: string) =>
  page
    .locator("div,tr")
    .filter({ has: page.locator("dt,th").getByText(label, { exact: true }) })
    .last();

test("v0048 Flow form saves retry and release settings · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { writes } = await flowFixture(page);

  await test.step("Operator creates a Flow with default retries", async () => {
    await page.goto(`${proxy.baseUrl}/?view=flows&team=1`);
    await createFlowEntry(page).click();
    const editor = flowEditor(page);
    const retries = group(editor);
    await expect(retries).toBeVisible();
    await expect(
      retries.getByLabel("Failure retries", { exact: true }),
    ).toHaveValue("3");
    for (const text of [
      "How many times a failed task is started again. 0 means no retry; 3 means up to 4 attempts.",
      "Time before a failed task is started again.",
      "How long a claimed task may wait in pending before the Executor releases it.",
      "Time before a released task returns to the end of its queue.",
      "Configuration errors (for example a missing image or a missing required launch parameter) are never retried; a release is not a failure and does not use a retry.",
    ])
      await expect(retries).toContainText(text);
    // The Agent field is gone.
    await expect(editor.getByLabel("Agent", { exact: true })).toHaveCount(0);
    await editor.getByLabel("Name", { exact: true }).fill("Retry flow");
    await editor
      .getByLabel("Executor tag", { exact: true })
      .selectOption("openhands");
    await editor
      .getByLabel("Model", { exact: true })
      .nth(0)
      .selectOption(aliases[0]);
    await editor
      .getByLabel("Prompt template", { exact: true })
      .fill("Work {{external_id}}");
    await saveFlow(editor).click();
    await expect(editor).not.toBeVisible();
    const create = writes.find((write) => write.path === "/ui/v1/flows");
    expect(create?.body).toMatchObject({
      failure_retry_count: 3,
      failure_retry_wait_seconds: 60,
      pending_limit_seconds: 900,
      release_delay_seconds: 300,
    });
    expect(create?.body).not.toHaveProperty("agent_id");
    await page.goto(`${proxy.baseUrl}/?view=flow&team=1&id=60`);
    await expect(detailValue(page, "Failure retries")).toContainText("3");
    await expect(detailValue(page, "Retry wait")).toContainText("1 min");
    await expect(detailValue(page, "Pending limit")).toContainText("15 min");
    await expect(detailValue(page, "Release delay")).toContainText("5 min");
    await expect(page.locator("main")).not.toContainText(/\bAgent\b/);
  });

  await test.step("Operator disables retries", async () => {
    await page.goto(`${proxy.baseUrl}/?view=flows&team=1&id=${flowID}`);
    const editor = flowEditor(page);
    await group(editor)
      .getByLabel("Failure retries", { exact: true })
      .fill("0");
    writes.length = 0;
    await saveFlow(editor).click();
    await expect(editor).not.toBeVisible();
    const put = writes.find((write) => write.path === `/ui/v1/flows/${flowID}`);
    expect(put?.etag).toBe('"1"');
    expect(put?.body).toMatchObject({ failure_retry_count: 0 });
    expect(put?.body).not.toHaveProperty("agent_id");
    await page.goto(`${proxy.baseUrl}/?view=flow&team=1&id=${flowID}`);
    await expect(detailValue(page, "Failure retries")).toContainText(
      "0 — failed tasks are not started again",
    );
  });

  await test.step("Operator enters an invalid wait", async () => {
    for (const [label, value] of [
      ["Failure retries", "-1"],
      ["Release delay", "0"],
    ]) {
      await page.goto(`${proxy.baseUrl}/?view=flows&team=1&id=${flowID}`);
      const editor = flowEditor(page);
      const field = group(editor).getByLabel(label, { exact: true });
      await field.fill(value);
      await field.blur();
      await expect(field, label).toHaveAttribute("aria-invalid", "true");
      await expect(group(editor).getByRole("alert")).toBeVisible();
      await expect(saveFlow(editor)).toBeDisabled();
      writes.length = 0;
      await saveFlow(editor)
        .click({ force: true })
        .catch(() => undefined);
      expect(writes, `${label} ${value} sends no request`).toEqual([]);
    }
  });
});

test("v0048 Flow form and Flow page at every supported resolution and theme · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await flowFixture(page);
  for (const { theme, width, height } of MATRIX)
    await test.step(`${theme} ${width}`, async () => {
      await usePresentation(page, theme, { width, height });
      await page.goto(`${proxy.baseUrl}/?view=flows&team=1&id=${flowID}`);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(group(flowEditor(page))).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto(`${proxy.baseUrl}/?view=flow&team=1&id=${flowID}`);
      await expect(detailValue(page, "Release delay")).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
});
