import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { startFakeGateway, type FakeGateway } from "../fixtures/fake_gateway";

let proxy: MockedProxy;
let registry: FakeGateway;
let initial: Pick<FakeGateway, "tasks" | "launchParameters">;

test.beforeAll(async () => {
  registry = await startFakeGateway();
  initial = structuredClone({
    tasks: registry.tasks,
    launchParameters: registry.launchParameters,
  });
  proxy = await startMockedProxy(
    [{ team_id: 1, team_name: "alpha" }],
    path.resolve(__dirname, "../../../web/index.html"),
    registry.origin,
  );
});
test.afterAll(async () => {
  // Stopping the Web UI container can outlast the default hook budget on a
  // loaded host; the start already gets the same allowance.
  test.setTimeout(120_000);
  await proxy.close();
  await registry.close();
});

// One test, one step per original check. Every step restores the mocked
// Registry's tasks and launch parameters, starts from a blank document at
// the default viewport and removes its own routes, so no step depends on
// another step's writes or order.
async function isolatedStep(
  page: import("@playwright/test").Page,
  viewport: { width: number; height: number },
  title: string,
  body: () => Promise<void>,
) {
  await test.step(title, async () => {
    registry.tasks.splice(0, Infinity, ...structuredClone(initial.tasks));
    registry.launchParameters.splice(
      0,
      Infinity,
      ...structuredClone(initial.launchParameters),
    );
    await page.goto("about:blank");
    await page.setViewportSize(viewport);
    try {
      await body();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
}

test("v0006.12/.13/.14/.15 state runtime UI: launch parameters, parameter history, cancellation and live log", async ({
  page,
}) => {
  // Four original cases, each with its own page loads.
  test.setTimeout(120_000);
  const viewport = page.viewportSize()!;
  await isolatedStep(
    page,
    viewport,
    "v0006.13 exposes immutable parameter history without secret plaintext",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=parameters`);
      await page
        .getByRole("button", {
          name: "Actions for FLOWAI_VISIBLE",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", { name: "Change history", exact: true })
        .click();
      await expect(page.locator("#history-dialog")).toContainText("Revision 2");
      await expect(page.locator("#history-dialog")).not.toContainText(
        "fixture-secret",
      );
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.15 appends live work and agent-published reasoning without log controls",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=history&search=external-3`);
      await page.getByRole("link", { name: "alpha-3", exact: true }).click();
      await expect(page.getByText("Inspecting the workspace")).toBeVisible();
      // A journal frame: frame_id is the stored log entry's event_id.
      registry.push(1, {
        frame_id: 7027,
        frame_type: "task_log",
        team_id: 1,
        task_id: 3,
        data: {
          event_id: 7027,
          task_id: 3,
          attempt: 1,
          claim_seq: 1,
          executor_id: 7,
          log_offset: 3,
          stream: "work",
          text: "New container output",
          publisher_seq: 7027,
          occurred_at: new Date().toISOString(),
        },
      });
      await expect(
        page
          .locator("[data-log]")
          .getByText("New container output", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /clear|pause|connect|follow/i }),
      ).toHaveCount(0);
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.14 disables cancellation after request and keeps it beside status",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=history&search=external-3`);
      await page.getByRole("link", { name: "alpha-3", exact: true }).click();
      const cancel = page.locator("[data-cancel]");
      await expect(cancel).toBeVisible();
      await cancel.click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Cancel task" })
        .click();
      await expect(cancel).toBeDisabled();
      await expect(cancel).toHaveText("Cancellation requested");
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.12 manages team and flow launch parameters without task scope",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=parameters`);
      await expect(
        page.getByRole("heading", { name: "Parameters", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "General", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Create parameter", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Add variable", exact: true })
        .click();
      await page.getByLabel("Variable scope").selectOption("flow");
      await page
        .locator("#env-dialog select[name='flow_id']")
        .selectOption("1");
      await page
        .locator("#env-dialog")
        .getByLabel("Key name", { exact: true })
        .fill("NEW_ENV_KEY");
      await page
        .locator("#env-dialog")
        .getByLabel("Value", { exact: true })
        .fill("new-value");
      await page
        .getByRole("button", { name: "Save variable", exact: true })
        .click();
      const entry = page
        .locator("#definitions tr:visible,#definitions article:visible")
        .filter({
          has: page.getByRole("link", { name: "NEW_ENV_KEY", exact: true }),
        });
      await expect(entry).toContainText("new-value");
      await expect(entry).toContainText("Flow");
      await expect(
        page.getByLabel("Variable scope").locator("option"),
      ).toHaveText(["Team", "Flow"]);
    },
  );
});
