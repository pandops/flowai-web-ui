import { captureDesignState, designViewport } from "../fixtures/design-capture";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: 1, team_name: "alpha" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

// One test, one step per original scenario; each step gets a fresh page so
// its query counter (503 on the second query) starts from zero.
test("v0034.15 Tasks restart and debounce failures recover the same filters on reload", async ({
  context,
}, info) => {
  test.setTimeout(60_000);
  const failures: unknown[] = [];
  for (const scenario of ["restart", "debounce"] as const) {
    const title = `v0034.15 Tasks ${scenario} failure recovers the same filters on reload without unhandled rejection`;
    const page = await context.newPage();
    try {
      await test.step(title, async () => {
        const queries: URL[] = [],
          errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route("**/ui/v1/operator/settings", (route) =>
          route.fulfill({
            json: { time_zone: "Europe/Moscow" },
            headers: { etag: '"op-1"' },
          }),
        );
        await page.route("**/ui/v1/teams/1/tasks?**", (route) => {
          const url = new URL(route.request().url());
          queries.push(url);
          if (url.searchParams.has("cursor"))
            return route.fulfill({
              status: 400,
              json: {
                code: "invalid_cursor",
                message: "Task continuation is invalid",
              },
            });
          if (queries.length === 2)
            return route.fulfill({
              status: 503,
              json: { code: "temporarily_unavailable" },
            });
          return route.fulfill({ json: { items: [], next_cursor: null } });
        });
        await page.goto(
          `${proxy.baseUrl}?view=history&team=1&date=2026-10-18${scenario === "restart" ? "&cursor=legacy" : ""}`,
        );
        if (scenario === "restart")
          await page
            .getByRole("button", { name: "Start from first page", exact: true })
            .click();
        else {
          await expect(
            page.getByText("Change or reset the current filters.", {
              exact: true,
            }),
          ).toBeVisible();
          await page.locator('[name="search"]').fill("retained-search");
        }
        await expect.poll(() => queries.length).toBe(2);
        await expect(page.locator("#results [role=alert]")).toContainText(
          /could not be loaded|unavailable|check the connection/i,
        );
        // Owner review 2026-10-25: the approved failure state has no in-place
        // Retry command; recovery reloads the URL-held filters.
        await expect(
          page.locator("#results").getByRole("button", { name: /retry/i }),
        ).toHaveCount(0);
        await page.reload();
        await expect.poll(() => queries.length).toBe(3);
        await expect(
          page.getByText("Change or reset the current filters.", {
            exact: true,
          }),
        ).toBeVisible();
        const query = queries[2].searchParams;
        expect(query.has("cursor")).toBe(false);
        expect(query.get("date")).toBe("2026-10-18");
        expect(query.get("time_zone")).toBe("Europe/Moscow");
        if (scenario === "debounce")
          expect(query.get("search")).toBe("retained-search");
        expect(errors).toEqual([]);
      });
    } catch (error) {
      failures.push(error);
      await info.attach(`${scenario}-failure`, {
        body: String(error),
        contentType: "text/plain",
      });
    } finally {
      await captureDesignState(
        page,
        info,
        proxy.webUIImageID,
        `final-${title}`,
      );
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Tasks read failure recovery");
});

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.3 missing Source names stay explicit without another-resource fallback ${theme} ${width}`, async ({
      page,
    }) => {
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const tasks = [
        {
          task_id: 8028,
          source_id: 8013,
          external_id: "known-source-task",
        },
        {
          task_id: 8029,
          source_id: 8014,
          external_id: "missing-source-task",
        },
      ].map((task) => ({
        ...task,
        task_name: `alpha-${task.task_id}`,
        flow_id: 8030,
        current_state: "queued",
        executor_id: null,
        ingested_at: "2026-10-18T00:00:00Z",
        claimed_at: null,
        completed_at: null,
        environment: {},
        secret_keys: [],
      }));
      await page.route("**/ui/v1/teams/1/tasks?**", (route) =>
        route.fulfill({ json: { items: tasks, next_cursor: null } }),
      );
      await page.route("**/ui/v1/sources?**", (route) =>
        route.fulfill({
          json: {
            items: [
              { source_id: tasks[0].source_id, name: "Only known Source" },
            ],
            next_cursor: null,
          },
        }),
      );
      await page.route("**/ui/v1/flows?**", (route) =>
        route.fulfill({
          json: {
            items: [{ flow_id: tasks[0].flow_id, name: "Shared Flow" }],
            next_cursor: null,
          },
        }),
      );
      await page.goto(`${proxy.baseUrl}?view=history&team=1`);
      const root = page.locator("#results");
      await expect(
        root.getByRole("link", { name: "Only known Source", exact: true }),
      ).toHaveAttribute("href", `?view=source&team=1&id=${tasks[0].source_id}`);
      const record = root.locator("tr:visible,article:visible").filter({
        has: page.getByRole("link", {
          name: tasks[1].task_name,
          exact: true,
        }),
      });
      await expect(
        record.getByText("Source name unavailable", { exact: true }),
      ).toBeVisible();
      await expect(
        record.getByRole("link", { name: "Only known Source", exact: true }),
      ).toHaveCount(0);
      await expect(
        record.locator(`a[href*="${tasks[1].source_id}"]`),
      ).toHaveCount(0);
      await expect(record).not.toContainText(String(tasks[1].source_id));
      await expect(
        record.getByRole("link", {
          name: tasks[1].task_name,
          exact: true,
        }),
      ).toHaveAttribute("href", `?view=task&team=1&id=${tasks[1].task_id}`);
    });

test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    info.title.includes("missing Source names")
      ? "task-history.html-source-unavailable"
      : `final-${info.title}`,
  );
});
