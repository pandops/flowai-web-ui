import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  MATRIX,
  TEAM,
  TEAM_NAME,
  at,
  captureStreams,
  catalogRoutes,
  event,
  executorRecord,
  executorRoutes,
  expectNoHorizontalScroll,
  recordRequests,
  summary,
  taskRecord,
  usePresentation,
  v0048Proxy,
  type ExecutorFake,
} from "../fixtures/v0048-ui";

// web-ui: Web UI renders Executor inventory and detail (v0048).
// Behavior tests run at the supported desktop resolution (1440 x 900);
// the matrix tests below set each supported resolution themselves.
test.use({ actionTimeout: 10_000, viewport: { width: 1440, height: 900 } });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

// executor-registry holds records 7, 8 and 12; journal holds a state for 7
// and one for 99, which has no record and must not be shown.
function fake(): ExecutorFake {
  return {
    records: [
      executorRecord(7, {
        reported_ip: "192.0.2.10",
        ip_reported_at: at(220),
      }),
      executorRecord(8, {
        executor_type: "executor_k8s_openhands",
        execution_tag: "gpu",
        reported_ip: "10.42.0.17",
        ip_reported_at: at(223),
      }),
      executorRecord(12),
    ],
    states: [
      {
        executor_id: 7,
        connection_state: "connected",
        connection_changed_at: at(218),
        held_claims: 2,
        max_parallel_tasks: 3,
        available_capacity: 1,
        reported_ip: "192.0.2.10",
        ip_changed_at: at(220),
      },
      {
        executor_id: 99,
        connection_state: "connected",
        connection_changed_at: at(218),
        held_claims: 0,
        max_parallel_tasks: 1,
        available_capacity: 1,
        reported_ip: "198.51.100.99",
        ip_changed_at: at(218),
      },
    ],
    events: new Map([
      [
        7,
        [
          event("connection_lost", 200, { executor_id: 7 }),
          event("connection_restored", 210, { executor_id: 7 }),
          event(
            "executor_status",
            211,
            { executor_id: 7 },
            {
              connection_state: "connected",
              max_parallel_tasks: 3,
              held_claims: 2,
              available_capacity: 1,
            },
          ),
        ],
      ],
      [
        8,
        [
          event(
            "ip_changed",
            120,
            { executor_id: 8 },
            {
              old_ip: null,
              new_ip: "10.42.0.9",
            },
          ),
          event(
            "ip_changed",
            178,
            { executor_id: 8 },
            {
              old_ip: "10.42.0.9",
              new_ip: "10.42.0.17",
            },
          ),
        ],
      ],
    ]),
    tasks: new Map([
      [7, [summary(taskRecord(1010)), summary(taskRecord(1004))]],
    ]),
  };
}

const results = (page: Page) => page.locator("#results");
function row(page: Page, id: number): Locator {
  return results(page)
    .locator("tr:visible,article:visible")
    .filter({
      has: page.getByRole("link", { name: String(id), exact: true }),
    });
}
const detailRow = (page: Page, label: string) =>
  results(page)
    .locator("div:visible,tr:visible")
    .filter({
      has: page.locator("dt,th").getByText(label, { exact: true }),
    })
    .last();

async function openInventory(page: Page, executors = fake()) {
  await catalogRoutes(page);
  await executorRoutes(page, executors);
  const requests = recordRequests(page);
  await page.goto(`${proxy.baseUrl}/?view=executors&team=${TEAM}`);
  await expect(row(page, 7)).toBeVisible();
  return { executors, requests };
}

test("v0048 Executor inventory merges records with journal states and links integer IDs · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { requests } = await openInventory(page);

  await test.step("Inventory merges records with states", async () => {
    // Two Gateway reads, merged in the browser by executor_id.
    const paths = requests.map((request) => request.path);
    expect(paths).toContain(`/ui/v1/teams/${TEAM}/executors`);
    expect(paths).toContain(`/ui/v1/teams/${TEAM}/executor-states`);
    const seven = row(page, 7);
    await expect(seven.getByText("Connected", { exact: true })).toBeVisible();
    await expect(seven.locator(`time[datetime="${at(218)}"]`)).toHaveCount(1);
    await expect(seven.getByText("192.0.2.10", { exact: true })).toBeVisible();
    await expect(seven.getByText("2 claims", { exact: true })).toBeVisible();
    await expect(seven.getByText("1", { exact: true })).toBeVisible();
    const eight = row(page, 8);
    await expect(
      eight.getByText("Never connected", { exact: true }),
    ).toBeVisible();
    // No state entry: no activity, capacity or IP, even though the record
    // carries one (the inventory shows journal's reported IP).
    await expect(eight).not.toContainText("10.42.0.17");
    await expect(eight).not.toContainText("claim");
    await expect(eight.getByText("—", { exact: true }).first()).toBeVisible();
    await expect(row(page, 12)).toBeVisible();
    // A state entry without a record is not shown.
    await expect(row(page, 99)).toHaveCount(0);
    await expect(results(page)).not.toContainText("198.51.100.99");
  });

  await test.step("Executor ID is rendered as an integer", async () => {
    const link = results(page).getByRole("link", { name: "7", exact: true });
    await expect(link).toHaveAttribute(
      "href",
      `?view=executor&team=${TEAM}&id=7`,
    );
    // Only the approved columns, with Reported IP right after Connection.
    const headers = (
      await results(page).locator("th:visible").allInnerTexts()
    ).map((text) => text.trim().toLowerCase());
    if (headers.length)
      expect(headers).toEqual([
        "executor",
        "type",
        "tag",
        "connection",
        "reported ip",
        "activity",
        "available",
      ]);
    await expect(results(page)).not.toContainText(
      /[0-9a-f]{8}-[0-9a-f]{4}-|scope|system|token|team_id/i,
    );
  });

  await test.step("Operator opens an Executor from the inventory", async () => {
    await results(page).getByRole("link", { name: "7", exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=executor&team=3&id=7(&|$)/);
    await expect(
      page.getByRole("heading", { name: "Executor 7", exact: true }),
    ).toBeVisible();
    for (const [label, value] of [
      ["ID", "7"],
      ["Type", "executor_docker_openhands"],
      ["Tag", "openhands"],
      ["Reported IP", "192.0.2.10"],
      ["Activity", "2 claims"],
      ["Available", "1"],
    ])
      await expect(detailRow(page, label)).toContainText(value);
    await expect(detailRow(page, "Connection")).toContainText("Connected");
    // Its events and the tasks it claims, each linking back to task detail.
    const events = page.getByRole("region", { name: "Executor events" });
    await expect(events).toContainText("connection_lost");
    await expect(events).toContainText("connection_restored");
    for (const id of [1010, 1004])
      await expect(
        // v0050: the claimed task's link is its task name.
        results(page).getByRole("link", {
          name: `${TEAM_NAME}-${id}`,
          exact: true,
        }),
      ).toHaveAttribute("href", `?view=task&team=${TEAM}&id=${id}`);
    expect(
      requests.some(
        (request) => request.path === `/ui/v1/teams/${TEAM}/executors/7/tasks`,
      ),
    ).toBe(true);
    await expect(results(page)).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  await test.step("Inventory and detail at every supported resolution and theme", async () => {
    for (const { theme, width, height } of MATRIX) {
      for (const route of ["view=executors", "view=executor&id=7"]) {
        await usePresentation(page, theme, { width, height });
        await page.goto(`${proxy.baseUrl}/?${route}&team=${TEAM}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(
          route === "view=executors"
            ? results(page).getByRole("link", { name: "7", exact: true })
            : page.getByRole("heading", { name: "Executor 7", exact: true }),
        ).toBeVisible();
        // Monospace at the mockup's sizes: the Executor ID link on the
        // inventory at 14px (owner, 2026-11-13); the task external ID on
        // detail is plain mono text since v0050, 13px as in the approved
        // v0050 executor-detail mockup.
        const mono =
          route === "view=executors"
            ? results(page).getByRole("link", { name: "7", exact: true })
            : results(page).getByText("invoice-1010", { exact: true }).first();
        expect
          .soft(
            await mono.evaluate((node) => {
              const value = getComputedStyle(node);
              return { family: value.fontFamily, size: value.fontSize };
            }),
          )
          .toEqual({
            family: '"SF Mono", ui-monospace, Menlo, monospace',
            size: route === "view=executors" ? "14px" : "13px",
          });
        await expectNoHorizontalScroll(page);
      }
    }
  });
});

test("v0048 Executor detail shows the reported IP and its history · Web UI unit", async ({
  page,
}) => {
  await openInventory(page);

  await test.step("Detail shows the reported IP and its changes", async () => {
    await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=8`);
    await expect(
      page.getByRole("heading", { name: "Executor 8", exact: true }),
    ).toBeVisible();
    const ip = detailRow(page, "Reported IP");
    await expect(ip).toContainText("10.42.0.17");
    await expect(ip).toContainText("Reported by the Executor");
    await expect(ip.locator(`time[datetime="${at(223)}"]`)).toHaveCount(1);
    // Information only: never a link or connection target.
    await expect(ip.getByRole("link")).toHaveCount(0);
    const history = page.getByRole("region", { name: "Executor events" });
    const first = history.getByText("IP reported: 10.42.0.9");
    const second = history.getByText("IP changed from 10.42.0.9 to 10.42.0.17");
    await expect(first).toBeVisible();
    await expect(second).toBeVisible();
    await expect(history.locator(`time[datetime="${at(178)}"]`)).toHaveCount(1);
    // Time order: the first report comes before the change.
    const text = await history.innerText();
    expect(text.indexOf("IP reported: 10.42.0.9")).toBeLessThan(
      text.indexOf("IP changed from 10.42.0.9 to 10.42.0.17"),
    );
    await expect(history.getByRole("link")).toHaveCount(0);
  });

  await test.step("Executor that never reported an IP", async () => {
    await page.goto(`${proxy.baseUrl}/?view=executors&team=${TEAM}`);
    const twelve = row(page, 12);
    await expect(twelve.getByText("—", { exact: true }).first()).toBeVisible();
    await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=12`);
    const ip = detailRow(page, "Reported IP");
    await expect(ip).toContainText("—");
    await expect(ip).toContainText("Not reported yet");
    await expect(detailRow(page, "Connection")).toContainText(
      "Never connected",
    );
  });
});

test("v0048 team stream updates Executor connection, IP and first status · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stream = await captureStreams(page);
  await openInventory(page);

  await test.step("Executor loses its connection", async () => {
    await stream.send(
      event(
        "connection_lost",
        230,
        { executor_id: 7 },
        { last_heartbeat_at: at(229) },
      ),
    );
    await expect(
      row(page, 7).getByText("Connection lost", { exact: true }),
    ).toBeVisible();
    await expect(
      row(page, 7).locator(`time[datetime="${at(230)}"]`),
    ).toHaveCount(1);
    await stream.send(event("connection_restored", 232, { executor_id: 7 }));
    await expect(
      row(page, 7).getByText("Connected", { exact: true }),
    ).toBeVisible();
    await expect(
      row(page, 7).locator(`time[datetime="${at(232)}"]`),
    ).toHaveCount(1);
  });

  await test.step("Executor's own observation does not change the state", async () => {
    await stream.send(
      event("executor_connection_lost", 233, { executor_id: 7 }),
    );
    await expect(
      row(page, 7).getByText("Connected", { exact: true }),
    ).toBeVisible();
    await expect(row(page, 7)).not.toContainText("Connection lost");
  });

  await test.step("Stream updates the reported IP", async () => {
    await stream.send(
      event(
        "ip_changed",
        234,
        { executor_id: 7 },
        { old_ip: "192.0.2.10", new_ip: "192.0.2.11" },
      ),
    );
    await expect(
      row(page, 7).getByText("192.0.2.11", { exact: true }),
    ).toBeVisible();
    await expect(row(page, 7)).not.toContainText("192.0.2.10");
    await expect(
      row(page, 7).getByText("Connected", { exact: true }),
    ).toBeVisible();
  });

  await test.step("Status with an unchanged state carries the time journal serves", async () => {
    // journal serves the time of the latest connection_lost,
    // connection_restored, executor_lost or executor_status event, so a
    // capacity-only status moves it although the state stays connected.
    await stream.send(
      event(
        "executor_status",
        236,
        { executor_id: 7 },
        {
          connection_state: "connected",
          max_parallel_tasks: 3,
          held_claims: 1,
          available_capacity: 2,
        },
      ),
    );
    await expect(
      row(page, 7).getByText("1 claim", { exact: true }),
    ).toBeVisible();
    await expect(
      row(page, 7).getByText("Connected", { exact: true }),
    ).toBeVisible();
    await expect(
      row(page, 7).locator(`time[datetime="${at(236)}"]`),
    ).toHaveCount(1);
    await expect(
      row(page, 7).locator(`time[datetime="${at(232)}"]`),
    ).toHaveCount(0);
  });

  await test.step("First status after registration", async () => {
    // A full page load would drop this marker: everything below happens
    // in the page that was open when the frame arrived.
    await page.evaluate(() => {
      (window as any).__noManualReload = true;
    });
    await expect(
      row(page, 12).getByText("Never connected", { exact: true }),
    ).toBeVisible();
    await stream.send(
      event(
        "executor_status",
        235,
        { executor_id: 12 },
        {
          connection_state: "connected",
          max_parallel_tasks: 4,
          held_claims: 1,
          available_capacity: 3,
        },
      ),
    );
    const twelve = row(page, 12);
    await expect(twelve.getByText("Connected", { exact: true })).toBeVisible();
    await expect(twelve.locator(`time[datetime="${at(235)}"]`)).toHaveCount(1);
    await expect(twelve.getByText("1 claim", { exact: true })).toBeVisible();
    await expect(twelve.getByText("3", { exact: true })).toBeVisible();

    // In-app navigation from the inventory; journal's states read still has
    // no entry for 12, so only the delivered frame can make it connected.
    await results(page).getByRole("link", { name: "12", exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=executor&team=3&id=12(&|$)/);
    await expect(
      page.getByRole("heading", { name: "Executor 12", exact: true }),
    ).toBeVisible();
    const connection = detailRow(page, "Connection");
    await expect(connection).toContainText("Connected");
    await expect(connection).not.toContainText("Never connected");
    const time = connection.locator(`time[datetime="${at(235)}"]`);
    await expect(time).toHaveCount(1);
    // The browser runs in UTC; the detail shows the full time style.
    await expect(time).toHaveText("15 Oct 2026, 12:55 +00:00");
    await expect(detailRow(page, "Activity").locator("dd")).toHaveText(
      "1 claim",
    );
    await expect(detailRow(page, "Available").locator("dd")).toHaveText("3");
    expect(
      await page.evaluate(() => (window as any).__noManualReload === true),
    ).toBe(true);
  });

  await test.step("Detail follows the same stream events", async () => {
    await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=7`);
    await expect(
      page.getByRole("heading", { name: "Executor 7", exact: true }),
    ).toBeVisible();
    const history = page.getByRole("region", { name: "Executor events" });
    await stream.send(event("connection_lost", 240, { executor_id: 7 }));
    await expect(detailRow(page, "Connection")).toContainText(
      "Connection lost",
    );
    await stream.send(event("connection_restored", 241, { executor_id: 7 }));
    await expect(detailRow(page, "Connection")).toContainText("Connected");
    await stream.send(
      event("executor_connection_lost", 242, { executor_id: 7 }),
    );
    await expect(history).toContainText("executor_connection_lost");
    await expect(history).toContainText("Reported by the Executor");
    await expect(detailRow(page, "Connection")).not.toContainText("lost");
    await stream.send(
      event(
        "ip_changed",
        243,
        { executor_id: 7 },
        { old_ip: "192.0.2.10", new_ip: "192.0.2.11" },
      ),
    );
    const ip = detailRow(page, "Reported IP");
    await expect(ip).toContainText("192.0.2.11");
    await expect(ip.locator(`time[datetime="${at(243)}"]`)).toHaveCount(1);
    await expect(history).toContainText(
      "IP changed from 192.0.2.10 to 192.0.2.11",
    );
    await expect(detailRow(page, "Connection")).toContainText("Connected");
    // Another team's event never reaches this detail.
    await stream.send(
      event("connection_lost", 244, { team_id: TEAM + 1, executor_id: 7 }),
    );
    await page.waitForTimeout(300);
    await expect(detailRow(page, "Connection")).not.toContainText("lost");
  });
});

test("v0048 Executor inventory filters cover every page of executor-registry · Web UI unit", async ({
  page,
}) => {
  const executors = fake();
  // 201 records: the one that matches the search is on the second page.
  executors.records = [
    ...Array.from({ length: 200 }, (_, index) =>
      executorRecord(100 + index, { execution_tag: "openhands" }),
    ),
    executorRecord(400, { execution_tag: "gpu-late" }),
  ];
  executors.listQueries = [];
  await catalogRoutes(page);
  await executorRoutes(page, executors);
  await page.goto(`${proxy.baseUrl}/?view=executors&team=${TEAM}`);
  await expect(row(page, 100)).toBeVisible();

  await test.step("A matching Executor on the second page is found", async () => {
    await page.getByLabel("Search", { exact: true }).fill("gpu-late");
    await expect(row(page, 400)).toBeVisible();
    await expect(
      results(page)
        .locator("tr:visible,article:visible")
        .filter({
          has: page.getByRole("link", { name: /^[0-9]+$/ }),
        }),
    ).toHaveCount(1);
    // Every page was read with limit 200 until next_cursor was null.
    expect(
      executors.listQueries!.every((query) => query.get("limit") === "200"),
    ).toBe(true);
    expect(
      executors.listQueries!.some((query) => query.get("cursor") === "200"),
    ).toBe(true);
    for (const query of executors.listQueries!)
      expect([...query.keys()].sort()).toEqual(
        query.has("cursor") ? ["cursor", "limit"] : ["limit"],
      );
  });

  await test.step("Paging shown to the operator covers the filtered set", async () => {
    await page.getByLabel("Search", { exact: true }).fill("");
    await expect(row(page, 100)).toBeVisible();
    // 201 records at 10 rows per page: the first page and a Next page.
    await expect(
      results(page)
        .locator("tr:visible,article:visible")
        .filter({
          has: page.getByRole("link", { name: /^[0-9]+$/ }),
        }),
    ).toHaveCount(10);
    await page.getByLabel("Search", { exact: true }).fill("gpu-late");
    await expect(row(page, 400)).toBeVisible();
    await expect(
      results(page).getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
  });
});
