import path from "node:path";
import { test, expect } from "../fixtures/owned-test";
import { captureDesignState, designViewport } from "../fixtures/design-capture";
import { flowFixture, flowID } from "../fixtures/v0034-flow";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import type { Page } from "@playwright/test";

// Executor inventory and detail states (v0034.5), on the v0048 data model:
// executor-registry records merged with journal executor-states by the
// integer executor_id. Every Executor belongs to the selected team.

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});
test.use({ actionTimeout: 10_000 });

type Record_ = {
  executor_id: number;
  team_id: number;
  execution_tag: string;
  executor_type: string;
  created_at: string;
  token_fingerprint: string;
  token_issued_at: string;
  reported_ip: string | null;
  ip_reported_at: string | null;
};
type State = {
  executor_id: number;
  connection_state: string;
  connection_changed_at: string | null;
  held_claims: number | null;
  max_parallel_tasks: number | null;
  available_capacity: number | null;
  reported_ip: string | null;
  ip_changed_at: string | null;
};

const record = (
  executor_id: number,
  extra: Partial<Record_> = {},
): Record_ => ({
  executor_id,
  team_id: 1,
  execution_tag: "openhands",
  executor_type: "executor_docker_openhands",
  created_at: "2026-10-18T00:00:00Z",
  token_fingerprint: "ab".repeat(32),
  token_issued_at: "2026-10-18T00:00:00Z",
  reported_ip: null,
  ip_reported_at: null,
  ...extra,
});
const state = (executor_id: number, extra: Partial<State> = {}): State => ({
  executor_id,
  connection_state: "connected",
  connection_changed_at: "2026-10-18T00:00:05Z",
  held_claims: 2,
  max_parallel_tasks: 4,
  available_capacity: 2,
  reported_ip: "192.0.2.10",
  ip_changed_at: "2026-10-18T00:00:06Z",
  ...extra,
});
const flatEvent = (
  event_id: number,
  executor_id: number,
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  event_id,
  publisher: "executor-registry",
  publisher_seq: event_id,
  team_id: 1,
  occurred_at: "2026-10-18T00:00:05Z",
  kind,
  executor_id,
  ...extra,
});
const taskItem = (task_id: number, external_id: string, status: string) => ({
  task_id,
  task_name: `alpha-${task_id}`,
  team_id: 1,
  flow_id: flowID,
  source_id: 7008,
  external_id,
  current_state: status,
  attempt: 1,
  executor_id: null as number | null,
  ingested_at: "2026-10-18T00:00:00Z",
  claimed_at: "2026-10-18T00:00:01Z",
  completed_at: ["finished", "failed"].includes(status)
    ? "2026-10-18T00:00:02Z"
    : null,
});

async function sourceCatalog(page: Page) {
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({
      json: { items: [{ source_id: 7008, name: "Queue" }], next_cursor: null },
    }),
  );
}

// The two inventory reads; the list follows executor-registry's contract:
// only cursor and limit (1-200), with an offset cursor.
async function inventoryRoutes(
  page: Page,
  records: Record_[],
  states: State[],
  queries: URL[] = [],
) {
  await page.route("**/ui/v1/teams/1/executor-states**", (route) =>
    route.fulfill({ json: { items: states } }),
  );
  await page.route(/\/ui\/v1\/teams\/1\/executors(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const limit = Number(url.searchParams.get("limit") ?? 50),
      offset = Number(url.searchParams.get("cursor") ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      return route.fulfill({ status: 400, json: { code: "invalid_request" } });
    return route.fulfill({
      json: {
        items: records.slice(offset, offset + limit),
        next_cursor:
          offset + limit < records.length ? String(offset + limit) : null,
        total_count: records.length,
      },
    });
  });
}

function expectRegistryQueries(queries: URL[]) {
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query.searchParams.get("limit")).toBe("200");
    expect([...query.searchParams.keys()].sort()).toEqual(
      query.searchParams.has("cursor") ? ["cursor", "limit"] : ["limit"],
    );
  }
}

// Every readonly Executor field and canonical link of the inventory.
async function inventoryFields(page: Page) {
  const { writes } = await flowFixture(page);
  const records = [
    record(7, {
      reported_ip: "192.0.2.10",
      ip_reported_at: "2026-10-18T00:00:06Z",
    }),
    record(8, {
      executor_type: "executor_k8s_openhands",
      execution_tag: "gpu",
    }),
  ];
  // Journal also holds a state for 99, which has no record.
  await inventoryRoutes(page, records, [state(7), state(99)]);
  await page.goto(`${proxy.baseUrl}?view=executors&team=1`);
  const root = page.locator("#results");
  await expect(root.getByRole("link", { name: /^[0-9]+$/ })).toHaveCount(2);
  await expect(root).not.toContainText("99");
  const expected = [
    {
      id: 7,
      values: [
        "executor_docker_openhands",
        "openhands",
        "Connected",
        "192.0.2.10",
        "2 claims",
        "2",
      ],
    },
    {
      id: 8,
      values: ["executor_k8s_openhands", "gpu", "Never connected", "—"],
    },
  ];
  for (const { id, values } of expected) {
    const link = root.getByRole("link", { name: String(id), exact: true });
    await expect(link).toBeVisible();
    const href = new URL((await link.getAttribute("href"))!, proxy.baseUrl);
    expect(href.searchParams.get("view")).toBe("executor");
    expect(href.searchParams.get("team")).toBe("1");
    expect(href.searchParams.get("id")).toBe(String(id));
    const row = root.locator("tr:visible,article:visible").filter({
      has: page.getByRole("link", { name: String(id), exact: true }),
    });
    for (const text of values)
      await expect(row.getByText(text, { exact: true }).first()).toBeVisible();
    for (const value of values.slice(1, 3)) {
      const lines = await row
        .getByText(value, { exact: true })
        .first()
        .evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return new Set(
            [...range.getClientRects()]
              .filter((rect) => rect.height > 0)
              .map((rect) => Math.round(rect.top)),
          ).size;
        });
      expect(lines, `Short Executor value ${value} stays on one line`).toBe(1);
    }
    await expect(row.getByRole("button")).toHaveCount(0);
    expect(
      await row.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return (
          box.left >= 0 &&
          box.right <= innerWidth &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
    ).toBe(true);
  }
  await expect(
    page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("link", { name: "Executors", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  // No scope, team or actions column.
  await expect(
    root.locator("th,dt").filter({ hasText: /^(Team|Scope|Actions)$/ }),
  ).toHaveCount(0);
  await expect(root).not.toContainText(/\bSystem\b/);
  expect(writes).toEqual([]);
}

for (const view of ["inventory", "detail"])
  for (const theme of ["dark", "light"])
    for (const width of [390, 820, 1440])
      test(`v0034.5 canonical Executor ${view} states ${theme} ${width}`, async ({
        context,
      }, info) => {
        test.setTimeout(view === "inventory" ? 270_000 : 240_000);
        // A failing state does not hide the later states and steps.
        const stateFailures: unknown[] = [];
        const states =
          view === "inventory"
            ? ["default", "filtered", "empty", "no-results", "loading", "error"]
            : [
                "default",
                "no-events",
                "no-tasks",
                "active-task-filter",
                "loading",
                "error",
                "unavailable",
                "foreign-candidate",
                "filter-error",
              ];
        for (const current of states) {
          const page = await context.newPage(),
            failures: unknown[] = [],
            errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          try {
            await page.setViewportSize(designViewport(width));
            await page.addInitScript(
              (value) => localStorage.setItem("flowai.theme", value),
              theme,
            );
            const { writes } = await flowFixture(page);
            await sourceCatalog(page);
            const busy = record(7, {
              reported_ip: "192.0.2.10",
              ip_reported_at: "2026-10-18T00:00:06Z",
            });
            const idle = record(8, {
              executor_type: "executor_k8s_openhands",
              execution_tag: "gpu",
            });
            const journal = [
              state(7),
              state(8, { held_claims: 0, available_capacity: 4 }),
            ];
            const id = current === "unavailable" ? 9999 : busy.executor_id;
            const queries: URL[] = [],
              taskQueries: URL[] = [];
            let pointReads = 0,
              eventReads = 0,
              heldReads = 0,
              recovery = false;
            await page.route("**/ui/v1/teams/1/executor-states**", (route) =>
              route.fulfill({ json: { items: journal } }),
            );
            await page.route(
              /\/ui\/v1\/teams\/1\/executors(?:\?.*)?$/,
              async (route) => {
                queries.push(new URL(route.request().url()));
                if (current === "loading") {
                  heldReads++;
                  await held;
                }
                if (current === "error")
                  return route.fulfill({
                    status: 503,
                    json: { code: "temporarily_unavailable" },
                  });
                const items = current === "empty" ? [] : [busy, idle];
                return route.fulfill({
                  json: { items, next_cursor: null, total_count: items.length },
                });
              },
            );
            await page.route(
              new RegExp(`/ui/v1/teams/1/executors/${id}$`),
              async (route) => {
                pointReads++;
                if (current === "loading") {
                  heldReads++;
                  await held;
                }
                if (["error", "unavailable"].includes(current))
                  return route.fulfill({
                    status: current === "error" ? 503 : 404,
                    json: {
                      code:
                        current === "error"
                          ? "temporarily_unavailable"
                          : "executor_unknown_or_unavailable",
                    },
                  });
                return route.fulfill({
                  json:
                    current === "foreign-candidate"
                      ? { ...busy, executor_id: 7009 }
                      : busy,
                });
              },
            );
            await page.route(
              `**/ui/v1/teams/1/executors/${id}/events?**`,
              (route) => {
                eventReads++;
                return route.fulfill({
                  json: {
                    items:
                      current === "no-events"
                        ? []
                        : [flatEvent(5101, id, "connection_restored")],
                    next_cursor: null,
                  },
                });
              },
            );
            await page.route(
              `**/ui/v1/teams/1/executors/${id}/tasks?**`,
              (route) => {
                const query = new URL(route.request().url());
                taskQueries.push(query);
                const status = query.searchParams.get("status") ?? "running";
                if (
                  current === "filter-error" &&
                  status === "finished" &&
                  !recovery
                )
                  return route.fulfill({
                    status: 503,
                    json: { code: "temporarily_unavailable" },
                  });
                const items =
                  current === "no-tasks"
                    ? []
                    : [
                        {
                          ...taskItem(7010, "visible-work-item", status),
                          executor_id: id,
                        },
                      ];
                return route.fulfill({ json: { items, next_cursor: null } });
              },
            );
            const url = new URL(proxy.baseUrl);
            url.search = new URLSearchParams({
              view: view === "inventory" ? "executors" : "executor",
              team: "1",
              ...(view === "detail" ? { id: String(id) } : {}),
            }).toString();
            if (["filtered", "no-results"].includes(current)) {
              url.searchParams.set(
                "search",
                current === "filtered" ? "openhands" : "missing",
              );
              url.searchParams.set("activity", "busy");
              url.searchParams.set("limit", "25");
            }
            await page.goto(url.toString());
            if (view === "inventory") {
              await expect.poll(() => queries.length).toBeGreaterThan(0);
              const root = page.locator("#results");
              if (current === "loading") {
                await expect.poll(() => heldReads).toBe(1);
                await expect(root.getByRole("status")).toContainText(
                  "Current team data is withheld",
                );
                await expect(root.getByRole("link")).toHaveCount(0);
              } else if (current === "error") {
                await expect(root.getByRole("alert")).toContainText(
                  "Request failed",
                );
                // Owner review 2026-10-25: no in-place Retry command.
                await expect(
                  root.getByRole("button", { name: "Retry", exact: true }),
                ).toHaveCount(0);
              } else if (current === "empty")
                await expect(root.getByRole("status")).toContainText(
                  "No records available.",
                );
              else if (current === "no-results")
                await expect(root.getByRole("status")).toContainText(
                  "No matching records",
                );
              else {
                // Filters run in the browser over the merged set (D9).
                const expected = current === "filtered" ? [busy] : [busy, idle];
                await expect(
                  root.getByRole("link", { name: /^[0-9]+$/ }),
                ).toHaveCount(expected.length);
                for (const item of expected) {
                  const link = root.getByRole("link", {
                    name: String(item.executor_id),
                    exact: true,
                  });
                  const href = new URL(
                    (await link.getAttribute("href"))!,
                    proxy.baseUrl,
                  );
                  expect(href.searchParams.get("view")).toBe("executor");
                  expect(href.searchParams.get("team")).toBe("1");
                  expect(href.searchParams.get("id")).toBe(
                    String(item.executor_id),
                  );
                  if (current === "filtered") {
                    expect(href.searchParams.get("search")).toBe("openhands");
                    expect(href.searchParams.get("activity")).toBe("busy");
                    expect(href.searchParams.get("limit")).toBe("25");
                  }
                }
                await expect(
                  root.getByRole("button", {
                    name: /^(Register|Edit|Archive|Pause|Resume|Delete|Actions for)/,
                  }),
                ).toHaveCount(0);
              }
              if (["filtered", "no-results"].includes(current)) {
                await expect(
                  page.getByRole("textbox", { name: "Search", exact: true }),
                ).toHaveValue(current === "filtered" ? "openhands" : "missing");
                await expect(
                  page.getByRole("combobox", { name: "Activity", exact: true }),
                ).toHaveValue("busy");
                await expect(
                  page.getByRole("combobox", {
                    name: "Rows per page",
                    exact: true,
                  }),
                ).toHaveValue("25");
              }
              if (!["loading", "error"].includes(current))
                expectRegistryQueries(queries);
            } else {
              await expect.poll(() => pointReads).toBe(1);
              const detail = page.locator("#executor-detail");
              const identity = page.getByRole("heading", {
                name: `Executor ${busy.executor_id}`,
                exact: true,
              });
              if (current === "loading") {
                await expect.poll(() => heldReads).toBe(1);
                await expect(detail.getByRole("status")).toContainText(
                  "Current team data is withheld",
                );
                await expect(identity).toHaveCount(0);
              } else if (
                ["unavailable", "foreign-candidate"].includes(current)
              ) {
                await expect(detail.getByRole("status")).toContainText(
                  "Executor unavailable",
                );
                await expect(identity).toHaveCount(0);
                await expect(page.locator("#app")).not.toContainText("7009");
              } else if (current === "error") {
                await expect(detail.getByRole("alert")).toContainText(
                  "Request failed",
                );
                // Owner review 2026-10-25: no in-place Retry command.
                await expect(
                  page.getByRole("button", { name: "Retry", exact: true }),
                ).toHaveCount(0);
              } else {
                await expect(identity).toBeVisible();
                const section = page.locator("section").filter({
                  has: identity,
                });
                for (const text of [
                  "executor_docker_openhands",
                  "openhands",
                  "Connected",
                  "192.0.2.10",
                  "2 claims",
                ])
                  await expect(section).toContainText(text);
                await expect(section).not.toContainText(/\b(System|Scope)\b/);
                const badge = section.locator(".badge").first();
                await expect(badge).toHaveText("Connected");
                expect(
                  await badge.evaluate(
                    (node) =>
                      !!node.closest(
                        'button,a,input,select,textarea,[tabindex],[role="button"],[role="link"]',
                      ),
                  ),
                ).toBe(false);
                const tasks = page.locator("[data-executor-tasks]");
                if (current === "no-tasks")
                  await expect(tasks).toContainText(
                    "No tasks with this status",
                  );
                else
                  await expect(
                    tasks.getByRole("link", {
                      name: "alpha-7010",
                      exact: true,
                    }),
                  ).toBeVisible();
                if (current === "no-events")
                  await expect(
                    page.getByText("No Executor events.", { exact: true }),
                  ).toBeVisible();
                else
                  await expect(
                    page.locator("[data-executor-events]"),
                  ).toContainText("connection_restored");
                if (["active-task-filter", "filter-error"].includes(current)) {
                  await page
                    .getByRole("combobox", { name: /^Task status/ })
                    .selectOption("finished");
                  if (current === "filter-error") {
                    await expect(tasks.getByRole("alert")).toContainText(
                      "could not be loaded",
                    );
                    await expect(identity).toBeVisible();
                    await expect(
                      page.getByRole("combobox", { name: /^Task status/ }),
                    ).toHaveValue("finished");
                    await captureDesignState(
                      page,
                      test.info(),
                      proxy.webUIImageID,
                      `executor-detail-filter-read-error-${theme}-${width}`,
                    );
                    // Owner review 2026-10-25: no in-place Retry command;
                    // changing another filter reloads with the status kept.
                    await expect(
                      tasks.getByRole("button", { name: "Retry", exact: true }),
                    ).toHaveCount(0);
                    recovery = true;
                    await page
                      .getByRole("combobox", { name: /^Rows per page/ })
                      .selectOption("25");
                  }
                  await expect(
                    tasks.getByRole("link", {
                      name: "alpha-7010",
                      exact: true,
                    }),
                  ).toBeVisible();
                  await page
                    .getByRole("combobox", { name: /^Rows per page/ })
                    .selectOption("25");
                  await expect
                    .poll(() => taskQueries.at(-1)?.searchParams.get("limit"))
                    .toBe("25");
                  expect(taskQueries.at(-1)?.searchParams.get("status")).toBe(
                    "finished",
                  );
                  await expect(tasks.getByRole("status")).toHaveCount(0);
                }
                await expect(
                  page.getByRole("button", { name: "Reset", exact: true }),
                ).toBeVisible();
                expect(eventReads).toBe(1);
              }
            }
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            expect(writes).toEqual([]);
            expect(errors).toEqual([]);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            await captureDesignState(
              page,
              test.info(),
              proxy.webUIImageID,
              `${view === "inventory" ? "executors.html" : "executor-detail.html"}-${current === "filter-error" ? "filter-recovered" : current}-${theme}-${width}`,
            );
            if (view === "detail" && current === "active-task-filter") {
              await page
                .getByRole("button", { name: "Reset", exact: true })
                .click();
              await expect(
                page.getByRole("combobox", { name: /^Task status/ }),
              ).toHaveValue("running");
              await expect(
                page.getByRole("combobox", { name: /^Rows per page/ }),
              ).toHaveValue("10");
              await expect
                .poll(() => taskQueries.at(-1)?.searchParams.get("status"))
                .toBe("running");
              expect(taskQueries.at(-1)?.searchParams.get("limit")).toBe("10");
            }
          } catch (error) {
            failures.push(error);
          } finally {
            release();
            try {
              await page.unrouteAll({ behavior: "wait" });
            } catch (error) {
              failures.push(error);
            }
            try {
              await page.close();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length === 1) stateFailures.push(failures[0]);
          else if (failures.length)
            stateFailures.push(
              new AggregateError(
                failures,
                `Executor ${view}/${current} verification or release failed`,
              ),
            );
        }
        if (view === "inventory") {
          const title = `v0034.5 Executor inventory keeps all readonly fields and canonical links ${theme} ${width}`;
          const page = await context.newPage();
          try {
            await test.step(title, async () => {
              await page.setViewportSize(designViewport(width));
              await page.addInitScript(
                (value) => localStorage.setItem("flowai.theme", value),
                theme,
              );
              await inventoryFields(page);
            });
          } catch (error) {
            stateFailures.push(error);
          }
          try {
            await captureDesignState(
              page,
              info,
              proxy.webUIImageID,
              `final-${title}`,
            );
            await page.unrouteAll({ behavior: "wait" });
            await page.close();
          } catch (error) {
            stateFailures.push(error);
          }
        }
        if (stateFailures.length === 1) throw stateFailures[0];
        if (stateFailures.length)
          throw new AggregateError(
            stateFailures,
            `${stateFailures.length} Executor ${view} states or steps failed`,
          );
      });

test("v0034.5 Executor task filter read failure retains identity and recovers the same filter", async ({
  page,
}) => {
  const { writes } = await flowFixture(page);
  await sourceCatalog(page);
  await inventoryRoutes(page, [record(7004)], [state(7004)]);
  await page.route(/\/ui\/v1\/teams\/1\/executors\/7004$/, (route) =>
    route.fulfill({ json: record(7004) }),
  );
  await page.route("**/ui/v1/teams/1/executors/7004/events?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  let available = false;
  const queries: URL[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/ui/v1/teams/1/executors/7004/tasks?**", (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    if (url.searchParams.get("status") === "finished" && !available)
      return route.fulfill({
        status: 503,
        json: { code: "temporarily_unavailable" },
      });
    return route.fulfill({
      json: {
        items: available ? [taskItem(7011, "recovered-work", "finished")] : [],
        next_cursor: null,
      },
    });
  });
  await page.goto(`${proxy.baseUrl}?view=executor&team=1&id=7004`);
  const tasks = page.locator("[data-executor-tasks]");
  const identity = page.getByRole("heading", {
    name: "Executor 7004",
    exact: true,
  });
  await expect(tasks).toContainText("No tasks with this status");
  await expect(identity).toBeVisible();
  await page
    .getByRole("combobox", { name: /^Task status/ })
    .selectOption("finished");
  await expect(tasks.getByRole("alert")).toContainText("could not be loaded");
  await expect(identity).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: /^Task status/ }),
  ).toHaveValue("finished");
  await expect(tasks).not.toContainText("No tasks with this status");
  // Owner review 2026-10-25: no in-place Retry command; choosing the same
  // status again after the service recovers reloads that filter.
  await expect(
    tasks.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  available = true;
  await page
    .getByRole("combobox", { name: /^Task status/ })
    .selectOption("running");
  await page
    .getByRole("combobox", { name: /^Task status/ })
    .selectOption("finished");
  await expect(
    tasks.getByRole("link", { name: "alpha-7011", exact: true }),
  ).toBeVisible();
  expect(
    queries.filter((url) => url.searchParams.get("status") === "finished"),
  ).toHaveLength(2);
  for (const url of queries) expect(url.searchParams.get("limit")).toBe("10");
  expect(errors).toEqual([]);
  expect(writes).toEqual([]);
});

test("v0034.5 Executor inventory pages the merged set in the browser and keeps its filters through reload", async ({
  page,
}) => {
  const { writes } = await flowFixture(page);
  // 230 records: executor-registry serves them over two limit=200 pages.
  const records = Array.from({ length: 230 }, (_, index) =>
    record(100 + index, { execution_tag: index < 30 ? "worker" : "other" }),
  );
  const queries: URL[] = [];
  let failSecond = true;
  await page.route("**/ui/v1/teams/1/executor-states**", (route) =>
    route.fulfill({
      json: { items: records.map((item) => state(item.executor_id)) },
    }),
  );
  await page.route(/\/ui\/v1\/teams\/1\/executors(?:\?.*)?$/, (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const offset = Number(url.searchParams.get("cursor") ?? 0);
    if (offset && failSecond) {
      failSecond = false;
      return route.fulfill({ status: 503, json: { code: "unavailable" } });
    }
    return route.fulfill({
      json: {
        items: records.slice(offset, offset + 200),
        next_cursor:
          offset + 200 < records.length ? String(offset + 200) : null,
        total_count: records.length,
      },
    });
  });
  const root = page.locator("#results");
  const link = (id: number) =>
    root.getByRole("link", { name: String(id), exact: true });
  const rows = () => root.getByRole("link", { name: /^[0-9]+$/ });
  const target = `${proxy.baseUrl}?view=executors&team=1&search=worker&limit=25`;

  await test.step("A failed later registry page shows an error, not a partial list", async () => {
    await page.goto(target);
    await expect(root.getByRole("alert")).toContainText("Request failed");
    await expect(rows()).toHaveCount(0);
    await expect(
      root.getByRole("button", { name: "Retry", exact: true }),
    ).toHaveCount(0);
  });

  await test.step("The filtered set pages in the browser with the chosen page size", async () => {
    await page.reload();
    await expect(link(100)).toBeVisible();
    await expect(rows()).toHaveCount(25);
    await expect(
      root.getByRole("button", { name: "Previous", exact: true }),
    ).toBeDisabled();
    await root.getByRole("button", { name: "Next", exact: true }).click();
    await expect(link(125)).toBeVisible();
    await expect(rows()).toHaveCount(5);
    await expect(
      root.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await root.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(link(100)).toBeVisible();
    expectRegistryQueries(queries);
  });

  await test.step("Changing a filter returns to the first page", async () => {
    await root.getByRole("button", { name: "Next", exact: true }).click();
    await expect(link(125)).toBeVisible();
    await page
      .getByRole("combobox", { name: "Rows per page", exact: true })
      .selectOption("50");
    await expect(link(100)).toBeVisible();
    await expect(rows()).toHaveCount(30);
    expect(new URL(page.url()).searchParams.get("limit")).toBe("50");
  });

  await test.step("Reload keeps the URL-held filters", async () => {
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Search", exact: true }),
    ).toHaveValue("worker");
    await expect(
      page.getByRole("combobox", { name: "Rows per page", exact: true }),
    ).toHaveValue("50");
    await expect(rows()).toHaveCount(30);
    expectRegistryQueries(queries);
  });
  expect(writes).toEqual([]);
});

test("v0034.5 Executor tasks follow issued cursors and preserve page context through reload", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { writes } = await flowFixture(page);
  await sourceCatalog(page);
  await inventoryRoutes(page, [record(7012)], [state(7012)]);
  await page.route(/\/ui\/v1\/teams\/1\/executors\/7012$/, (route) =>
    route.fulfill({ json: record(7012) }),
  );
  await page.route("**/ui/v1/teams/1/executors/7012/events?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  const cursor = "opaque-issued-next-page",
    queries: URL[] = [];
  let failNext = true;
  await page.route("**/ui/v1/teams/1/executors/7012/tasks?**", (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const second = url.searchParams.get("cursor") === cursor;
    if (second && failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { code: "unavailable" } });
    }
    const status = url.searchParams.get("status") ?? "running";
    const limit = Number(url.searchParams.get("limit"));
    const items = second
      ? [
          {
            ...taskItem(9002, "second-work", status),
            ingested_at: "2026-10-17T00:00:00Z",
          },
        ]
      : [
          {
            ...taskItem(9001, "first-work", status),
            ingested_at: "2026-10-18T01:00:00Z",
          },
          ...Array.from({ length: limit - 1 }, (_, index) => ({
            ...taskItem(9100 + index, `filler-work-${index}`, status),
            ingested_at: new Date(
              Date.UTC(2026, 9, 18, 0, 59, 59 - index),
            ).toISOString(),
          })),
        ];
    for (const row of items) {
      const started = Date.parse(row.ingested_at);
      row.claimed_at = new Date(started + 1000).toISOString();
      row.completed_at = ["finished", "failed"].includes(status)
        ? new Date(started + 2000).toISOString()
        : null;
    }
    return route.fulfill({
      json: { items, next_cursor: second ? null : cursor },
    });
  });
  await page.goto(`${proxy.baseUrl}?view=executor&team=1&id=7012`);
  const root = page.locator("[data-executor-tasks]");
  // v0050: task links are named by the task name.
  const ids: Record<string, number> = {
    "first-work": 9001,
    "second-work": 9002,
  };
  const link = (value: string) =>
    root.getByRole("link", { name: `alpha-${ids[value]}`, exact: true });
  const openFirstPage = async () => {
    await expect(link("first-work")).toBeVisible();
    // Executor task filters are page-local and are chosen again after a reload.
    await page
      .getByRole("combobox", { name: /^Task status/ })
      .selectOption("finished");
    await expect(link("first-work")).toBeVisible();
    await page
      .getByRole("combobox", { name: /^Rows per page/ })
      .selectOption("25");
    await expect
      .poll(() => queries.at(-1)?.searchParams.get("limit"))
      .toBe("25");
    await expect(link("first-work")).toBeVisible();
  };
  await openFirstPage();
  await expect(
    root.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  await root.getByRole("button", { name: "Next", exact: true }).click();
  await expect(root.getByRole("alert")).toContainText("could not be loaded");
  // Owner review 2026-10-25: no in-place Retry command; recovery opens the
  // collection again with the same filters and follows the issued cursor.
  await expect(
    root.getByRole("button", { name: "Retry", exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await openFirstPage();
  await root.getByRole("button", { name: "Next", exact: true }).click();
  await expect(link("second-work")).toBeVisible();
  await expect(
    root.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  const attempts = queries.filter(
    (url) => url.searchParams.get("cursor") === cursor,
  );
  expect(attempts).toHaveLength(2);
  for (const query of attempts) {
    expect(query.searchParams.get("limit")).toBe("25");
    expect(query.searchParams.get("status")).toBe("finished");
  }
  await root.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(link("first-work")).toBeVisible();
  expect(queries.at(-1)?.searchParams.get("cursor")).toBeNull();
  await root.getByRole("button", { name: "Next", exact: true }).click();
  await expect(link("second-work")).toBeVisible();
  await page
    .getByRole("combobox", { name: /^Task status/ })
    .selectOption("failed");
  await expect(link("first-work")).toBeVisible();
  expect(queries.at(-1)?.searchParams.get("cursor")).toBeNull();
  await page
    .getByRole("combobox", { name: /^Rows per page/ })
    .selectOption("50");
  await expect(link("first-work")).toBeVisible();
  expect(queries.at(-1)?.searchParams.get("limit")).toBe("50");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(link("first-work")).toBeVisible();
  expect(queries.at(-1)?.searchParams.get("cursor")).toBeNull();
  expect(queries.at(-1)?.searchParams.get("limit")).toBe("10");
  expect(queries.at(-1)?.searchParams.get("status")).toBe("running");
  expect(writes).toEqual([]);
});
