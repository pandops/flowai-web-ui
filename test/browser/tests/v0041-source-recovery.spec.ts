import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import {
  openSourceCommand,
  sourceOutcomeDialog,
} from "../fixtures/approved-dialogs";
import { flowFixture } from "../fixtures/v0034-flow";

// Survivor of task-sources-interface source-recovery.api.spec.ts (v0041 D15):
// the Web UI half of the unblock flow. Registry blocking, durability and
// next_poll_at scheduling are State Registry tests.
test.use({ actionTimeout: 10_000 });

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

test("v0013.11 / five independent failures block durably and version changes require manual unblock: unblock dialog", async ({
  page,
}) => {
  await flowFixture(page);
  const source: any = {
    source_id: 8027,
    team_id: 1,
    name: "event-source",
    revision: 3,
    mode: "poller",
    enabled: true,
    contract_version: "source.v1",
    implementation_version: "1",
    description: "",
    filter_summary: "",
    settings_status: "complete",
    health: "stale",
    last_seen_at: "2026-10-18T00:00:00Z",
    polling: {
      polling_blocked_at: "2026-10-18T00:01:00Z",
      consecutive_failures: 5,
      next_poll_at: null,
    },
    last_poll: null,
    webhook_url: null,
    intake_counts: {
      published: 5,
      rejected: 0,
      accepted: 0,
      deduplicated: 0,
      no_target: 0,
      failed: 5,
    },
  };
  const unblock = `/ui/v1/sources/${source.source_id}/unblock-polling`;
  const writes: { etag?: string; status?: number }[] = [];
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({ json: { items: [source], next_cursor: null } }),
  );
  await page.route(`**/ui/v1/sources/${source.source_id}`, (route) =>
    route.fulfill({
      json: source,
      headers: { etag: `"rev-${source.revision}"` },
    }),
  );
  await page.route(`**/ui/v1/sources/${source.source_id}/settings`, (route) =>
    route.fulfill({
      json: {
        source_id: source.source_id,
        mode: source.mode,
        revision: source.revision,
        settings_status: source.settings_status,
        fields: [],
        platform: {
          poll_url: "https://poller.example/tasks",
          poll_interval_minutes: 1,
          webhook_url: null,
        },
      },
      headers: { etag: `"rev-${source.revision}"` },
    }),
  );
  await page.route(`**${unblock}`, async (route) => {
    expect(route.request().method()).toBe("POST");
    const etag = route.request().headers()["if-match"];
    const write: { etag?: string; status?: number } = { etag };
    writes.push(write);
    if (etag !== `"rev-${source.revision}"`) {
      write.status = 412;
      return route.fulfill({
        status: 412,
        json: { code: "precondition_failed" },
      });
    }
    source.revision++;
    source.polling = {
      polling_blocked_at: null,
      consecutive_failures: 0,
      next_poll_at: "2026-10-18T00:03:00Z",
    };
    write.status = 200;
    return route.fulfill({
      json: source,
      headers: { etag: `"rev-${source.revision}"` },
    });
  });

  await page.goto(
    `${proxy.baseUrl}/?view=source&id=${source.source_id}&team=1`,
  );
  // Approved blocked poller detail: read-only, recovery is in Sources.
  await expect(page.locator("#source-detail")).toContainText(
    "Five consecutive failures stopped polling.",
  );
  await expect(
    page
      .locator("main")
      .getByRole("button", { name: "Unblock polling", exact: true }),
  ).toHaveCount(0);
  await page.goto(`${proxy.baseUrl}/?view=sources&team=1`);
  await expect(page.locator("[data-source-notices]")).toContainText(
    "stopped after five failures",
  );
  const open = async () => {
    await openSourceCommand(page, "event-source", "Unblock polling");
    await expect(page.getByRole("dialog")).toBeVisible();
  };
  await open();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await open();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(writes).toHaveLength(0);

  await open();
  // A version change lands while the dialog holds revision 3.
  source.revision = 4;
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unblock polling", exact: true })
    .click();
  const failed = sourceOutcomeDialog(
    page,
    "poller-unblock-failure",
    "event-source",
  );
  await expect(failed.getByRole("alert")).toContainText(
    "The Source remains blocked",
  );
  // The stale dialog cannot retry; reload precedes a new attempt.
  await expect(
    failed.getByRole("button", { name: "Unblock polling", exact: true }),
  ).toHaveCount(0);
  await failed
    .getByRole("button", { name: /^(Cancel|Close)$/ })
    .first()
    .click();
  await expect(failed).toHaveCount(0);
  expect(writes).toEqual([{ etag: '"rev-3"', status: 412 }]);

  await page.reload();
  await open();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unblock polling", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page
      .locator("#source-results")
      .getByRole("link", { name: "event-source", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#source-results")).not.toContainText(
    "Polling blocked",
  );
  await expect(page.locator("[data-source-notices]")).not.toContainText(
    "stopped after five failures",
  );
  expect(writes).toEqual([
    { etag: '"rev-3"', status: 412 },
    { etag: '"rev-4"', status: 200 },
  ]);
});
