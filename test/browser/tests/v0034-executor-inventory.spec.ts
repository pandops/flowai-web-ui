import { captureDesignState } from "../fixtures/design-capture";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture } from "../fixtures/v0034-flow";

// Keep missing-control failures inside the teardown deadline.
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

// The readonly inventory fields are checked by the canonical Executor
// inventory states batch in v0034-executor-states.spec.ts.

test("v0034.5 Executor detail Back and reload preserve the exact supported inventory query", async ({
  page,
}) => {
  await flowFixture(page);
  const queries: URL[] = [];
  // executor-registry record and journal state of one busy Executor.
  const executor = {
    executor_id: 7004,
    team_id: 1,
    execution_tag: "selected",
    executor_type: "executor_docker_openhands",
    created_at: "2026-10-18T00:00:00Z",
    token_fingerprint: "ab".repeat(32),
    token_issued_at: "2026-10-18T00:00:00Z",
    reported_ip: null,
    ip_reported_at: null,
  };
  await page.route("**/ui/v1/teams/1/executor-states**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            executor_id: 7004,
            connection_state: "connected",
            connection_changed_at: "2026-10-18T00:00:05Z",
            held_claims: 1,
            max_parallel_tasks: 4,
            available_capacity: 3,
            reported_ip: null,
            ip_changed_at: null,
          },
        ],
      },
    }),
  );
  await page.route(/\/ui\/v1\/teams\/1\/executors(?:\?.*)?$/, (route) => {
    queries.push(new URL(route.request().url()));
    return route.fulfill({
      json: { items: [executor], next_cursor: null, total_count: 1 },
    });
  });
  await page.route(/\/ui\/v1\/teams\/1\/executors\/7004$/, (route) =>
    route.fulfill({ json: executor }),
  );
  for (const part of ["events", "tasks"])
    await page.route(`**/ui/v1/teams/1/executors/7004/${part}?**`, (route) =>
      route.fulfill({ json: { items: [], next_cursor: null } }),
    );
  const filters = { search: "selected", activity: "busy", limit: "25" };
  await page.goto(
    `${proxy.baseUrl}?view=executors&team=1&${new URLSearchParams(filters)}`,
  );
  const expectFilters = async () => {
    await expect(
      page.getByRole("textbox", { name: "Search", exact: true }),
    ).toHaveValue("selected");
    await expect(
      page.getByRole("combobox", { name: "Activity", exact: true }),
    ).toHaveValue("busy");
    await expect(
      page.getByRole("combobox", { name: "Rows per page", exact: true }),
    ).toHaveValue("25");
  };
  await expectFilters();
  const link = page
    .locator("#results")
    .getByRole("link", { name: String(executor.executor_id), exact: true });
  await link.click();
  await expect(
    page.getByRole("heading", { name: "Executor 7004", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/view=executors/);
  for (const [key, value] of Object.entries(filters))
    expect(new URL(page.url()).searchParams.get(key)).toBe(value);
  await expectFilters();
  await page.reload();
  await expectFilters();
  await expect(link).toBeVisible();
  // The filters run in the browser (D9): executor-registry is read with
  // only limit=200 and the issued cursor.
  expect(queries.length).toBeGreaterThanOrEqual(2);
  for (const query of queries)
    expect([...query.searchParams.entries()]).toEqual([["limit", "200"]]);
});

// Retained screenshots complement behavior assertions; they are not a full visual verdict.
test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});
