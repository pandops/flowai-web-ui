import path from "node:path";
import { test, expect } from "../fixtures/owned-test";
import { captureDesignState, designViewport } from "../fixtures/design-capture";
import { flowFixture, flowID, secondFlowID } from "../fixtures/v0034-flow";
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
test.use({ actionTimeout: 10_000 });

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.12 canonical Flow detail states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(180_000);
      const captured: string[] = [];
      for (const state of [
        "default",
        "loading",
        "unavailable",
        "error",
        "usage-unknown",
        "release",
        "task-loading",
        "task-empty",
        "task-error",
        "tasks-collapsed",
        "tasks-page-2",
        "tasks-foreign-candidate",
      ]) {
        const page = await context.newPage();
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const failures: unknown[] = [];
        try {
          await page.setViewportSize(designViewport(width));
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          const { writes, flows } = await flowFixture(page, true);
          const other =
            state === "release" || state === "tasks-foreign-candidate";
          const id =
            state === "unavailable"
              ? "unknown-flow"
              : other
                ? secondFlowID
                : flowID;
          const flow = flows.get(other ? secondFlowID : flowID)!;
          // The approved release sample is a promptless flow: no agent,
          // image override or prompt template, so Flow detail omits the
          // whole Prompt and execution section.
          if (other)
            Object.assign(flow, {
              name: "Release checks",
              prompt_template: null,
              default_image: null,
            });
          Object.assign(flow, {
            source_ids: [7008],
            source_revisions: { queue: 1 },
          });
          await page.route("**/ui/v1/sources?**", (route) =>
            route.fulfill({
              json: {
                items: [{ source_id: 7008, name: "Queue" }],
                next_cursor: null,
              },
            }),
          );
          let flowFaultReads = 0,
            usageFaultReads = 0,
            taskFaultReads = 0;
          if (["loading", "unavailable", "error"].includes(state))
            await page.route(`**/ui/v1/flows/${id}`, async (route) => {
              flowFaultReads++;
              if (state === "loading") {
                await held;
                await route.fallback();
              } else
                await route.fulfill({
                  status: state === "unavailable" ? 404 : 503,
                  json: {
                    code:
                      state === "unavailable"
                        ? "not_found"
                        : "temporarily_unavailable",
                  },
                });
            });
          if (state === "usage-unknown")
            await page.route(
              `**/ui/v1/flow-llm-settings/${id}`,
              async (route) => {
                usageFaultReads++;
                await route.fulfill({
                  status: 503,
                  json: { code: "model_gateway_unavailable" },
                });
              },
            );
          const task = (index: number, target = id) => ({
            task_id: 9300 + index,
            task_name: `alpha-${9300 + index}`,
            flow_id: target,
            source_id: 7008,
            external_id: `visible-task-${index}`,
            current_state: "finished",
            ingested_at: `2026-10-18T00:${String(index).padStart(2, "0")}:00Z`,
            claimed_at: `2026-10-18T00:${String(index).padStart(2, "0")}:01Z`,
            completed_at: `2026-10-18T00:${String(index).padStart(2, "0")}:02Z`,
            executor_id: null,
          });
          const queries: URL[] = [];
          await page.route("**/ui/v1/teams/1/tasks?**", async (route) => {
            const query = new URL(route.request().url());
            queries.push(query);
            if (state === "task-loading") {
              taskFaultReads++;
              await held;
            }
            if (state === "task-error") {
              taskFaultReads++;
              return route.fulfill({
                status: 503,
                json: { code: "temporarily_unavailable" },
              });
            }
            const continuation = query.searchParams.get("cursor");
            const items =
              state === "task-empty"
                ? []
                : state === "tasks-foreign-candidate"
                  ? continuation
                    ? [task(1)]
                    : [task(0, flowID)]
                  : state === "tasks-page-2"
                    ? Array.from({ length: continuation ? 2 : 10 }, (_, i) =>
                        task(i + (continuation ? 10 : 0)),
                      )
                    : [task(0), task(1)];
            return route.fulfill({
              json: {
                items,
                next_cursor:
                  !continuation &&
                  ["tasks-page-2", "tasks-foreign-candidate"].includes(state)
                    ? "next"
                    : null,
              },
            });
          });
          await page.goto(`${proxy.baseUrl}?view=flow&team=1&id=${id}`);
          const root = page.locator("#flow-detail"),
            preview = root.locator("[data-flow-tasks]");
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          if (state === "loading") {
            await expect.poll(() => flowFaultReads).toBe(1);
            await expect(root).toContainText("Loading Flow");
            await expect(
              root.getByRole("heading", { name: flow.name, exact: true }),
            ).toHaveCount(0);
          } else if (["unavailable", "error"].includes(state)) {
            await expect.poll(() => flowFaultReads).toBe(1);
            await expect(root.getByRole("alert")).toContainText(
              state === "unavailable"
                ? "Flow unavailable"
                : "Flow could not be loaded",
            );
            // Approved flow-detail.html: Retry Flow only for a failed read;
            // both states keep the way back to the catalog.
            await expect(
              root.getByRole("link", { name: "Retry Flow", exact: true }),
            ).toHaveCount(state === "error" ? 1 : 0);
            await expect(
              root.getByRole("link", { name: "Back to Flows", exact: true }),
            ).toBeVisible();
            await expect(
              root.getByRole("heading", { name: flow.name, exact: true }),
            ).toHaveCount(0);
          } else {
            await expect(
              root.getByRole("heading", { name: "Flow identity", exact: true }),
            ).toBeVisible();
            // The approved design keeps the Flow name inside Flow identity,
            // never as its own heading.
            await expect(
              root.getByRole("heading", { name: flow.name, exact: true }),
            ).toHaveCount(0);
            // Approved Flow detail separates read-only configuration groups;
            // a promptless flow has no Prompt and execution group.
            await expect(
              root.locator(":scope > .flow-detail-grid h2"),
            ).toHaveText(
              other
                ? [
                    "Flow identity",
                    "Models in order",
                    "Limits",
                    // v0048 flow-detail.html: the Retries and release group.
                    "Retries and release",
                    "Usage",
                    "Bound Sources",
                  ]
                : [
                    "Flow identity",
                    "Models in order",
                    "Prompt and execution",
                    "Limits",
                    // v0048 flow-detail.html: the Retries and release group.
                    "Retries and release",
                    "Usage",
                    "Bound Sources",
                  ],
            );
            const columns = await root
              .locator(".flow-detail-column")
              .evaluateAll((items) =>
                items.map((item) => {
                  const box = item.getBoundingClientRect();
                  return {
                    x: box.x,
                    y: box.y,
                    right: box.right,
                    bottom: box.bottom,
                  };
                }),
              );
            expect(columns).toHaveLength(2);
            if (width === 1440) {
              expect(Math.abs(columns[0].y - columns[1].y)).toBeLessThan(1);
              expect(columns[1].x).toBeGreaterThanOrEqual(columns[0].right);
            } else {
              expect(Math.abs(columns[0].x - columns[1].x)).toBeLessThan(1);
              expect(columns[1].y).toBeGreaterThanOrEqual(columns[0].bottom);
            }
            const identity = root.locator("section").filter({
              has: page.getByRole("heading", {
                name: "Flow identity",
                exact: true,
              }),
            });
            await expect(
              identity
                .locator("dt")
                .filter({ hasText: /^Flow ID$/ })
                .locator("+ dd"),
            ).toHaveText(String(id));
            await expect(identity).toContainText(flow.name);
            expect(
              await root
                .locator("[data-flow-task-disclosure]")
                .evaluate(
                  (tasks) =>
                    !!(
                      tasks.compareDocumentPosition(
                        tasks.parentElement!.querySelector(
                          ".flow-detail-grid",
                        )!,
                      ) & Node.DOCUMENT_POSITION_FOLLOWING
                    ),
                ),
            ).toBe(true);
            await expect(
              root.locator("[data-edit-current-flow]"),
            ).toBeVisible();
            const href = new URL(
              (await root
                .locator("[data-edit-current-flow]")
                .getAttribute("href")) || "",
              proxy.baseUrl,
            );
            expect(href.searchParams.get("id")).toBe(String(id));
            expect(href.searchParams.get("view")).toBe("flows");
            if (state === "usage-unknown") {
              await expect.poll(() => usageFaultReads).toBe(1);
              await expect(root.getByRole("alert")).toHaveText(
                /Usage is unavailable from the gateway/,
              );
            }
            if (state === "task-loading") {
              await expect.poll(() => taskFaultReads).toBe(1);
              await expect(preview.getByRole("status")).toHaveText(
                "Loading tasks…",
              );
            } else if (state === "task-error") {
              await expect.poll(() => taskFaultReads).toBe(1);
              await expect(preview.getByRole("alert")).toContainText(
                "Tasks could not be loaded",
              );
              await expect(
                preview.getByRole("button", {
                  name: "Retry tasks",
                  exact: true,
                }),
              ).toBeVisible();
              await expect(preview).not.toContainText("No tasks for this Flow");
            } else if (state === "task-empty") {
              await expect(preview).toContainText("No tasks for this Flow");
            } else {
              // Approved flow-detail.html names the table by its Flow; narrow
              // widths hide the table behind cards, so check the markup.
              await expect(
                preview.locator(`table[aria-label="Tasks for ${flow.name}"]`),
              ).toHaveCount(1);
              await expect(
                preview.getByRole("link", { name: /^alpha-93\d\d$/ }),
              ).toHaveCount(
                state === "tasks-page-2"
                  ? 10
                  : state === "tasks-foreign-candidate"
                    ? 1
                    : 2,
              );
              if (state === "tasks-page-2") {
                await preview
                  .getByRole("button", { name: "Next", exact: true })
                  .click();
                await expect(preview).toContainText("Showing 11–12");
                await expect(
                  preview.getByRole("link", { name: /^alpha-93\d\d$/ }),
                ).toHaveText(["alpha-9310", "alpha-9311"]);
                await expect(
                  preview.getByRole("button", { name: "Next", exact: true }),
                ).toBeDisabled();
              }
              if (state === "tasks-foreign-candidate") {
                expect(queries).toHaveLength(2);
                await expect(preview).not.toContainText("visible-task-0");
                await expect(
                  preview.getByRole("link", {
                    name: "alpha-9301",
                    exact: true,
                  }),
                ).toBeVisible();
              }
              if (state === "tasks-collapsed") {
                await root
                  .locator("[data-flow-task-disclosure] > summary")
                  .click();
                await expect(
                  root.locator("[data-flow-task-disclosure]"),
                ).toHaveJSProperty("open", false);
                await expect(preview).toBeHidden();
                await expect(
                  root.getByRole("heading", {
                    name: "Flow identity",
                    exact: true,
                  }),
                ).toBeVisible();
              }
            }
            for (const query of queries) {
              expect(query.searchParams.get("search")).toBe(String(id));
              expect(query.searchParams.get("limit")).toBe("10");
            }
          }
          expect(writes).toEqual([]);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await captureDesignState(
            page,
            test.info(),
            proxy.webUIImageID,
            `flow-detail.html-${state}-${theme}-${width}`,
          );
          captured.push(state);
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
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(
            failures,
            `Flow ${state} presentation or cleanup failed`,
          );
      }
      expect(captured).toHaveLength(12);
      await test.info().attach("flow-detail-state-captures", {
        contentType: "application/json",
        body: JSON.stringify({
          theme,
          width,
          captured,
          presentation_fixture_only: true,
        }),
      });
    });
