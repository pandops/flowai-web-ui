import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { startFakeGateway, type FakeGateway } from "../fixtures/fake_gateway";

let proxy: MockedProxy;
let registry: FakeGateway;
let initial: Pick<FakeGateway, "tasks" | "launchParameters">;
let stepRequests: () => string[];
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
// the default viewport and reads only its own proxy requests, so no step
// depends on another step's writes or order.
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
    const start = proxy.requests.length;
    stepRequests = () => proxy.requests.slice(start);
    await body();
  });
}

test("v0006.16/.17/.18/.19/.20/.21/.22/.29 Mission Control dashboard, history, task detail, executors, parameters, audit, keyboard and filters", async ({
  page,
}) => {
  // Eight original cases; v0006.29 alone makes twelve page loads.
  test.setTimeout(240_000);
  const viewport = page.viewportSize()!;
  await isolatedStep(
    page,
    viewport,
    "v0006.16 dashboard uses navigable complete calendar periods and subdued chart",
    async () => {
      await page.goto(proxy.baseUrl);
      await expect(
        page.getByRole("button", { name: "Add variable" }),
      ).toHaveCount(0);
      await expect(page.locator(".stat")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Day" })).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Week", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Month", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".week-nav[aria-label='Calendar period'] .month-label"),
      ).toHaveText(
        // The approved label appends the ISO week's date range.
        /^Week \d{2}, \d{4} · /,
      );
      await expect(page.locator("[data-count-fill]")).toHaveCount(7);
      await expect(
        page.getByRole("button", { name: "Next week" }),
      ).toBeDisabled();
      const currentWeekURL = page.url();
      await page.getByRole("button", { name: "Previous week" }).click();
      await expect(
        page.getByRole("button", { name: "Next week" }),
      ).toBeEnabled();
      await expect(page).not.toHaveURL(currentWeekURL);
      await page.goBack();
      await expect(page).toHaveURL(currentWeekURL);
      const color = await page
        .locator("[data-count-fill]")
        .first()
        .evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(color).not.toBe("rgb(254, 230, 0)");
      const heights = await page
        .locator("[data-count-fill]")
        .evaluateAll((elements) =>
          elements.map((element) =>
            parseFloat(getComputedStyle(element).height),
          ),
        );
      expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights));
      const taskDate = registry.tasks
        .find((task) => task.task_id === 3)!
        .ingested_at.slice(0, 10);
      const activeDay = page.locator(
        `[data-dashboard-date="${taskDate}"]:not(.zero):not(.future)`,
      );
      const selectedDate = await activeDay.getAttribute("data-dashboard-date");
      await activeDay.click();
      await expect(page).toHaveURL(
        new RegExp(`view=history.*date=${selectedDate}`),
      );
      await expect(page.getByLabel("Date")).toHaveValue(selectedDate!);
      await expect
        .poll(() =>
          stepRequests().some(
            (request) =>
              request.includes(`/tasks?`) &&
              request.includes(`date=${selectedDate}`),
          ),
        )
        .toBe(true);
      await expect(
        page.getByRole("link", { name: "alpha-3", exact: true }),
      ).toBeVisible();
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.18 task detail shows metadata, env and executor navigation",
    async () => {
      await page.goto(proxy.baseUrl);
      await page.getByRole("link", { name: "Tasks", exact: true }).click();
      await page.getByLabel("Search", { exact: true }).fill("external-3");
      await page.getByRole("link", { name: "alpha-3", exact: true }).click();
      const source = page
        .locator(".detail-grid")
        .getByRole("link", { name: "listener-alpha", exact: true });
      await expect(source).toBeVisible();
      await expect(source).toHaveAttribute("href", "?view=source&team=1&id=4");
      await expect(
        page.locator(".detail-grid").getByText("external-3", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("FLOWAI_VISIBLE=fixture-value"),
      ).toBeVisible();
      // v0034 lists secret references as "<key> · value hidden".
      await expect(
        page.getByText("FLOWAI_SECRET · value hidden"),
      ).toBeVisible();
      await page.reload();
      await expect(
        // v0050: the task detail heading is the task's name.
        page.getByRole("heading", { name: "alpha-3", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("link", { name: "Executor 7", exact: true })
        .first()
        .click();
      await expect(
        page.getByRole("heading", { name: "Executor 7", exact: true }),
      ).toBeVisible();
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.19 executor inventory and detail are read-only and minimally columned",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=executors`);
      await expect(page.getByRole("columnheader")).toHaveText([
        "Executor",
        "Type",
        "Tag",
        "Connection",
        "Reported IP",
        "Activity",
        "Available",
      ]);
      await page
        .locator("#results")
        .getByRole("link", { name: "7", exact: true })
        .click();
      // Activity and capacity come from journal's executor-states.
      const identity = page.locator("section").filter({
        has: page.getByRole("heading", { name: "Executor 7", exact: true }),
      });
      await expect(identity).toContainText(/\b1 claims?\b/);
      await expect(identity).toContainText("192.0.2.10");
      await expect(
        page.getByRole("heading", { name: "Executor events" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /зарегистрировать|удалить исполнитель|остановить/i,
        }),
      ).toHaveCount(0);
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.21 audit filters and renders only useful columns",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=audit`);
      await expect(page.getByRole("columnheader")).toHaveText([
        "Time",
        "Action",
        "Actor",
        "Resource",
        "Outcome",
      ]);
      await page.getByLabel("Action, actor, or resource").fill("11");
      await expect(
        page.getByRole("cell", { name: "11", exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole("columnheader", {
          name: /request_id|audit_id|team_id/i,
        }),
      ).toHaveCount(0);
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.17 task history filters, paginates and omits unused columns",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=history`);
      await expect(
        page.locator("main .toolbar").getByLabel("Rows per page"),
      ).toHaveValue("10");
      await page.getByLabel("Search", { exact: true }).fill("external-3");
      await expect(
        page.getByRole("link", { name: "alpha-3", exact: true }),
      ).toBeVisible();
      // v0050: Task (the reply's task name) first, External ID second.
      await expect(page.getByRole("columnheader")).toHaveText([
        "Task",
        "External ID",
        "Time",
        "Task Source",
        "Flow",
        "Status",
        "Duration",
      ]);
      await expect(
        page.getByRole("columnheader", {
          name: /team_id|cursor|request_id|scope_token/i,
        }),
      ).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator(".cards .card").first()).toBeVisible();
      await expect(page.locator("table")).toBeHidden();
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.22 keyboard and responsive states remain operable",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(proxy.baseUrl);
      // Approved phone header: a "Menu" command beside the current-page title,
      // named by what it does; the skip link is the first stop.
      const menu = page.locator("#mobile-menu-toggle");
      const current = page.locator("[data-current-page]");
      await expect(menu).toBeVisible();
      await expect(menu).toHaveAccessibleName("Open navigation");
      await expect(menu).toHaveText("Menu");
      await expect(current).toHaveText("Overview");
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("link", { name: "Skip to main content", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(menu).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(menu).toHaveAttribute("aria-expanded", "true");
      await expect(menu).toHaveAccessibleName("Close navigation");
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Overview" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toBeFocused();
      await page.keyboard.press("Enter");
      for (const name of ["Overview", "Flows", "Tasks"]) {
        await page.keyboard.press("Tab");
        await expect(
          page.getByRole("link", { name, exact: true }),
        ).toBeFocused();
      }
      await page.keyboard.press("Enter");
      await expect(current).toHaveText("Tasks");
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await expect(menu).toBeFocused();
      await expect(page).toHaveURL(/view=history/);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
      await expect(page.getByText("Create task")).toHaveCount(0);
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.29 every rendered filter matches the view manifest on desktop and mobile",
    async () => {
      const manifest: Array<[string, string[], () => Promise<unknown>]> = [
        ["dashboard", ["period"], async () => page.goto(proxy.baseUrl)],
        [
          "history",
          ["search", "status", "period", "date", "limit"],
          async () => page.goto(`${proxy.baseUrl}?view=history`),
        ],
        [
          "executors",
          ["search", "activity", "connection", "limit"],
          async () => page.goto(`${proxy.baseUrl}?view=executors`),
        ],
        [
          "parameters",
          ["scope", "limit"],
          async () => page.goto(`${proxy.baseUrl}?view=parameters`),
        ],
        [
          "audit",
          ["search", "limit"],
          async () => page.goto(`${proxy.baseUrl}?view=audit`),
        ],
        [
          "executor tasks",
          ["status", "limit"],
          async () => {
            await page.goto(`${proxy.baseUrl}?view=executors`);
            await page
              .locator("#results")
              .getByRole("link", { name: "7", exact: true })
              .click();
          },
        ],
      ];
      const keys = async () =>
        await page
          .locator("[data-filter-key]:visible")
          .evaluateAll((elements) =>
            elements
              .map((element) => element.getAttribute("data-filter-key"))
              .sort(),
          );
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : width === 820 ? 1180 : 900 });
        for (const [, expected, open] of manifest) {
          await open();
          await expect.poll(keys).toEqual([...expected].sort());
        }
      }

      await page.goto(`${proxy.baseUrl}?view=history`);
      await page.getByLabel("Search", { exact: true }).fill("does-not-exist");
      await expect(
        page.getByText("Change or reset the current filters."),
      ).toBeVisible();
      await page.getByRole("button", { name: "Reset" }).click();
      await expect(
        page.getByRole("link", { name: "alpha-3", exact: true }),
      ).toBeVisible();

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
      await expect.poll(keys).toEqual(["limit", "limit", "scope"]);
      await page
        .locator("#history-dialog")
        .getByLabel("Rows per page")
        .selectOption("25");
      await expect
        .poll(() =>
          stepRequests().some((request) =>
            request.includes("/revisions?limit=25"),
          ),
        )
        .toBe(true);
      await page.getByRole("button", { name: "Close" }).click();
      const secretActions = page.getByRole("button", {
        name: "Actions for FLOWAI_SECRET",
        exact: true,
      });
      // The step restores the fixture, so FLOWAI_SECRET always exists here
      // whatever ran before; its Versions dialog is checked unconditionally.
      await expect(secretActions).toBeVisible();
      await secretActions.click();
      await page
        .getByRole("menuitem", { name: "Versions", exact: true })
        .click();
      await expect.poll(keys).toEqual(["limit", "limit", "scope"]);
      await page
        .locator("#history-dialog")
        .getByLabel("Rows per page")
        .selectOption("50");
      await expect
        .poll(() =>
          stepRequests().some((request) =>
            request.includes("/versions?limit=50"),
          ),
        )
        .toBe(true);
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.20 launch parameter UI accepts explicit env and secret keys",
    async () => {
      await page.goto(`${proxy.baseUrl}?view=parameters`);
      await page
        .getByRole("button", {
          name: "Actions for FLOWAI_VISIBLE",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", { name: "Edit variable", exact: true })
        .click();
      await page
        .locator("#edit-env-dialog")
        .getByLabel("New value", { exact: true })
        .fill("updated-value");
      await page
        .getByRole("button", { name: "Save variable", exact: true })
        .click();
      await expect(
        page
          .locator("#definitions tr:visible,#definitions article:visible")
          .filter({
            has: page.getByRole("link", {
              name: "FLOWAI_VISIBLE",
              exact: true,
            }),
          }),
      ).toContainText("updated-value");
      await page
        .getByRole("button", { name: "Create parameter", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Add secret", exact: true })
        .click();
      await page
        .locator("#secret-dialog")
        .getByLabel("Target definition", { exact: true })
        .selectOption("1");
      await page
        .locator("#secret-dialog")
        .getByLabel("Key name", { exact: true })
        .fill("NEW_SECRET_KEY");
      await page
        .locator("#secret-dialog")
        .getByLabel("New secret value")
        .fill("never-render-me");
      await page.getByRole("button", { name: "Save secret" }).click();
      await expect(
        page
          .locator("#definitions tr:visible,#definitions article:visible")
          .filter({
            has: page.getByRole("link", {
              name: "NEW_SECRET_KEY",
              exact: true,
            }),
          }),
      ).toContainText("value hidden");
      await expect(page.getByText("never-render-me")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Actions for FLOWAI_SECRET", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Replace secret", exact: true })
        .click();
      await page
        .locator("#replace-secret-dialog")
        .getByLabel("New secret value")
        .fill("replacement-never-render-me");
      await page
        .locator("#replace-secret-dialog")
        .getByRole("button", { name: "Replace secret", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Actions for FLOWAI_SECRET", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Versions", exact: true })
        .click();
      await expect(page.getByText("Version 2")).toBeVisible();
      await page.getByRole("button", { name: "Close" }).click();
      await page
        .getByRole("button", { name: "Actions for FLOWAI_SECRET", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Delete secret", exact: true })
        .click();
      // v0034 confirms deletion in the in-app dialog, not a native prompt.
      await page
        .locator("#parameter-delete-dialog")
        .getByRole("button", { name: "Delete secret", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "FLOWAI_SECRET", exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText("replacement-never-render-me")).toHaveCount(
        0,
      );
    },
  );
});
