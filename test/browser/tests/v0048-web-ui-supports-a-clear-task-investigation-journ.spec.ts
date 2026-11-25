import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import type { Page } from "@playwright/test";
import {
  TEAM,
  TEAM_NAME,
  at,
  attempt,
  catalogRoutes,
  claim,
  event,
  executorRecord,
  executorRoutes,
  expectTaskCollection,
  summary,
  taskRecord,
  taskRoutes,
  v0048Proxy,
  MATRIX,
  usePresentation,
  type ShownTask,
} from "../fixtures/v0048-ui";

// web-ui: Web UI supports a clear task investigation journey (v0048).
test.use({ actionTimeout: 10_000, timezoneId: "UTC" });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const DAY = "2026-10-15";
const STATES = [
  "queued",
  "created",
  "pending",
  "running",
  "finished",
  "failed",
  "cancelled",
];
const zero = () => Object.fromEntries(STATES.map((state) => [state, 0]));

/** journal dashboard: ISO week 42 of 2026 with `running` tasks on DAY. */
async function weekDashboard(page: Page, running: number) {
  await page.route(`**/ui/v1/teams/${TEAM}/dashboard?**`, (route) => {
    const buckets = [...Array(7)].map((_, index) => {
      const date = new Date(Date.UTC(2026, 9, 12 + index));
      const key = date.toISOString().slice(0, 10);
      const count = key === DAY ? running : 0;
      return {
        at: date.toISOString(),
        key,
        label: key,
        shortLabel: String(date.getUTCDate()),
        total: count,
        counts: { ...zero(), running: count },
        isFuture: key > DAY,
      };
    });
    return route.fulfill({
      json: {
        period: "week",
        calendar_key: "2026-W42",
        time_zone: "UTC",
        counts: { ...zero(), running },
        buckets,
      },
    });
  });
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 operator investigates one day's task from Overview · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    test.setTimeout(90_000);
    await page.clock.setFixedTime(new Date(`${DAY}T12:00:00Z`));
    // ISO week 42 of 2026: 12-18 October, one running task on the 15th.
    await weekDashboard(page, 1);
    await catalogRoutes(page);
    await executorRoutes(page, {
      records: [executorRecord(7)],
      states: [],
      events: new Map(),
      tasks: new Map(),
    });
    const keys = { task_id: 1050, attempt: 1, claim_seq: 1, executor_id: 7 };
    await taskRoutes(page, [
      {
        task: taskRecord(1050, {
          attempts: [attempt(1, "running", [claim(1, 1, 7, 1)])],
        }),
        events: [
          event("created", 1, keys),
          event("running", 2, keys),
          // A cancel the claim holder acknowledged; the task still runs.
          event(
            "control_requested",
            3,
            { ...keys, control_id: 61 },
            { control: "cancel" },
          ),
          event(
            "control_acknowledged",
            4,
            { ...keys, control_id: 61 },
            { control: "cancel" },
          ),
        ],
        logs: [
          {
            event_id: 2900,
            task_id: 1050,
            attempt: 1,
            claim_seq: 1,
            executor_id: 7,
            log_offset: 1,
            stream: "work",
            text: "Reading source payload",
            publisher_seq: 2900,
            occurred_at: at(3),
          },
        ],
      },
    ]);

    await page.goto(
      `${proxy.baseUrl}/?view=dashboard&team=${TEAM}&period=week&week=2026-W42`,
    );

    await test.step("Operator investigates one day's task", async () => {
      await page.locator(`[data-dashboard-date="${DAY}"]`).click();
      await expect(page).toHaveURL(new RegExp(`[?&]date=${DAY}(&|$)`));
      await expect(page.getByLabel("Date", { exact: true })).toHaveValue(DAY);

      // v0050: the task's link is its task name, by integer route.
      await page
        .getByRole("link", { name: `${TEAM_NAME}-1050`, exact: true })
        .click();
      await expect(page).toHaveURL(/[?&]view=task(&|$)/);
      await expect(page).toHaveURL(/[?&]id=1050(&|$)/);

      // The control outcome stays apart from the task status.
      const status = page
        .locator("main div,main tr")
        .filter({
          has: page.locator("dt,th").getByText("Status", { exact: true }),
        })
        .last();
      await expect(status).toContainText(/running/i);
      await expect(status).not.toContainText(/control|acknowledged|cancel/i);
      const timeline = page.locator("section").filter({
        has: page.getByRole("heading", {
          name: "Execution timeline",
          exact: true,
        }),
      });
      await expect(timeline).toContainText("control_acknowledged");

      // Log lines are output, not lifecycle events.
      await expect(
        page.getByRole("log", { name: "Attempt 1 log", exact: true }),
      ).toContainText("Reading source payload");
      await expect(timeline).not.toContainText("Reading source payload");

      await page
        .locator("main")
        .getByRole("link", { name: "Executor 7", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: "Executor 7", exact: true }),
      ).toBeVisible();

      // Back twice: the task, then the same day's Tasks list.
      await page.goBack();
      await expect(page).toHaveURL(/[?&]id=1050(&|$)/);
      await expect(
        page.getByRole("heading", { name: "Execution timeline", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/[?&]view=history(&|$)/);
      await expect(page).toHaveURL(new RegExp(`[?&]date=${DAY}(&|$)`));
      await expect(page.getByLabel("Date", { exact: true })).toHaveValue(DAY);
      await expect(
        page.getByRole("link", { name: `${TEAM_NAME}-1050`, exact: true }),
      ).toBeVisible();
    });
  });

// v0050: four tasks of team ops. 1042 and 1043 come from two Sources with
// the same external ID; 1044's external ID is the upper-case text of 1042's
// task name; 1044's and 1046's replies carry task_names that differ from
// `<team_name>-<task_id>`, so a Web UI that composes the name instead of
// showing the reply's fails on it.
const NAMED = [
  taskRecord(1042, {
    source_id: 4,
    flow_id: 1,
    external_id: "PROJ-7",
    executor_id: 7,
    ingested_at: at(30),
  }),
  taskRecord(1043, {
    source_id: 5,
    flow_id: 2,
    external_id: "PROJ-7",
    executor_id: 8,
    ingested_at: at(20),
  }),
  taskRecord(1044, {
    source_id: 4,
    flow_id: 1,
    external_id: "OPS-1042",
    task_name: "ops-9044",
    executor_id: 7,
    ingested_at: at(10),
  }),
  taskRecord(1046, {
    source_id: 5,
    flow_id: 1,
    external_id: "invoice-1046",
    task_name: "ops-9046",
    executor_id: null,
    current_state: "queued",
    claimed_at: null,
    ingested_at: at(0),
  }),
];
const shown = (task: (typeof NAMED)[number]): ShownTask => ({
  id: task.task_id,
  name: task.task_name,
  external: task.external_id,
});
const LONG_EXTERNAL =
  "PROJ-7-" + "long-upstream-identifier-without-breaks-".repeat(8);

/**
 * task-manager list-tasks over NAMED: a term that is a task's full name finds
 * only that task (task-manager owns that rule); any other term, including the
 * Flow page's flow_id candidates, returns every task.
 */
async function namedTaskRoutes(page: Page, tasks: typeof NAMED) {
  const searches: string[] = [];
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/tasks(?:\\?.*)?$`),
    (route) => {
      const term =
        new URL(route.request().url()).searchParams.get("search") ?? "";
      searches.push(term);
      const named = tasks.filter(
        (task) => task.task_name === term.trim().toLowerCase(),
      );
      return route.fulfill({
        json: {
          items: (named.length ? named : tasks).map((task) => summary(task)),
          next_cursor: null,
        },
      });
    },
  );
  return searches;
}

/** flow-registry reads of Flow 1 for its read-only page. */
async function flowRoutes(page: Page) {
  const flow = {
    flow_id: 1,
    name: "Intake routing",
    revision: 1,
    execution_tag: "openhands",
    model_aliases: [],
    prompt_template: "Work {{external_id}}",
    execution_parameters: {},
    default_image: null,
    source_ids: [4],
    source_revisions: {},
    per_task_limit: null,
    flow_limit: null,
    failure_retry_count: 3,
    failure_retry_wait_seconds: 60,
    pending_limit_seconds: 900,
    release_delay_seconds: 300,
    execution_revision: 1,
    created_at: at(-600),
    updated_at: at(-600),
  };
  await page.route(/\/ui\/v1\/flows\/1$/, (route) =>
    route.fulfill({ json: flow, headers: { etag: '"1"' } }),
  );
  await page.route(/\/ui\/v1\/flow-llm-settings\/1$/, (route) =>
    route.fulfill({ json: { ...flow, models: [] } }),
  );
  await page.route("**/ui/v1/models?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0050 every task collection leads with the reply's task name · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    test.setTimeout(120_000);
    await page.clock.setFixedTime(new Date(`${DAY}T12:00:00Z`));
    const tasks = NAMED.map((task) => ({ ...task }));
    await weekDashboard(page, tasks.length);
    await catalogRoutes(page);
    await flowRoutes(page);
    await executorRoutes(page, {
      records: [executorRecord(7)],
      states: [],
      events: new Map(),
      tasks: new Map([
        [7, tasks.filter((task) => task.executor_id === 7).map(summary)],
      ]),
    });
    const searches = await namedTaskRoutes(page, tasks);
    const results = page.locator("#results");

    await test.step("Tasks: seven fields, Task first, External ID second", async () => {
      await page.goto(`${proxy.baseUrl}/?view=history&team=${TEAM}`);
      const layout = await expectTaskCollection(
        page,
        results,
        tasks.map(shown),
      );
      // Short values fit the desktop table.
      if (view.name === "desktop") expect(layout).toBe("table");
    });

    await test.step("Task name comes from the reply", async () => {
      // 1046's reply name is shown exactly; the composed text never is.
      await expect(
        results.getByRole("link", { name: "ops-9046", exact: true }),
      ).toHaveAttribute("href", `?view=task&team=${TEAM}&id=1046`);
      await expect(page.locator("main")).not.toContainText(`${TEAM_NAME}-1046`);
      // Two Sources, one external ID: two distinct task names and routes.
      for (const id of [1042, 1043])
        await expect(
          results.getByRole("link", {
            name: `${TEAM_NAME}-${id}`,
            exact: true,
          }),
        ).toHaveAttribute("href", `?view=task&team=${TEAM}&id=${id}`);
    });

    await test.step("Tasks: stacked records when fields do not fit", async () => {
      tasks[1].external_id = LONG_EXTERNAL;
      await page.reload();
      const layout = await expectTaskCollection(
        page,
        results,
        tasks.map(shown),
      );
      expect(layout).toBe("stacked");
      tasks[1].external_id = "PROJ-7";
    });

    await test.step("Operator searches by a task name", async () => {
      await page.goto(`${proxy.baseUrl}/?view=history&team=${TEAM}`);
      await expectTaskCollection(page, results, tasks.map(shown));
      const before = searches.length;
      await page.getByLabel("Search", { exact: true }).fill("ops-1042");
      // The term goes to task-manager unchanged, as the `search` parameter.
      await expect.poll(() => searches.slice(before).at(-1)).toBe("ops-1042");
      // Every search sent for the typed term is the term itself: no case
      // change, trimming or task-ID extraction.
      expect(searches.slice(before).filter((term) => term !== "")).toEqual(
        searches
          .slice(before)
          .filter((term) => term !== "")
          .map(() => "ops-1042"),
      );
      // The one returned row: ops-1042 with its External ID second; the
      // task whose external ID is OPS-1042 is not shown.
      await expectTaskCollection(page, results, [shown(tasks[0])]);
    });

    await test.step("Overview recent tasks lead with the task name", async () => {
      await page.goto(
        `${proxy.baseUrl}/?view=dashboard&team=${TEAM}&period=week&week=2026-W42`,
      );
      const recent = page.locator("section").filter({
        has: page.getByRole("heading", { name: "Recent tasks", exact: true }),
      });
      const layout = await expectTaskCollection(page, recent, tasks.map(shown));
      expect(layout).toBe(view.name === "desktop" ? "table" : "stacked");
    });

    await test.step("Executor claimed tasks lead with the task name", async () => {
      await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=7`);
      const claimed = page.locator("section").filter({
        has: page.getByRole("heading", { name: "Executor tasks", exact: true }),
      });
      const layout = await expectTaskCollection(
        page,
        claimed,
        tasks.filter((task) => task.executor_id === 7).map(shown),
      );
      expect(layout).toBe(view.name === "desktop" ? "table" : "stacked");
      // 1044's reply name is shown exactly; the composed text never is.
      await expect(
        claimed.getByRole("link", { name: "ops-9044", exact: true }),
      ).toHaveAttribute("href", `?view=task&team=${TEAM}&id=1044`);
      await expect(claimed).not.toContainText(`${TEAM_NAME}-1044`);
    });

    await test.step("Flow Tasks lead with the task name", async () => {
      await page.goto(`${proxy.baseUrl}/?view=flow&team=${TEAM}&id=1`);
      const flowTasks = page.locator("details").filter({
        has: page.getByRole("heading", { name: "Tasks", exact: true }),
      });
      const layout = await expectTaskCollection(
        page,
        flowTasks,
        tasks.filter((task) => task.flow_id === 1).map(shown),
      );
      expect(layout).toBe(view.name === "desktop" ? "table" : "stacked");
    });
  });
