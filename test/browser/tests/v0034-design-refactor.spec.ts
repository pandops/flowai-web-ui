import { captureDesignState, designViewport } from "../fixtures/design-capture";
import { Stage0Cells } from "../fixtures/stage0-cells";
import {
  cancelSourceWizard,
  createSourceEntry,
  sourceWizard,
} from "../fixtures/source-wizard";
import { parameterFixture } from "../fixtures/v0034-parameters";
import path from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// The proxy is a presentation fixture. It serves the actual built Web UI image;
// persistence/authorization cases require the separate real-service fixture.
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [
        { team_id: 1, team_name: "alpha" },
        { team_id: 2, team_name: "beta" },
      ],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

// A merged test runs each original check as a step on its own page, so no
// route, listener, init script or document state crosses steps. Held route
// handlers are released by the step itself before this cleanup.
async function withPage(
  context: BrowserContext,
  body: (page: Page) => Promise<void>,
) {
  const page = await context.newPage();
  try {
    await body(page);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
  }
}

// A step that needs browser storage of its own runs in a fresh context.
async function withFreshContext(
  browser: Browser,
  body: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext();
  try {
    await body(await context.newPage());
  } finally {
    await context.close();
  }
}

test("v0034.15 Operator suggests browser zone and saves only explicitly dark and light", async ({
  context,
}) => {
  test.setTimeout(60_000);
  for (const theme of ["dark", "light"] as const)
    await test.step(`v0034.15 Operator suggests browser zone and saves only explicitly ${theme}`, () =>
      withPage(context, async (page) => {
        let preference: string | null = null;
        let revision = 0;
        const writes: unknown[] = [];
        await page.addInitScript(
          (value) => localStorage.setItem("flowai.theme", value),
          theme,
        );
        await page.route("**/ui/v1/operator/settings", async (route) => {
          const request = route.request();
          if (request.method() === "PUT") {
            expect(request.headers()["if-match"]).toBe(`"op-${revision}"`);
            const body = request.postDataJSON();
            expect(Object.keys(body)).toEqual(["time_zone"]);
            writes.push(body);
            preference = body.time_zone;
            revision++;
          } else expect(request.method()).toBe("GET");
          await route.fulfill({
            json: { time_zone: preference },
            headers: { etag: `"op-${revision}"`, "cache-control": "no-store" },
          });
        });
        await page.goto(`${proxy.baseUrl}?view=settings&section=operator`);
        await expect(
          page.getByRole("combobox", { name: "Team", exact: true }),
        ).toBeVisible();
        const zone = page.getByLabel("Time zone", { exact: true });
        await expect(zone).toBeVisible();
        await expect(zone).toHaveValue("UTC");
        expect(writes).toEqual([]);
        await zone.fill("Europe/Moscow");
        expect(writes).toEqual([]);
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect
          .poll(() => writes)
          .toEqual([{ time_zone: "Europe/Moscow" }]);
        await page.reload();
        await expect(zone).toHaveValue("Europe/Moscow");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const local = await page.evaluate(() => ({ ...localStorage }));
        expect(local).toEqual({ "flowai.theme": theme });
        await page
          .getByRole("combobox", { name: "Team", exact: true })
          .selectOption("2");
        await expect(zone).toHaveValue("Europe/Moscow");
        expect(writes).toHaveLength(1);
      }));
});

// One page per scenario: each keeps its own route state machine and init
// script (the Intl override stays on the detection-failure page).
test("v0034.15 Operator pre-save focus read, Cancel and detection fallback, lost Save, dirty draft on focus", async ({
  context,
}) => {
  test.setTimeout(90_000);
  await test.step("v0034.15 Operator ignores a pre-save focus read arriving after confirmed Save", () =>
    withPage(context, async (page) => {
      let current = { zone: "UTC", revision: 1 };
      let hold = false;
      let release!: () => void;
      let captured = false;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/ui/v1/operator/settings", async (route) => {
        const request = route.request();
        if (request.method() === "PUT") {
          current = { zone: request.postDataJSON().time_zone, revision: 2 };
        }
        const snapshot = { ...current };
        if (request.method() === "GET" && hold) {
          hold = false;
          captured = true;
          await held;
        }
        await route.fulfill({
          json: { time_zone: snapshot.zone },
          headers: {
            etag: `"op-${snapshot.revision}"`,
            "cache-control": "no-store",
          },
        });
      });
      try {
        await page.goto(`${proxy.baseUrl}?view=settings&section=operator`);
        const zone = page.getByLabel("Time zone", { exact: true });
        await expect(zone).toHaveValue("UTC");
        await page.bringToFront();
        hold = true;
        await page.evaluate(() => dispatchEvent(new Event("focus")));
        await expect.poll(() => captured).toBe(true);
        await zone.fill("Europe/Moscow");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(
          page.getByText("Saved time zone: Europe/Moscow.", { exact: true }),
        ).toBeVisible();
        const response = page.waitForResponse(
          (response) =>
            response.url().endsWith("/ui/v1/operator/settings") &&
            response.request().method() === "GET",
        );
        release();
        const old = await response;
        expect(old.headers().etag).toBe('"op-1"');
        await old.finished();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
        await expect(zone).toHaveValue("Europe/Moscow");
        await expect(
          page.getByText("Saved time zone: Europe/Moscow.", { exact: true }),
        ).toBeVisible();
      } finally {
        release();
      }
    }));
  await test.step("v0034.15 Operator offers Cancel and explains detection failure UTC fallback", () =>
    withPage(context, async (page) => {
      await page.addInitScript(() => {
        Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
          apply(target, self, args) {
            if (args.length === 0)
              throw new Error("Timezone detection unavailable");
            return Reflect.apply(target, self, args);
          },
        });
      });
      await page.goto(`${proxy.baseUrl}?view=settings&section=operator`);
      const zone = page.getByLabel("Time zone", { exact: true });
      await expect(zone).toHaveValue("UTC");
      await expect(page.getByText(/could not be detected.*UTC/i)).toBeVisible();
      await zone.fill("Europe/Moscow");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(zone).toHaveValue("UTC");
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toBeEnabled();
    }));
  await test.step("v0034.15 Operator reconciles lost Save without retry and rejects unavailable fallback", () =>
    withPage(context, async (page) => {
      let available = false;
      let zone: string | null = null;
      let revision = 0;
      let writes = 0;
      await page.route("**/ui/v1/operator/settings", async (route) => {
        if (route.request().method() === "PUT") {
          writes++;
          zone = route.request().postDataJSON().time_zone;
          revision++;
          await route.abort("connectionreset");
          return;
        }
        if (!available) {
          await route.fulfill({
            status: 503,
            json: { code: "operator_settings_unavailable" },
          });
          return;
        }
        await route.fulfill({
          json: { time_zone: zone },
          headers: { etag: `"op-${revision}"` },
        });
      });
      await page.goto(`${proxy.baseUrl}?view=settings&section=operator`);
      const save = page.getByRole("button", { name: "Save", exact: true });
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Operator settings could not be loaded" }),
      ).toBeVisible();
      await expect(save).toBeDisabled();
      expect(writes).toBe(0);
      available = true;
      await page
        .getByRole("button", { name: "Reload saved setting", exact: true })
        .click();
      await expect(save).toBeEnabled();
      await page.getByLabel("Time zone", { exact: true }).fill("Europe/Moscow");
      await save.click();
      await expect.poll(() => writes).toBe(1);
      await expect(
        page.getByRole("status").filter({ hasText: "Your draft is retained" }),
      ).toBeVisible();
      await expect(save).toBeDisabled();
      await page
        .getByRole("button", { name: "Reload saved setting", exact: true })
        .click();
      await expect(page.getByLabel("Time zone", { exact: true })).toHaveValue(
        "Europe/Moscow",
      );
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Saved time zone: Europe/Moscow" }),
      ).toBeVisible();
      expect(writes).toBe(1);
    }));
  await test.step("v0034.15 Operator focus preserves dirty draft and reloads another device's saved preference", () =>
    withPage(context, async (page) => {
      let zone = "UTC";
      let revision = 1;
      let writes = 0;
      await page.route("**/ui/v1/operator/settings", async (route) => {
        if (route.request().method() !== "GET") writes++;
        await route.fulfill({
          json: { time_zone: zone },
          headers: { etag: `"op-${revision}"` },
        });
      });
      await page.goto(`${proxy.baseUrl}?view=settings&section=operator`);
      const input = page.getByLabel("Time zone", { exact: true });
      await expect(input).toHaveValue("UTC");
      await input.fill("Asia/Kolkata");
      zone = "Europe/Moscow";
      revision++;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("status").filter({ hasText: "Your draft is retained" }),
      ).toBeVisible();
      await expect(input).toHaveValue("Asia/Kolkata");
      await expect(
        page.getByRole("button", { name: "Save", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Reload saved setting", exact: true })
        .click();
      await expect(input).toHaveValue("Europe/Moscow");
      zone = "Pacific/Apia";
      revision++;
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(input).toHaveValue("Pacific/Apia");
      expect(writes).toBe(0);
    }));
});

// Expand this presentation matrix with each slice's real route/state fixture
// before its production edit. No generated mockup is loaded by these checks.
for (const width of [390, 820, 1440])
  for (const theme of ["dark", "light"] as const)
    test(`v0034.12 v0034.2 shell destinations and dashboard, history, executors, sources, flows, settings, audit presentation ${theme} ${width}`, async ({
      context,
    }, info) => {
      test.setTimeout(120_000);
      await test.step(`v0034.2 shell destinations ${theme} ${width}`, () =>
        withPage(context, async (page) => {
          await page.setViewportSize({ width, height: width === 390 ? 844 : width === 820 ? 1180 : 900 });
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          await page.goto(proxy.baseUrl);
          await expect(
            page.getByRole("combobox", { name: "Team", exact: true }),
          ).toBeVisible();
          if (width === 390)
            await page
              .getByRole("button", { name: /^(Open|Close) navigation$/ })
              .click();
          await expect(page.locator(".brand strong")).toHaveText("FlowAI v2");
          await expect(page.locator(".brand small")).toHaveText(
            "OPERATOR CONSOLE",
          );
          // Exact shell tokens/metrics from the approved versioned dashboard export.
          const colors =
            theme === "dark"
              ? {
                  fg: "rgb(248, 250, 252)",
                  muted: "rgb(159, 172, 191)",
                  border: "rgb(102, 121, 147)",
                  raised: "rgb(32, 42, 58)",
                }
              : {
                  fg: "rgb(23, 32, 46)",
                  muted: "rgb(82, 97, 118)",
                  border: "rgb(104, 119, 139)",
                  raised: "rgb(238, 242, 247)",
                };
          const shellStyles = await page.evaluate(() => {
            const mark = document.querySelector(".brand-mark")!,
              small = document.querySelector(".brand small")!,
              selected = document.querySelector(
                '.nav-links [aria-current="page"]',
              )!,
              eyebrow = document.querySelector("#app .eyebrow")!;
            const markStyle = getComputedStyle(mark),
              navStyle = getComputedStyle(selected),
              titleStyle = getComputedStyle(eyebrow);
            return {
              markWidth: mark.getBoundingClientRect().width,
              markHeight: mark.getBoundingClientRect().height,
              markColor: markStyle.color,
              markBorder: markStyle.borderTopColor,
              subtitleSize: getComputedStyle(small).fontSize,
              navColor: navStyle.color,
              navBorder: navStyle.borderTopColor,
              navBackground: navStyle.backgroundColor,
              navWeight: navStyle.fontWeight,
              eyebrowColor: titleStyle.color,
              eyebrowWeight: titleStyle.fontWeight,
              eyebrowSpacing: titleStyle.letterSpacing,
            };
          });
          expect(shellStyles).toEqual({
            // The mobile drawer intentionally hides the brand block.
            markWidth: width === 390 ? 0 : 32,
            markHeight: width === 390 ? 0 : 32,
            markColor: colors.fg,
            markBorder: colors.border,
            subtitleSize: "11px",
            navColor: colors.fg,
            navBorder: colors.border,
            navBackground: colors.raised,
            navWeight: "550",
            eyebrowColor: colors.muted,
            eyebrowWeight: "600",
            eyebrowSpacing: "1.1px",
          });
          const links = page.locator(".nav-links a");
          await expect(links).toHaveText([
            "Overview",
            "Flows",
            "Tasks",
            "Sources",
            "Settings",
          ]);
          const settings = page.locator(".nav-links").getByRole("link", {
            name: "Settings",
            exact: true,
          });
          await expect(settings).toBeVisible();
          await settings.click();
          await expect(
            page
              .getByRole("navigation", { name: "Settings sections" })
              .getByRole("link"),
          ).toHaveText(["Parameters", "Models", "Executors", "Operator"]);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
        }));
      for (const view of [
        "dashboard",
        "history",
        "executors",
        "sources",
        "flows",
        "settings",
        "audit",
      ])
        await test.step(`v0034.12 ${view} ${theme} ${width} presentation`, () =>
          withPage(context, async (page) => {
            await page.setViewportSize({
              width,
              height: width === 390 ? 844 : width === 820 ? 1180 : 900,
            });
            await page.addInitScript(
              (value) => localStorage.setItem("flowai.theme", value),
              theme,
            );
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await page.goto(`${proxy.baseUrl}?view=${view}`);
            await expect(
              page.getByRole("combobox", { name: "Team", exact: true }),
            ).toBeVisible();
            const headings: Record<string, RegExp> = {
              dashboard: /^Overview$/,
              history: /^(Task history|Tasks)$/,
              executors: /^Executors$/,
              sources: /^Sources$/,
              flows: /^Flows$/,
              settings: /^Parameters$/,
              audit: /^(Audit log|Audit)$/,
            };
            await expect(
              page.getByRole("heading", { name: headings[view], level: 1 }),
            ).toBeVisible();
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
            expect(errors).toEqual([]);
            await page.screenshot({
              path: info.outputPath(`${view}-${theme}-${width}.png`),
              fullPage: true,
            });
          }));
    });

test("v0034.2 modal theme keeps safe draft selection and focus containment", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${proxy.baseUrl}?view=settings`);
  await expect(
    page.getByRole("heading", { name: "Parameters", exact: true }),
  ).toBeVisible();
  const plus = page.getByRole("button", {
    name: "Create parameter",
    exact: true,
  });
  if (await plus.isVisible()) {
    await plus.click();
    await page
      .getByRole("menuitem", { name: "Add variable", exact: true })
      .click();
  } else {
    await page
      .getByRole("button", { name: "Add variable", exact: true })
      .click();
  }
  const dialog = page.locator("#env-dialog");
  await expect(dialog).toBeVisible();
  const key = dialog.getByLabel("Key name", { exact: true });
  await key.fill("SAFE_DRAFT");
  await key.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(2, 7),
  );
  const toggle = dialog.getByRole("button", {
    name: "Switch to light theme",
    exact: true,
  });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(key).toHaveValue("SAFE_DRAFT");
  expect(
    await key.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("v0034.1 explicit choice preserves query and makes no backend request", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.route("**/ui/v1/teams/*/tasks?**", (route) =>
    route.fulfill({
      json: { items: [], next_cursor: null },
    }),
  );
  // The history view opens its team stream on load; measure after it.
  const initialStream = page.waitForEvent("websocket");
  await page.goto(`${proxy.baseUrl}?view=history&search=fixture`);
  await expect(
    page.getByRole("combobox", { name: "Team", exact: true }),
  ).toBeVisible();
  await initialStream;
  const requests: string[] = [];
  const sockets: string[] = [];
  // Wait for the initial surface to settle (the app canonicalizes team and
  // page size into the query) before measuring the presentation action.
  await expect(page.locator("#results")).not.toBeEmpty();
  const url = page.url();
  expect(new URL(url).searchParams.get("search")).toBe("fixture");
  expect(new URL(url).searchParams.get("view")).toBe("history");
  page.on("request", (request) => requests.push(request.url()));
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(page.url()).toBe(url);
  expect(await page.evaluate(() => localStorage.getItem("flowai.theme"))).toBe(
    "light",
  );
  expect(requests).toEqual([]);
  expect(sockets).toEqual([]);
  expect(proxy.requests.some((request) => request.includes("/ui/"))).toBe(true);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("v0034.1 OS tracking and cross-tab preference removal", async ({
  page,
  context,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(proxy.baseUrl);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const other = await context.newPage();
  await other.emulateMedia({ colorScheme: "light" });
  await other.goto(proxy.baseUrl);
  await page
    .getByRole("button", { name: "Switch to light theme", exact: true })
    .click();
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await other
    .getByRole("button", { name: "Switch to dark theme", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.evaluate(() => localStorage.removeItem("flowai.theme"));
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await other.close();
});

for (const theme of ["dark", "light"] as const)
  test(`v0034.3 task records use seven full-text fields and canonical task-name links ${theme}`, async ({
    context,
  }) => {
    test.setTimeout(90_000);
    for (const width of [390, 820, 1440])
      await test.step(`v0034.3 task records use seven full-text fields and canonical task-name links ${theme} ${width}`, () =>
        withPage(context, async (page) => {
          // A long identifier that still fits two table lines; the approved
          // page-next sample stacks identifiers longer than 64 characters.
          let external = "upstream-" + "long-readable-identifier-".repeat(2);
          const tasks = ["a", "b"].map((suffix, index) => ({
            task_id: 7101 + index,
            task_name: `alpha-${7101 + index}`,
            source_id: 7035 + index,
            external_id: external,
            flow_id: 7033,
            executor_id: 7034,
            current_state: index ? "running" : "finished",
            ingested_at: "2026-10-18T00:30:00Z",
            claimed_at: "2026-10-18T00:30:10Z",
            completed_at: index ? null : "2026-10-18T00:31:10Z",
            environment: {},
            secret_keys: [],
          }));
          await page.setViewportSize(designViewport(width));
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          await page.route("**/ui/v1/operator/settings", (route) =>
            route.fulfill({
              json: { time_zone: "Europe/Moscow" },
              headers: { etag: '"op-1"' },
            }),
          );
          await page.route("**/ui/v1/teams/1/tasks?**", (route) =>
            route.fulfill({ json: { items: tasks, next_cursor: null } }),
          );
          await page.route("**/ui/v1/sources?**", (route) =>
            route.fulfill({
              json: {
                items: [
                  { source_id: 7035, name: "Queue A" },
                  { source_id: 7036, name: "Queue B" },
                ],
                next_cursor: null,
              },
            }),
          );
          await page.route("**/ui/v1/flows?**", (route) =>
            route.fulfill({
              json: {
                items: [{ flow_id: 7033, name: "Review queue" }],
                next_cursor: null,
              },
            }),
          );
          await page.goto(`${proxy.baseUrl}?view=history&team=1`);
          // v0050: Task (the reply's task name) first, External ID second.
          await expect(page.locator("#results table th")).toHaveText([
            "Task",
            "External ID",
            "Time",
            "Task Source",
            "Flow",
            "Status",
            "Duration",
          ]);
          if (width === 1440) {
            const table = page.locator("#results table");
            await expect(table).toBeVisible();
            await expect(table.locator("tbody tr")).toHaveCount(2);
            const fitting = await table
              .locator("tbody td")
              .evaluateAll((cells) =>
                cells.map((cell) => {
                  const walker = document.createTreeWalker(
                      cell,
                      NodeFilter.SHOW_TEXT,
                    ),
                    tops = new Set<number>();
                  let node: Node | null;
                  while ((node = walker.nextNode())) {
                    if (!node.textContent?.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(node);
                    for (const rect of range.getClientRects())
                      if (rect.width && rect.height)
                        tops.add(Math.round(rect.top));
                  }
                  const style = getComputedStyle(cell);
                  return {
                    lines: tops.size,
                    clipped:
                      cell.scrollWidth > cell.clientWidth + 1 ||
                      style.textOverflow === "ellipsis" ||
                      Number(style.webkitLineClamp) > 0,
                  };
                }),
              );
            expect(fitting).toHaveLength(14);
            for (const field of fitting) {
              expect(field.lines).toBeLessThanOrEqual(2);
              expect(field.clipped).toBe(false);
            }
            for (const [index, source] of ["Queue A", "Queue B"].entries()) {
              const row = table.locator("tbody tr").nth(index);
              await expect(
                row.getByRole("link", { name: source, exact: true }),
              ).toBeVisible();
              await expect(
                row.getByRole("link", {
                  name: tasks[index].task_name,
                  exact: true,
                }),
              ).toHaveAttribute(
                "href",
                `?view=task&team=1&id=${tasks[index].task_id}`,
              );
              // The external ID is plain text, not a link.
              await expect(row.locator("td").nth(1)).toHaveText(external);
              await expect(row.locator("td").nth(1).locator("a")).toHaveCount(
                0,
              );
            }
            await test.info().attach("task-fields-fit-two-lines", {
              contentType: "application/json",
              body: JSON.stringify({ width, theme, fields: fitting }),
            });
          }
          // Force content beyond two lines even at desktop width, rather than
          // requiring cards when the shorter value legitimately fits a table.
          external = "upstream-" + "long-readable-identifier-".repeat(30);
          for (const task of tasks) task.external_id = external;
          await page.reload();
          const cards = page.locator("#results article:visible");
          await expect(cards).toHaveCount(2);
          for (const [index, source] of ["Queue A", "Queue B"].entries()) {
            const card = cards.nth(index);
            await expect(card.locator("dt")).toHaveText([
              "Task",
              "External ID",
              "Time",
              "Task Source",
              "Flow",
              "Status",
              "Duration",
            ]);
            await expect(
              card.getByRole("link", { name: source, exact: true }),
            ).toBeVisible();
            const taskLink = card.getByRole("link", {
              name: tasks[index].task_name,
              exact: true,
            });
            await expect(taskLink).toBeVisible();
            expect(
              new URL(
                (await taskLink.getAttribute("href")) ?? "",
                page.url(),
              ).searchParams.get("id"),
            ).toBe(String(tasks[index].task_id));
            // The full external ID stays visible as plain text.
            await expect(card.locator("dd").nth(1)).toHaveText(external);
            await expect(card.locator("dd").nth(1).locator("a")).toHaveCount(0);
            await expect(
              card.getByRole("link", { name: "Review queue", exact: true }),
            ).toBeVisible();
            await expect(card).toContainText("03:30");
            // No internal task (outside its task name), Source, Executor or
            // Flow identifier is shown.
            const cardText = (await card.innerText())
              .split(tasks[index].task_name)
              .join(" ");
            for (const internal of [
              tasks[index].task_id,
              tasks[index].source_id,
              7033,
              7034,
            ])
              expect(cardText).not.toMatch(
                new RegExp(`(^|\\D)${internal}(\\D|$)`),
              );
            const badge = card.locator(".badge");
            expect((await badge.boundingBox())!.height).toBeCloseTo(28, 0);
            const concealed = await card.locator("dd").evaluateAll((nodes) =>
              nodes.some((node) => {
                const style = getComputedStyle(node);
                return (
                  style.textOverflow === "ellipsis" ||
                  Number(style.webkitLineClamp) > 0 ||
                  style.overflow === "hidden"
                );
              }),
            );
            expect(concealed).toBe(false);
            if (width === 390)
              expect(
                (await taskLink.boundingBox())!.height,
              ).toBeGreaterThanOrEqual(44);
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
        }));
  });

for (const theme of ["dark", "light"] as const) {
  test(`v0034.3 Overview latest five and four chart intensity tiers ${theme}`, async ({
    page,
  }, info) => {
    await page.clock.setFixedTime(new Date("2026-10-18T12:00:00Z"));
    await page.setViewportSize(designViewport(1440));
    await page.addInitScript(
      (value) => localStorage.setItem("flowai.theme", value),
      theme,
    );
    await page.route("**/ui/v1/operator/settings", (route) =>
      route.fulfill({
        json: { time_zone: "Europe/Moscow" },
        headers: { etag: '"op-1"' },
      }),
    );
    const taskQueries: string[] = [];
    // Registry order is authoritative: ingested_at DESC, then task_id DESC.
    // latest-1 and latest-2 share one instant, so only the task_id tie-break
    // orders them; the UI must keep the served order and never re-sort.
    const tieIDs = [9102, 9101];
    const taskID = (index: number) =>
      index === 1 || index === 2 ? tieIDs[index - 1] : 9200 - index;
    const tasks = Array.from({ length: 10 }, (_, index) => ({
      task_id: taskID(index),
      task_name: `alpha-${taskID(index)}`,
      source_id: 7008,
      external_id: `latest-${index}`,
      flow_id: 7037,
      executor_id: null,
      current_state: "queued",
      ingested_at: new Date(
        Date.parse("2026-10-18T00:30:00Z") - (index === 2 ? 1 : index) * 1000,
      ).toISOString(),
      claimed_at: null,
      completed_at: null,
      environment: {},
      secret_keys: [],
    }));
    await page.route("**/ui/v1/teams/1/tasks?**", (route) => {
      taskQueries.push(route.request().url());
      return route.fulfill({
        json: { items: tasks, next_cursor: "fixture-next" },
      });
    });
    await page.route("**/ui/v1/sources?**", (route) =>
      route.fulfill({
        json: {
          items: [{ source_id: 7008, name: "Queue" }],
          next_cursor: null,
        },
      }),
    );
    await page.route("**/ui/v1/flows?**", (route) =>
      route.fulfill({
        json: {
          items: [{ flow_id: 7037, name: "Review" }],
          next_cursor: null,
        },
      }),
    );
    await page.route("**/ui/v1/teams/1/dashboard?**", (route) => {
      const query = new URL(route.request().url()).searchParams;
      const counts =
        query.get("period") === "month"
          ? Array(7).fill(3)
          : [0, 2, 4, 6, 8, 10, 12];
      return route.fulfill({
        json: {
          period: query.get("period"),
          time_zone: "Europe/Moscow",
          counts: {
            queued: counts.reduce((a: number, b: number) => a + b, 0),
          },
          buckets: counts.map((total: number, index: number) => ({
            key: `2026-10-${12 + index}`,
            at: new Date(Date.UTC(2026, 9, 11 + index, 21)).toISOString(),
            total,
            counts: { queued: total },
            label: `${12 + index}`,
            shortLabel: `${12 + index}`,
            isFuture: false,
          })),
        },
      });
    });
    await page.goto(
      `${proxy.baseUrl}?view=dashboard&team=1&search=old&date=2026-10-17&time_zone=UTC`,
    );
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true }),
    ).toBeVisible();
    const chartPanel = page.locator("section.panel").filter({
      has: page.getByRole("heading", { name: "Runs by day", exact: true }),
    });
    // Approved dashboard composition keeps chart controls with their chart,
    // and explains the four relative count tones beside that visualization.
    await expect(
      chartPanel.getByRole("button", { name: "Week", exact: true }),
    ).toBeVisible();
    await expect(
      chartPanel.getByRole("button", { name: "Month", exact: true }),
    ).toBeVisible();
    await expect(
      chartPanel.getByRole("button", { name: "Previous week", exact: true }),
    ).toHaveText("Earlier period");
    await expect(
      chartPanel.getByRole("button", { name: "Next week", exact: true }),
    ).toHaveText("Later period");
    const verifyPeriodSelection = async (selected: "Week" | "Month") => {
      const buttons = chartPanel.getByRole("button", {
        name: /^(Week|Month)$/,
      });
      await expect(buttons).toHaveCount(2);
      const styles = await buttons
        .first()
        .locator("..")
        .evaluate((group) => {
          const style = getComputedStyle(group);
          return {
            border: style.borderTopWidth,
            boundary: style.borderTopColor,
            borderStyle: style.borderTopStyle,
            radius: style.borderRadius,
            padding: style.padding,
            gap: style.gap,
            buttons: [...group.querySelectorAll("button")].map((button) => {
              const style = getComputedStyle(button);
              return {
                name: button.textContent,
                pressed: button.getAttribute("aria-pressed"),
                fill: style.backgroundColor,
                ink: style.color,
                border: style.borderTopWidth,
                size: style.fontSize,
                weight: style.fontWeight,
                height: button.getBoundingClientRect().height,
              };
            }),
          };
        });
      const colors =
        theme === "dark"
          ? {
              boundary: "rgb(102, 121, 147)",
              selected: "rgb(45, 58, 80)",
              ink: "rgb(248, 250, 252)",
            }
          : {
              boundary: "rgb(104, 119, 139)",
              selected: "rgb(221, 230, 240)",
              ink: "rgb(23, 32, 46)",
            };
      expect(styles).toMatchObject({
        border: "1px",
        boundary: colors.boundary,
        borderStyle: "solid",
        radius: "4px",
        padding: "2px",
        gap: "8px",
      });
      for (const button of styles.buttons) {
        expect(button.pressed).toBe(String(button.name === selected));
        expect(button.fill).toBe(
          button.name === selected ? colors.selected : "rgba(0, 0, 0, 0)",
        );
        expect(button.ink).toBe(colors.ink);
        expect(button.border).toBe("0px");
        expect(button.size).toBe("14px");
        expect(button.weight).toBe("600");
        expect(button.height).toBeGreaterThanOrEqual(44);
      }
    };
    const legend = chartPanel.locator("[data-count-legend] [data-count-level]");
    await expect(legend).toHaveCount(4);
    for (let level = 0; level < 4; level++) {
      await expect(legend.nth(level)).toBeVisible();
      await expect(legend.nth(level)).toHaveAttribute(
        "data-count-level",
        String(level),
      );
    }
    await expect(chartPanel).toContainText(
      "Select any day to open Tasks for that day in your time zone.",
    );
    const navigation = chartPanel.locator(".week-nav");
    const geometry = await navigation.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const [earlier, label, later] = [...node.children].map((child) =>
        child.getBoundingClientRect(),
      );
      return {
        left: bounds.left,
        right: bounds.right,
        center: (bounds.left + bounds.right) / 2,
        earlier: earlier.left,
        later: later.right,
        label: (label.left + label.right) / 2,
      };
    });
    expect(geometry.earlier).toBeCloseTo(geometry.left, 0);
    expect(geometry.later).toBeCloseTo(geometry.right, 0);
    expect(geometry.label).toBeCloseTo(geometry.center, 0);
    for (const fill of await chartPanel
      .locator(".week-day [data-count-fill]")
      .all())
      expect((await fill.boundingBox())!.width).toBeCloseTo(52, 0);
    const recent = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Recent tasks", exact: true }),
    });
    await expect(recent).toBeVisible();
    // v0050: each recent task's link is its task name, in served order.
    await expect(recent.getByRole("link", { name: /^alpha-\d+$/ })).toHaveText(
      [0, 1, 2, 3, 4].map((index) => `alpha-${taskID(index)}`),
    );
    const latestQuery = new URL(taskQueries[0]).searchParams;
    expect(latestQuery.get("limit")).toBe("10");
    expect(latestQuery.get("time_zone")).toBe("Europe/Moscow");
    for (const filter of ["search", "date", "status", "period"])
      expect(latestQuery.has(filter)).toBe(false);
    const bars = page.locator("[data-dashboard-date]");
    await expect(bars).toHaveCount(7);
    const colors = await bars.evaluateAll((nodes) =>
      nodes.map((node) => {
        const fill = node.querySelector("[data-count-fill]") || node;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.fillStyle = getComputedStyle(fill).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .join(",")})`;
      }),
    );
    expect(new Set(colors).size).toBe(4);
    const legendColors = await legend.evaluateAll((nodes) =>
      nodes.map((node) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d")!;
        context.fillStyle = getComputedStyle(node).backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data)
          .slice(0, 3)
          .join(",")})`;
      }),
    );
    expect(new Set(legendColors)).toEqual(new Set(colors));
    expect(colors[0]).toBe(colors[1]);
    expect(colors[3]).toBe(colors[4]);
    expect(colors[5]).toBe(colors[6]);
    const lightness = (color: string) => {
      const values = color.match(/[\d.]+/g)!.map(Number);
      return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
    };
    expect(lightness(colors[0]) < lightness(colors[6])).toBe(theme === "dark");
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 820, height: 1180 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(
        chartPanel.getByRole("button", { name: "Week", exact: true }),
      ).toBeVisible();
      await expect(
        chartPanel.getByRole("button", { name: "Next week", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await verifyPeriodSelection("Week");
      // The approved Overview chart has one continuous baseline across all
      // seven columns, including the gutters. Sample actual rendered pixels;
      // do not prescribe a particular CSS implementation for that line.
      const chart = chartPanel.locator(".chart.week");
      const geometry = await chart.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const days = [...element.querySelectorAll(".week-day")].map((day) =>
          day.getBoundingClientRect(),
        );
        return {
          width: box.width,
          height: box.height,
          referenceX: days[0].left - box.left + 2,
          bottom: days[0].bottom - box.top,
          gaps: days
            .slice(0, -1)
            .map(
              (day, index) => (day.right + days[index + 1].left) / 2 - box.left,
            ),
          color: getComputedStyle(
            days.length ? element.querySelector(".week-day")! : element,
          ).borderBottomColor,
        };
      });
      expect(geometry.gaps).toHaveLength(6);
      const pixels = await chart.screenshot({ animations: "disabled" });
      const probe = await page.evaluate(
        async ({ base64, geometry }) => {
          const bytes = Uint8Array.from(atob(base64), (character) =>
            character.charCodeAt(0),
          );
          const bitmap = await createImageBitmap(
            new Blob([bytes], { type: "image/png" }),
          );
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const data = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          const swatch = new OffscreenCanvas(1, 1).getContext("2d")!;
          swatch.fillStyle = geometry.color;
          swatch.fillRect(0, 0, 1, 1);
          const expected = [...swatch.getImageData(0, 0, 1, 1).data];
          const sx = canvas.width / geometry.width,
            sy = canvas.height / geometry.height;
          const at = (x: number, y: number) => {
            const px = Math.floor(x * sx);
            if (
              !Number.isInteger(px) ||
              !Number.isInteger(y) ||
              px < 0 ||
              px >= canvas.width ||
              y < 0 ||
              y >= canvas.height
            )
              throw new Error("Baseline sample escaped the captured chart");
            return [
              ...data.slice(
                (y * canvas.width + px) * 4,
                (y * canvas.width + px) * 4 + 4,
              ),
            ];
          };
          const matches = (actual: number[]) =>
            actual.length === 4 &&
            actual.every(
              (value, index) => Math.abs(value - expected[index]) <= 2,
            );
          const baseline = [-2, -1, 0]
            .map((offset) => Math.floor(geometry.bottom * sy) + offset)
            .find((y) => matches(at(geometry.referenceX, y)));
          return {
            expected,
            baseline,
            reference:
              baseline === undefined ? null : at(geometry.referenceX, baseline),
            gaps:
              baseline === undefined
                ? []
                : geometry.gaps.map((x) => ({ x, rgba: at(x, baseline) })),
          };
        },
        { base64: pixels.toString("base64"), geometry },
      );
      await info.attach(`week-baseline-${theme}-${viewport.width}`, {
        contentType: "application/json",
        body: JSON.stringify(probe),
      });
      expect(
        probe.baseline,
        "The plot border itself must be positively observed",
      ).toBeDefined();
      expect(probe.gaps).toHaveLength(6);
      for (const gap of probe.gaps) {
        expect(gap.rgba).toHaveLength(4);
        expect(
          gap.rgba.every(
            (value, index) => Math.abs(value - probe.expected[index]) <= 2,
          ),
          `Baseline border missing at sampled gutter ${gap.x}`,
        ).toBe(true);
      }
      await captureDesignState(
        page,
        info,
        proxy.webUIImageID,
        `dashboard.html-default-${theme}-${viewport.width}`,
      );
    }
    await page.setViewportSize(designViewport(1440));
    await chartPanel
      .getByRole("button", { name: "Month", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          new Set(
            await bars.evaluateAll((nodes) =>
              nodes.map((node) => {
                const fill = node.querySelector("[data-count-fill]") || node;
                const canvas = document.createElement("canvas");
                canvas.width = canvas.height = 1;
                const context = canvas.getContext("2d")!;
                context.fillStyle = getComputedStyle(fill).backgroundColor;
                context.fillRect(0, 0, 1, 1);
                return `rgb(${Array.from(context.getImageData(0, 0, 1, 1).data)
                  .slice(0, 3)
                  .join(",")})`;
              }),
            ),
          ).size,
      )
      .toBe(1);
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize(designViewport(width));
      await verifyPeriodSelection("Month");
    }
    await recent.getByRole("link", { name: "More tasks", exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("view"))
      .toBe("history");
    for (const filter of [
      "search",
      "date",
      "status",
      "period",
      "cursor",
      "time_zone",
    ])
      expect(new URL(page.url()).searchParams.has(filter)).toBe(false);
    expect(new URL(taskQueries.at(-1)!).searchParams.get("time_zone")).toBe(
      "Europe/Moscow",
    );
  });
}

for (const theme of ["dark", "light"] as const)
  test(`v0034.7 Parameters groups by General and owning Flow; header secret requires an explicit writable definition ${theme}`, async ({
    context,
  }) => {
    test.setTimeout(60_000);
    await test.step(`v0034.7 Parameters groups one entry collection by General and owning Flow ${theme}`, () =>
      withPage(context, async (page) => {
        await page.addInitScript(
          (value) => localStorage.setItem("flowai.theme", value),
          theme,
        );
        await parameterFixture(page);
        await page.goto(
          `${proxy.baseUrl}?view=settings&section=parameters&team=1`,
        );
        await expect(
          page.getByRole("heading", { name: "General", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Review flow", exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", { name: "SHARED", exact: true }),
        ).toHaveCount(3);
        await expect(
          page.getByRole("link", { name: "TOKEN", exact: true }),
        ).toHaveCount(1);
        const labels = await page
          .locator("#definitions th,#definitions dt")
          .allTextContents();
        expect(labels).toContain("Scope");
        expect(labels).not.toContain("Definition");
        expect(labels).not.toContain("Actions");
        expect(await page.locator("#definitions").innerText()).not.toContain(
          "7044",
        );
        const global = page
          .locator("#definitions tr,#definitions article")
          .filter({ hasText: "global-value" });
        await expect(
          global.getByRole("button", { name: /^Actions/ }),
        ).toHaveCount(0);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }));
    await test.step(`v0034.7 header secret creation requires an explicit writable definition ${theme}`, () =>
      withPage(context, async (page) => {
        await page.addInitScript(
          (value) => localStorage.setItem("flowai.theme", value),
          theme,
        );
        const { writes } = await parameterFixture(page);
        await page.goto(
          `${proxy.baseUrl}?view=settings&section=parameters&team=1`,
        );
        const create = page.getByRole("button", {
          name: "Create parameter",
          exact: true,
        });
        await expect(create).toBeVisible();
        expect((await create.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await create.click();
        const menu = page.getByRole("menu");
        await expect(
          menu.getByRole("menuitem", { name: "Add variable", exact: true }),
        ).toBeVisible();
        await menu
          .getByRole("menuitem", { name: "Add secret", exact: true })
          .click();
        const dialog = page.getByRole("dialog", {
          name: "Add secret",
          exact: true,
        });
        const target = dialog.getByLabel("Target definition", { exact: true });
        await expect(target).toHaveValue("");
        expect(
          await target
            .locator("option")
            .evaluateAll((nodes) =>
              nodes.map((node) => (node as HTMLOptionElement).value),
            ),
        ).toEqual(["", "7042", "7043"]);
        await target.selectOption("7042");
        await dialog.getByLabel("Key name", { exact: true }).fill("NEW_TOKEN");
        const value = dialog.getByLabel("New secret value", { exact: true });
        await value.fill("synthetic-target-change-canary");
        await target.selectOption("7043");
        await expect(value).toHaveValue("");
        expect(writes).toEqual([]);
        await value.fill("synthetic-explicit-target-canary");
        await dialog
          .getByRole("button", { name: "Save secret", exact: true })
          .click();
        await expect(dialog).not.toBeVisible();
        expect(
          writes.map(({ path, method, body }) => ({ path, method, body })),
        ).toEqual([
          {
            path: "/ui/v1/teams/1/launch-parameters/7043/secrets",
            method: "POST",
            body: {
              key: "NEW_TOKEN",
              value: "synthetic-explicit-target-canary",
            },
          },
        ]);
        await expect(page.locator('#secret-form [name="value"]')).toHaveValue(
          "",
        );
        expect(await page.locator("body").innerText()).not.toContain(
          "synthetic-explicit-target-canary",
        );
      }));
  });

for (const theme of ["dark", "light"] as const)
  test(`v0034.8 v0034.2 duplicate Source name and Source submission modal theme control ${theme}`, async ({
    context,
  }) => {
    test.setTimeout(60_000);
    await test.step(`v0034.8 duplicate Source name returns to Name with safe Details draft ${theme}`, () =>
      withPage(context, async (page) => {
        const writes: any[] = [];
        await page.addInitScript(
          (value) => localStorage.setItem("flowai.theme", value),
          theme,
        );
        await page.route("**/ui/v1/sources", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          const body = route.request().postDataJSON();
          writes.push(body);
          if (writes.length === 1)
            return route.fulfill({
              status: 409,
              json: {
                code: "source_name_conflict",
                message: "Name already used",
              },
            });
          await route.fulfill({
            status: 201,
            json: {
              source: { source_id: 7038, name: body.name },
              api_key: "tsk_v1_synthetic_once_only_source_key_canary",
            },
          });
        });
        await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
        await createSourceEntry(page).click();
        const wizard = sourceWizard(page);
        await wizard.getByLabel("Name", { exact: true }).fill("taken-source");
        await wizard.getByRole("button", { name: "Next", exact: true }).click();
        await wizard
          .getByLabel("Mode", { exact: true })
          .selectOption("webhook");
        await wizard.locator("details summary").click();
        await wizard
          .getByLabel("Implementation version", { exact: true })
          .fill("1");
        await wizard
          .getByLabel("Description (optional)", { exact: true })
          .fill("Retained safe description");
        await wizard
          .getByRole("button", { name: "Create source", exact: true })
          .click();
        await expect.poll(() => writes.length).toBe(1);
        await expect(
          wizard.getByRole("heading", {
            name: "Add Source · Name",
            exact: true,
          }),
        ).toBeVisible();
        const name = wizard.getByLabel("Name", { exact: true });
        await expect(name).toHaveValue("taken-source");
        await expect(name).toBeFocused();
        await name.fill("available-source");
        await wizard.getByRole("button", { name: "Next", exact: true }).click();
        await expect(wizard.getByLabel("Mode", { exact: true })).toHaveValue(
          "webhook",
        );
        await expect(
          wizard.getByLabel("Implementation version", { exact: true }),
        ).toHaveValue("1");
        await expect(
          wizard.getByLabel("Description (optional)", { exact: true }),
        ).toHaveValue("Retained safe description");
        await wizard
          .getByRole("button", { name: "Create source", exact: true })
          .click();
        await expect(
          page.getByRole("heading", {
            name: "One-time key for available-source",
            exact: true,
          }),
        ).toBeVisible();
        expect(writes).toHaveLength(2);
        expect(writes[1]).toMatchObject({
          name: "available-source",
          mode: "webhook",
          implementation_version: "1",
          description: "Retained safe description",
        });
        await page
          .getByRole("button", { name: "Close and clear", exact: true })
          .click();
        await expect(page.locator("[data-source-key]")).toHaveCount(0);
      }));
    await test.step(`v0034.2 Source submission keeps its modal theme control reachable without repeating creation ${theme}`, () =>
      withPage(context, async (page) => {
        await page.addInitScript(
          (theme) => localStorage.setItem("flowai.theme", theme),
          theme,
        );
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const writes: unknown[] = [];
        await page.route("**/ui/v1/sources?**", (route) =>
          route.fulfill({ json: { items: [], next_cursor: null } }),
        );
        await page.route("**/ui/v1/sources", async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          writes.push(route.request().postDataJSON());
          await held;
          await route.fulfill({ status: 503, json: { code: "unavailable" } });
        });
        try {
          await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
          await createSourceEntry(page).click();
          const dialog = sourceWizard(page);
          await dialog
            .getByLabel("Name", { exact: true })
            .fill("busy-theme-source");
          await dialog
            .getByRole("button", { name: "Next", exact: true })
            .click();
          await dialog
            .getByLabel("Mode", { exact: true })
            .selectOption("webhook");
          await dialog.locator("details summary").click();
          await dialog
            .getByLabel("Implementation version", { exact: true })
            .fill("1");
          const description = dialog.getByLabel("Description (optional)", {
            exact: true,
          });
          await description.fill(
            "Retain this safe draft while submission is pending",
          );
          // The approved busy submit reads "Creating…" while it is disabled.
          const submit = dialog.getByRole("button", {
            name: /^(Create source|Creating…)$/,
          });
          await submit.click();
          await expect.poll(() => writes.length).toBe(1);
          await expect(submit).toBeDisabled();
          const next = theme === "dark" ? "light" : "dark";
          const toggle = page.getByRole("button", {
            name: `Switch to ${next} theme`,
            exact: true,
          });
          await expect(toggle).toBeEnabled();
          await toggle.click();
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            next,
          );
          await expect(description).toHaveValue(
            "Retain this safe draft while submission is pending",
          );
          await expect(submit).toBeDisabled();
          expect(writes).toHaveLength(1);
          release();
          // An uncertain create reports the approved "Key not received" outcome.
          await expect(dialog.getByRole("alert")).toContainText(
            /key not received/i,
          );
          await expect(page.locator("[data-source-key]")).toHaveCount(0);
          expect(writes).toHaveLength(1);
          await cancelSourceWizard(dialog).click();
          await expect(dialog).not.toBeVisible();
        } finally {
          release();
        }
      }));
  });

test("v0034.15 timestamps use saved explicit zone and disambiguate offsets Europe/Moscow and America/New_York", async ({
  context,
}) => {
  test.setTimeout(60_000);
  for (const sample of [
    {
      zone: "Europe/Moscow",
      instants: ["2026-10-18T00:30:00Z"],
      times: ["03:30"],
    },
    {
      zone: "America/New_York",
      instants: ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"],
      times: ["01:30", "01:30"],
    },
  ])
    await test.step(`v0034.15 timestamps use saved explicit zone and disambiguate offsets ${sample.zone}`, () =>
      withPage(context, async (page) => {
        await page.route("**/ui/v1/operator/settings", (route) =>
          route.fulfill({
            json: { time_zone: sample.zone },
            headers: { etag: '\"op-1\"' },
          }),
        );
        const queries: string[] = [];
        await page.route("**/ui/v1/teams/1/tasks?**", (route) => {
          queries.push(route.request().url());
          return route.fulfill({
            json: {
              items: sample.instants.map((at, index) => ({
                task_id: 9400 + index,
                task_name: `alpha-${9400 + index}`,
                source_id: 7039,
                external_id: `zone-event-${index}`,
                flow_id: 7040,
                executor_id: null,
                current_state: "queued",
                ingested_at: at,
                claimed_at: null,
                completed_at: null,
                environment: {},
                secret_keys: [],
              })),
              next_cursor: null,
            },
          });
        });
        await page.route("**/ui/v1/sources?**", (route) =>
          route.fulfill({
            json: {
              items: [{ source_id: 7039, name: "Zone source" }],
              next_cursor: null,
            },
          }),
        );
        await page.route("**/ui/v1/flows?**", (route) =>
          route.fulfill({
            json: {
              items: [{ flow_id: 7040, name: "Zone flow" }],
              next_cursor: null,
            },
          }),
        );
        await page.goto(
          // A legacy URL zone that differs from every saved sample zone must not
          // override the saved operator zone.
          `${proxy.baseUrl}?view=history&team=1&date=${sample.instants[0].slice(0, 10)}&time_zone=Antarctica%2FTroll`,
        );
        const rows = page.locator("#results tbody tr");
        await expect(rows).toHaveCount(sample.instants.length);
        for (let index = 0; index < sample.times.length; index++)
          await expect(rows.nth(index)).toContainText(sample.times[index]);
        expect(new URL(queries[0]).searchParams.get("time_zone")).toBe(
          sample.zone,
        );
        expect(new URL(page.url()).searchParams.has("time_zone")).toBe(false);
        if (sample.instants.length === 2) {
          // Approved mockup format: numeric offset such as "01:30 -04:00".
          await expect(rows.nth(0)).toContainText(
            /[−-]04:00|(?:GMT|UTC)[−-]0?4(?::00)?/,
          );
          await expect(rows.nth(1)).toContainText(
            /[−-]05:00|(?:GMT|UTC)[−-]0?5(?::00)?/,
          );
        }
      }));
});

test("v0034.10 Model refresh preserves dialog ownership and clears credentials reopen and reload-failure", async ({
  context,
}) => {
  test.setTimeout(60_000);
  for (const scenario of ["reopen", "reload-failure"] as const)
    await test.step(`v0034.10 Model refresh preserves dialog ownership and clears credentials ${scenario}`, () =>
      withPage(context, async (page) => {
        await page.route("**/ui/v1/models?**", (route) =>
          route.fulfill({ json: { items: [], next_cursor: null } }),
        );
        await page.route("**/ui/v1/models", (route) =>
          route.fulfill({
            status: 503,
            json: { code: "model_gateway_unavailable" },
          }),
        );
        let release!: () => void;
        let captured = false;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/ui/v1/models/uncertain-a", async (route) => {
          captured = true;
          await held;
          await route.fulfill(
            scenario === "reopen"
              ? {
                  json: {
                    name: "uncertain-a",
                    provider: "openai",
                    provider_model: "old-provider-model",
                    editable: true,
                    paused: false,
                    pricing: {
                      input_usd_per_million_tokens: "1",
                      output_usd_per_million_tokens: "2",
                    },
                  },
                  headers: { etag: '"model-a"' },
                }
              : { status: 404, json: { code: "not_found" } },
          );
        });
        try {
          await page.goto(
            `${proxy.baseUrl}?view=settings&section=models&team=1`,
          );
          await page
            .getByRole("button", { name: "Create model", exact: true })
            .click();
          const dialog = page.locator("#model-dialog"),
            form = page.locator("#model-form");
          await form.locator('[name="name"]').fill("uncertain-a");
          await form
            .locator('[name="provider_model"]')
            .fill("test-provider-model");
          await form.locator('[name="input_price"]').fill("1");
          await form.locator('[name="output_price"]').fill("2");
          await form
            .getByRole("button", { name: "Save model", exact: true })
            .click();
          await expect(form.locator(".validation")).toContainText(
            "may have completed",
          );
          await form
            .locator('[name="api_key"]')
            .fill("synthetic-after-uncertain-key");
          await form
            .getByRole("button", { name: "Reload", exact: true })
            .click();
          await expect.poll(() => captured).toBe(true);
          if (scenario === "reopen") {
            await dialog
              .getByRole("button", { name: "Cancel", exact: true })
              .click();
            await page
              .getByRole("button", { name: "Create model", exact: true })
              .click();
            await form.locator('[name="name"]').fill("fresh-b");
            await form
              .locator('[name="provider_model"]')
              .fill("fresh-provider-model");
          }
          const readFinished = page.waitForResponse(
            (response) =>
              response.request().method() === "GET" &&
              new URL(response.url()).pathname === "/ui/v1/models/uncertain-a",
          );
          release();
          await (await readFinished).finished();
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              ),
          );
          if (scenario === "reopen") {
            await expect(form.locator('[name="name"]')).toHaveValue("fresh-b");
            await expect(form.locator('[name="name"]')).toBeEnabled();
            await expect(form.locator('[name="provider_model"]')).toHaveValue(
              "fresh-provider-model",
            );
          } else {
            await expect(form.locator(".validation")).toContainText(
              "No saved model has that name",
            );
            await expect(form.locator('[name="api_key"]')).toHaveValue("");
            await expect(form.locator('[name="input_price"]')).toHaveValue("1");
          }
        } finally {
          release();
        }
      }));
});

test("v0034.7 zero token prices explain spend and retain rate limits", async ({
  page,
}) => {
  await page.route("**/ui/v1/models/zero", (route) =>
    route.fulfill({
      json: {
        name: "zero",
        model_alias: "1/zero",
        provider: "openai",
        provider_model: "fixture-model",
        paused: false,
        archived_at: null,
        created_by: "team",
        editable: true,
        credential_configured: false,
        pricing_status: "configured",
        pricing: {
          input_usd_per_million_tokens: "0",
          output_usd_per_million_tokens: "0",
        },
      },
      headers: { etag: '"zero-model"' },
    }),
  );
  await page.goto(`${proxy.baseUrl}?view=model&id=zero&team=1`);
  await expect(
    page.getByRole("heading", { name: "Model detail", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    /no configured input\/output token spend/i,
  );
  await expect(page.locator("main")).toContainText(/RPM.*TPM|TPM.*RPM/);
});

test("v0034.14 Model create focuses its invalid price without dispatch input_price and output_price", async ({
  context,
}) => {
  test.setTimeout(60_000);
  for (const invalid of ["input_price", "output_price"])
    await test.step(`v0034.14 Model create focuses its invalid price without dispatch ${invalid}`, () =>
      withPage(context, async (page) => {
        await page.route("**/ui/v1/models?**", (route) =>
          route.fulfill({ json: { items: [], next_cursor: null } }),
        );
        const writes: string[] = [];
        page.on("request", (request) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname === "/ui/v1/models"
          )
            writes.push(request.url());
        });
        await page.goto(`${proxy.baseUrl}?view=settings&section=models&team=1`);
        await page
          .getByRole("button", { name: "Create model", exact: true })
          .click();
        const form = page.locator("#model-form");
        await form.locator('[name="name"]').fill("price-validation");
        await form.locator('[name="provider_model"]').fill("safe-model-draft");
        await form
          .locator('[name="api_key"]')
          .fill("synthetic-invalid-pricing-key");
        await form
          .locator('[name="input_price"]')
          .fill(invalid === "input_price" ? "1e2" : "2");
        await form
          .locator('[name="output_price"]')
          .fill(invalid === "output_price" ? "1e2" : "3");
        await form
          .getByRole("button", { name: "Save model", exact: true })
          .click();
        await expect(form.locator(".validation")).toContainText("decimal");
        await expect(form.locator(`[name="${invalid}"]`)).toBeFocused();
        expect(writes).toEqual([]);
        await expect(form.locator('[name="api_key"]')).toHaveValue("");
        await expect(form.locator('[name="provider_model"]')).toHaveValue(
          "safe-model-draft",
        );
      }));
});

test("v0034.6 Flow task preview traverses false matches and retains exact pages", async ({
  page,
}) => {
  const id = 8009;
  const flow = {
    flow_id: id,
    name: "Exact flow",
    execution_tag: "openhands",
    prompt_template: "Work {{external_id}}",
    model_aliases: [],
    source_ids: [],
    per_task_limit: null,
    flow_limit: null,
    execution_parameters: {},
  };
  await page.route(`**/ui/v1/flows/${id}`, (route) =>
    route.fulfill({ json: flow, headers: { etag: '"1"' } }),
  );
  await page.route(`**/ui/v1/flow-llm-settings/${id}`, (route) =>
    route.fulfill({ json: flow, headers: { etag: '"1"' } }),
  );
  const task = (index: number, match: boolean) => ({
    task_id: 9500 + (match ? 0 : 100) + index,
    task_name: `alpha-${9500 + (match ? 0 : 100) + index}`,
    flow_id: match ? id : 9599,
    source_id: 7008,
    external_id: match ? `exact-${index}` : `false-${index}`,
    executor_id: null,
    current_state: "queued",
    ingested_at: new Date(
      Date.UTC(2026, 9, 18, 12, 0, 100 - index),
    ).toISOString(),
    claimed_at: null,
    completed_at: null,
    environment: {},
    secret_keys: [],
  });
  const pages = [
    Array.from({ length: 10 }, (_, i) => task(i, false)),
    Array.from({ length: 10 }, (_, i) => task(i + 10, i < 7)),
    Array.from({ length: 10 }, (_, i) => task(i + 20, i < 4)),
  ];
  const queries: string[] = [];
  await page.route("**/ui/v1/teams/1/tasks?**", (route) => {
    queries.push(route.request().url());
    const query = new URL(route.request().url()).searchParams;
    const index = Number(query.get("cursor") || 0);
    return route.fulfill({
      json: {
        items: pages[index] || [],
        next_cursor: index < 2 ? String(index + 1) : null,
      },
    });
  });
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({
      json: {
        items: [{ source_id: 7008, name: "Queue" }],
        next_cursor: null,
      },
    }),
  );
  await page.goto(`${proxy.baseUrl}?view=flow&id=${id}&team=1`);
  await expect(
    page.getByRole("heading", { name: "Flow detail", exact: true }),
  ).toBeVisible();
  const preview = page.locator("[data-flow-tasks]");
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole("link", { name: /^alpha-95\d\d$/ }),
  ).toHaveCount(10);
  await expect(preview).not.toContainText(/false-/);
  expect(queries.length).toBe(3);
  for (const query of queries)
    expect(new URL(query).searchParams.get("search")).toBe(String(id));
  await preview.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    preview.getByRole("link", { name: /^alpha-95\d\d$/ }),
  ).toHaveText(["alpha-9523"]);
  await expect(
    preview.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  const before = queries.length;
  await preview.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(
    preview.getByRole("link", { name: /^alpha-95\d\d$/ }),
  ).toHaveCount(10);
  expect(queries.length).toBe(before);
  await preview.getByLabel("Rows per page", { exact: true }).selectOption("25");
  await expect(
    preview.getByRole("link", { name: /^alpha-95\d\d$/ }),
  ).toHaveCount(11);
  await expect(
    preview.getByRole("button", { name: "Next", exact: true }),
  ).toBeDisabled();
  const disclosure = page.locator("details").filter({ has: preview });
  await disclosure.locator("summary").click();
  await expect(preview).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Prompt and execution", exact: true }),
  ).toBeVisible();
});

test("v0034.3 detached Tasks search debounce cannot dispatch in another view", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
  const queries: string[] = [];
  await page.route("**/ui/v1/teams/1/tasks?**", (route) => {
    queries.push(route.request().url());
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.goto(`${proxy.baseUrl}?view=history&team=1`);
  await expect(page.locator('[name="search"]')).toBeVisible();
  await expect.poll(() => queries.length).toBe(1);
  await page.clock.pauseAt(new Date("2026-10-18T12:00:05Z"));
  await page.locator('[name="search"]').fill("detached-search");
  await page.locator('.nav-links [data-view="flows"]').click();
  await expect(
    page.getByRole("heading", { name: "Flows", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(200);
  expect(queries).toHaveLength(1);
});

const calendarSamples = [
  {
    period: "month",
    key: "2026-10",
    expected: "2026-09",
    now: "2026-10-01T00:30:00Z",
  },
  {
    period: "month",
    key: "2026-08",
    expected: "2026-08",
    now: "2026-10-01T00:30:00Z",
  },
  {
    period: "week",
    key: "2026-W41",
    expected: "2026-W40",
    now: "2026-10-05T00:30:00Z",
  },
  {
    period: "week",
    key: "2026-W39",
    expected: "2026-W39",
    now: "2026-10-05T00:30:00Z",
  },
];
for (const period of ["month", "week"])
  test(`v0034.15 zone refresh preserves valid calendar key and clamps future ${period} ${calendarSamples
    .filter((sample) => sample.period === period)
    .map((sample) => sample.key)
    .join(" and ")}`, async ({ context }) => {
    test.setTimeout(60_000);
    for (const sample of calendarSamples.filter(
      (sample) => sample.period === period,
    ))
      await test.step(`v0034.15 zone refresh preserves valid calendar key and clamps future ${sample.period} ${sample.key}`, () =>
        withPage(context, async (page) => {
          await page.clock.setFixedTime(new Date(sample.now));
          let zone = "UTC",
            revision = 1;
          await page.route("**/ui/v1/operator/settings", (route) =>
            route.fulfill({
              json: { time_zone: zone },
              headers: { etag: `"op-${revision}"` },
            }),
          );
          const queries: string[] = [];
          await page.route("**/ui/v1/teams/1/dashboard?**", (route) => {
            queries.push(route.request().url());
            return route.fulfill({
              json: {
                period: sample.period,
                time_zone: zone,
                buckets: [],
                counts: {},
              },
            });
          });
          await page.goto(
            `${proxy.baseUrl}?view=dashboard&team=1&period=${sample.period}&${sample.period}=${sample.key}`,
          );
          await expect.poll(() => queries.length).toBe(1);
          zone = "America/Los_Angeles";
          revision = 2;
          await page.evaluate(() => dispatchEvent(new Event("focus")));
          await expect.poll(() => queries.length).toBe(2);
          const latest = new URL(queries[1]).searchParams;
          expect(latest.get("time_zone")).toBe(zone);
          expect(latest.get(sample.period)).toBe(sample.expected);
          expect(new URL(page.url()).searchParams.get(sample.period)).toBe(
            sample.expected,
          );
        }));
  });

test("v0034.3 unavailable daily counts do not claim a complete zero total all and mixed", async ({
  context,
}) => {
  test.setTimeout(60_000);
  for (const mixed of [false, true])
    await test.step(`v0034.3 unavailable daily counts do not claim a complete zero total ${mixed ? "mixed" : "all"}`, () =>
      withPage(context, async (page) => {
        const totals = mixed
          ? [0, 5, null, null, null, null, null]
          : Array(7).fill(null);
        await page.route("**/ui/v1/teams/1/dashboard?**", (route) =>
          route.fulfill({
            json: {
              period: "week",
              buckets: totals.map((total, index) => ({
                key: `2026-10-${12 + index}`,
                total,
                label: String(12 + index),
              })),
              counts: {},
            },
          }),
        );
        await page.goto(`${proxy.baseUrl}?view=dashboard&team=1`);
        const calendar = page.locator("section").filter({
          has: page.getByRole("heading", { name: "Runs by day", exact: true }),
        });
        const summary = calendar.locator("[data-calendar] > p").first();
        await expect(summary).toContainText(/unavailable|partial|known/i);
        await expect(summary).not.toHaveText(/^0 runs ·/);
        await expect(
          calendar.getByRole("link", {
            name: /: run count unavailable; open Tasks$/,
          }),
        ).toHaveCount(mixed ? 5 : 7);
      }));
});

test("v0034.15 legacy task continuation requires explicit restart with the same date", async ({
  page,
}) => {
  await page.route("**/ui/v1/operator/settings", (route) =>
    route.fulfill({
      json: { time_zone: "Europe/Moscow" },
      headers: { etag: '"op-1"' },
    }),
  );
  const queries: string[] = [];
  await page.route("**/ui/v1/teams/1/tasks?**", (route) => {
    queries.push(route.request().url());
    if (new URL(route.request().url()).searchParams.has("cursor"))
      return route.fulfill({
        status: 400,
        json: {
          code: "invalid_cursor",
          message: "Task continuation is invalid",
        },
      });
    return route.fulfill({ json: { items: [], next_cursor: null } });
  });
  await page.goto(
    `${proxy.baseUrl}?view=history&team=1&date=2026-10-18&cursor=legacy&time_zone=UTC`,
  );
  await expect(
    page.getByRole("button", { name: "Start from first page", exact: true }),
  ).toBeVisible();
  expect(queries).toHaveLength(1);
  await page
    .getByRole("button", { name: "Start from first page", exact: true })
    .click();
  await expect.poll(() => queries.length).toBe(2);
  const latest = new URL(queries[1]).searchParams;
  expect(latest.has("cursor")).toBe(false);
  expect(latest.get("date")).toBe("2026-10-18");
  expect(latest.get("time_zone")).toBe("Europe/Moscow");
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
});

// Each transition starts in a fresh browser context. Storage failures affect
// this document only; a separate real tab can still produce storage events.
// One test per OS and stored value; each transition is one Stage 0 cell step
// with its own fresh context. The first-paint and storage-failure checks of
// the same OS and stored value run as steps in their own fresh context.
for (const os of ["dark", "light"] as const)
  for (const storage of [
    "absent",
    "dark",
    "light",
    "invalid",
    "read_denied",
    "write_denied",
  ] as const)
    test(`v0034.1 theme cells OS=${os}; storage=${storage}`, async ({
      browser,
    }) => {
      test.setTimeout(300_000);
      const cells = new Stage0Cells(test.info(), "theme");
      for (const transition of [
        "bootstrap",
        "OS_change",
        "explicit_toggle",
        "cross_tab_set",
        "cross_tab_remove",
        "reload",
      ] as const)
        await test.step(`v0034.1 theme cell OS=${os}; storage=${storage}; transition=${transition}`, () =>
          cells.run({ OS: os, storage, transition }, async () => {
            const stored = ["dark", "light", "invalid"].includes(storage)
              ? storage
              : null;
            const initial =
              stored === "dark" || stored === "light" ? stored : os;
            const opposite = initial === "dark" ? "light" : "dark";
            const context = await browser.newContext({
              colorScheme: os,
              storageState: {
                cookies: [],
                origins: [
                  {
                    origin: new URL(proxy.baseUrl).origin,
                    localStorage:
                      stored === null
                        ? []
                        : [{ name: "flowai.theme", value: stored }],
                  },
                ],
              },
            });
            try {
              const page = await context.newPage();
              await page.addInitScript((storage) => {
                if (storage === "read_denied" || storage === "write_denied") {
                  const method =
                    storage === "read_denied" ? "getItem" : "setItem";
                  Storage.prototype[method] = () => {
                    throw new DOMException(
                      "Storage unavailable",
                      "SecurityError",
                    );
                  };
                }
                const paints: Array<{ theme: string; background: string }> = [];
                (window as any).__contextThemePaints = paints;
                (window as any).__contextThemeMediaEvents = 0;
                matchMedia("(prefers-color-scheme: dark)").addEventListener(
                  "change",
                  () => {
                    (window as any).__contextThemeMediaEvents++;
                  },
                );
                (window as any).__contextThemeStorageEvents = [];
                addEventListener("storage", (event) => {
                  if (event.key === "flowai.theme")
                    (window as any).__contextThemeStorageEvents.push(
                      event.newValue,
                    );
                });
                const capture = () => {
                  if (document.body?.getBoundingClientRect().height)
                    paints.push({
                      theme:
                        document.documentElement.dataset.theme ?? "missing",
                      background: getComputedStyle(document.body)
                        .backgroundColor,
                    });
                  if (paints.length < 20) requestAnimationFrame(capture);
                };
                requestAnimationFrame(capture);
              }, storage);
              await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
              const html = page.locator("html");
              await expect(
                page.getByRole("combobox", { name: "Team", exact: true }),
              ).toBeVisible();
              await expect(html).toHaveAttribute("data-theme", initial);
              await expect
                .poll(() =>
                  page.evaluate(
                    () => (window as any).__contextThemePaints.length,
                  ),
                )
                .toBeGreaterThan(0);
              expect(
                await page.evaluate(
                  ({ initial, background }) =>
                    (window as any).__contextThemePaints.every(
                      (paint: any) =>
                        paint.theme === initial &&
                        paint.background === background,
                    ),
                  {
                    initial,
                    background:
                      initial === "dark"
                        ? "rgb(9, 11, 18)"
                        : "rgb(245, 247, 250)",
                  },
                ),
              ).toBe(true);
              if (storage === "read_denied" || storage === "write_denied")
                expect(
                  await page.evaluate((storage) => {
                    try {
                      if (storage === "read_denied")
                        localStorage.getItem("probe");
                      else localStorage.setItem("probe", "must-not-persist");
                      return false;
                    } catch {
                      return true;
                    }
                  }, storage),
                ).toBe(true);
              let expected: string = initial;
              if (transition === "OS_change") {
                await page.emulateMedia({
                  colorScheme: os === "dark" ? "light" : "dark",
                });
                await expect
                  .poll(() =>
                    page.evaluate(
                      () => (window as any).__contextThemeMediaEvents,
                    ),
                  )
                  .toBe(1);
                expected =
                  stored === "dark" || stored === "light"
                    ? stored
                    : os === "dark"
                      ? "light"
                      : "dark";
              } else if (
                transition === "explicit_toggle" ||
                transition === "reload"
              ) {
                await page
                  .getByRole("button", {
                    name: `Switch to ${opposite} theme`,
                    exact: true,
                  })
                  .click();
                await expect(html).toHaveAttribute("data-theme", opposite);
                expected = opposite;
                if (transition === "reload") {
                  await page.reload();
                  expected =
                    storage === "read_denied" || storage === "write_denied"
                      ? os
                      : opposite;
                }
              } else if (
                transition === "cross_tab_set" ||
                transition === "cross_tab_remove"
              ) {
                const peer = await context.newPage();
                await peer.goto(proxy.baseUrl);
                await expect(peer.locator("html")).toHaveAttribute(
                  "data-theme",
                  initial,
                );
                if (transition === "cross_tab_set") {
                  await peer.evaluate(
                    (value) => localStorage.setItem("flowai.theme", value),
                    opposite,
                  );
                  expected = opposite;
                } else {
                  expect(
                    await peer.evaluate(() =>
                      localStorage.getItem("flowai.theme"),
                    ),
                  ).toBe(stored);
                  await peer.evaluate(() =>
                    localStorage.removeItem("flowai.theme"),
                  );
                  expect(
                    await peer.evaluate(() =>
                      localStorage.getItem("flowai.theme"),
                    ),
                  ).toBeNull();
                  expected = os;
                }
                if (transition === "cross_tab_set" || stored !== null)
                  await expect
                    .poll(() =>
                      page.evaluate(
                        () => (window as any).__contextThemeStorageEvents,
                      ),
                    )
                    .toEqual([
                      transition === "cross_tab_set" ? opposite : null,
                    ]);
                else
                  expect(
                    await page.evaluate(
                      () => (window as any).__contextThemeStorageEvents,
                    ),
                  ).toEqual([]);
              }
              await expect(html).toHaveAttribute("data-theme", expected);
              expect(new URL(page.url()).search).toBe("?view=sources&team=1");
              const storedState =
                (await context.storageState()).origins.find(
                  (origin) => origin.origin === new URL(proxy.baseUrl).origin,
                )?.localStorage ?? [];
              const expectedStored =
                transition === "cross_tab_remove"
                  ? null
                  : transition === "cross_tab_set" ||
                      ((transition === "explicit_toggle" ||
                        transition === "reload") &&
                        storage !== "write_denied")
                    ? opposite
                    : stored;
              expect(storedState).toEqual(
                expectedStored === null
                  ? []
                  : [{ name: "flowai.theme", value: expectedStored }],
              );
              await test.info().attach("theme-cell-outcome", {
                contentType: "application/json",
                body: JSON.stringify({
                  os,
                  storage,
                  transition,
                  initial,
                  expected,
                  expectedStored,
                }),
              });
            } finally {
              await context.close();
            }
          }));
      if (storage !== "read_denied" && storage !== "write_denied") {
        const stored = storage === "absent" ? null : storage;
        await test.step(`v0034.1 first paint OS=${os} stored=${stored}`, () =>
          withFreshContext(browser, async (page) => {
            await page.emulateMedia({ colorScheme: os });
            await page.addInitScript((preference) => {
              if (preference !== null)
                localStorage.setItem("flowai.theme", preference);
              const paints: { theme: string; background: string }[] = [];
              (window as any).__themePaints = paints;
              const capture = () => {
                if (document.body?.getBoundingClientRect().height)
                  paints.push({
                    theme: document.documentElement.dataset.theme ?? "missing",
                    background: getComputedStyle(document.body).backgroundColor,
                  });
                requestAnimationFrame(capture);
              };
              requestAnimationFrame(capture);
            }, stored);
            await page.goto(proxy.baseUrl);
            await expect(
              page.getByRole("combobox", { name: "Team", exact: true }),
            ).toBeVisible();
            const expected =
              stored === "dark" || stored === "light" ? stored : os;
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              expected,
            );
            await expect
              .poll(() =>
                page.evaluate(() => (window as any).__themePaints.length),
              )
              .toBeGreaterThan(0);
            const color =
              expected === "dark" ? "rgb(9, 11, 18)" : "rgb(245, 247, 250)";
            const paints = await page.evaluate(
              () =>
                (window as any).__themePaints as {
                  theme: string;
                  background: string;
                }[],
            );
            expect(
              paints.every(
                (paint) =>
                  paint.theme === expected && paint.background === color,
              ),
            ).toBe(true);
            await page.reload();
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              expected,
            );
          }));
      } else if (os === "dark") {
        const failure = storage === "read_denied" ? "getItem" : "setItem";
        await test.step(`v0034.1 storage ${failure} throws without blocking appearance`, () =>
          withFreshContext(browser, async (page) => {
            await page.emulateMedia({ colorScheme: "dark" });
            await page.addInitScript((method) => {
              Storage.prototype[method] = () => {
                throw new DOMException("Storage unavailable", "SecurityError");
              };
            }, failure);
            await page.goto(proxy.baseUrl);
            await expect(
              page.getByRole("combobox", { name: "Team", exact: true }),
            ).toBeVisible();
            await page
              .getByRole("button", {
                name: "Switch to light theme",
                exact: true,
              })
              .click();
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              "light",
            );
            await page.emulateMedia({ colorScheme: "light" });
            await page.emulateMedia({ colorScheme: "dark" });
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              "light",
            );
          }));
      }
      cells.finish();
    });

for (const theme of ["dark", "light"] as const)
  for (const width of [390, 820, 1440])
    test(`v0034.12 complete Overview and Tasks presentation states ${theme} ${width}`, async ({
      browser,
    }, info) => {
      test.setTimeout(240_000);
      const failures: unknown[] = [];
      const families = {
        "task-history.html": [
          "default",
          "filtered",
          "page-size-25",
          "page-size-50",
          "page-size-100",
          "page-next",
          "empty",
          "no-results",
          "loading",
          "error",
          "operator-zone",
        ],
        "dashboard.html": [
          "default",
          "month",
          "zero",
          "earlier",
          "loading",
          "empty",
          "error",
          "month-earlier",
          "operator-zone",
        ],
      };
      for (const [file, states] of Object.entries(families))
        for (const state of states) {
          const context = await browser.newContext({
            viewport: designViewport(width),
          });
          const page = await context.newPage();
          let release = () => {};
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          const queries: URL[] = [];
          try {
            await page.clock.setFixedTime(new Date("2026-10-18T12:00:00Z"));
            await page.addInitScript(
              (value) => localStorage.setItem("flowai.theme", value),
              theme,
            );
            await page.route("**/ui/v1/operator/settings", (route) =>
              route.fulfill({
                json: { time_zone: "Europe/Moscow" },
                headers: { etag: '"op-1"' },
              }),
            );
            await page.route("**/ui/v1/sources?**", (route) =>
              route.fulfill({
                json: {
                  items: [{ source_id: 7008, name: "Queue" }],
                  next_cursor: null,
                },
              }),
            );
            await page.route("**/ui/v1/flows?**", (route) =>
              route.fulfill({
                json: {
                  items: [{ flow_id: 7037, name: "Review" }],
                  next_cursor: null,
                },
              }),
            );
            const history = file === "task-history.html";
            const empty = ["empty", "no-results", "zero"].includes(state);
            const tasks = Array.from(
              { length: empty ? 0 : 10 },
              (_, index) => ({
                task_id: 9700 + index,
                task_name: `alpha-${9700 + index}`,
                source_id: 7008,
                external_id: `request-${index}`,
                flow_id: 7037,
                current_state: "queued",
                ingested_at: new Date(
                  Date.parse("2026-10-17T21:30:00Z") - index * 1000,
                ).toISOString(),
                claimed_at: null,
                completed_at: null,
                executor_id: null,
                environment: {},
                secret_keys: [],
              }),
            );
            await page.route("**/ui/v1/teams/1/tasks?**", async (route) => {
              const url = new URL(route.request().url());
              if (history) queries.push(url);
              if (state === "loading") await held;
              if (["loading", "error"].includes(state))
                return route.fulfill({
                  status: 503,
                  json: { code: "temporarily_unavailable" },
                });
              await route.fulfill({
                json: {
                  items: tasks.map((row) => ({
                    ...row,
                    // The approved page-next sample carries a long external
                    // id whose cell exceeds two lines, so the collection
                    // stacks to cards at every width.
                    external_id: url.searchParams.has("cursor")
                      ? `next-${row.external_id}-invoice-batch-2026-10-15-quarterly-reconciliation-east-region-001`
                      : row.external_id,
                  })),
                  next_cursor:
                    history &&
                    state === "page-next" &&
                    !url.searchParams.has("cursor")
                      ? "next-page"
                      : null,
                },
              });
            });
            await page.route("**/ui/v1/teams/1/dashboard?**", async (route) => {
              const url = new URL(route.request().url());
              queries.push(url);
              if (state === "loading") await held;
              if (["loading", "error"].includes(state))
                return route.fulfill({
                  status: 503,
                  json: { code: "temporarily_unavailable" },
                });
              const month = url.searchParams.get("period") === "month",
                earlier = state.includes("earlier");
              const start = month
                ? earlier
                  ? "2026-09-01"
                  : "2026-10-01"
                : earlier
                  ? "2026-10-05"
                  : "2026-10-12";
              // The approved empty state is a dashboard read without any
              // bucket; zero keeps a full all-zero week.
              const buckets = Array.from(
                {
                  length:
                    state === "empty" ? 0 : month ? (earlier ? 30 : 31) : 7,
                },
                (_, index) => {
                  const date = new Date(
                      Date.parse(start + "T00:00:00Z") + index * 86400000,
                    ),
                    key = date.toISOString().slice(0, 10),
                    total = empty ? 0 : index % 5;
                  return {
                    key,
                    at: new Date(date.getTime() - 3 * 3600000).toISOString(),
                    total,
                    counts: {
                      queued: total,
                      created: 0,
                      running: 0,
                      finished: 0,
                      failed: 0,
                    },
                    is_future: key > "2026-10-18",
                  };
                },
              );
              await route.fulfill({
                json: {
                  period: month ? "month" : "week",
                  time_zone: "Europe/Moscow",
                  counts: {
                    queued: buckets.reduce((a, b) => a + b.total, 0),
                  },
                  buckets,
                },
              });
            });
            const query = new URLSearchParams({
              view: history ? "history" : "dashboard",
              team: "1",
            });
            if (state.startsWith("page-size-"))
              query.set("limit", state.slice(10));
            if (["filtered", "no-results"].includes(state))
              query.set("search", state === "filtered" ? "request" : "absent");
            if (state === "operator-zone" && history)
              query.set("date", "2026-10-18");
            if (state.includes("month")) {
              query.set("period", "month");
              query.set(
                "month",
                state.includes("earlier") ? "2026-09" : "2026-10",
              );
            } else if (state === "earlier") {
              query.set("period", "week");
              query.set("week", "2026-W41");
            }
            await page.goto(`${proxy.baseUrl}?${query}`);
            await expect.poll(() => queries.length).toBeGreaterThan(0);
            expect(queries.at(-1)!.searchParams.get("time_zone")).toBe(
              "Europe/Moscow",
            );
            if (state === "page-next") {
              await page
                .getByRole("button", { name: "Next", exact: true })
                .click();
              await expect
                .poll(() =>
                  queries.some(
                    (url) => url.searchParams.get("cursor") === "next-page",
                  ),
                )
                .toBe(true);
              await expect(
                page
                  .getByText(
                    "next-request-0-invoice-batch-2026-10-15-quarterly-reconciliation-east-region-001",
                    { exact: true },
                  )
                  .filter({ visible: true }),
              ).toBeVisible();
            }
            if (["loading", "error"].includes(state)) {
              await expect(
                page
                  .locator(history ? "#results" : "#app")
                  .getByRole(state === "loading" ? "status" : "alert")
                  .first(),
              ).toBeVisible();
              await expect(
                page
                  .locator(history ? "#results" : "#app")
                  .getByRole("heading", {
                    name: state === "loading" ? "Loading…" : "Request failed",
                    exact: true,
                  })
                  .first(),
              ).toBeVisible();
            } else if (history) {
              if (empty)
                await expect(page.locator("#results")).toContainText(
                  /No data|No matching records/,
                );
              else
                await expect(
                  page.getByRole("link", { name: "alpha-9700", exact: true }),
                ).toBeVisible();
              if (state.startsWith("page-size-"))
                expect(queries.at(-1)!.searchParams.get("limit")).toBe(
                  state.slice(10),
                );
            } else if (state === "empty")
              // A dashboard read without buckets collapses to the approved
              // No data panel while Recent tasks stays available.
              await expect(
                page.getByRole("heading", { name: "No data", exact: true }),
              ).toBeVisible();
            else {
              await expect(page.locator("[data-dashboard-date]")).toHaveCount(
                state.includes("month")
                  ? state.includes("earlier")
                    ? 30
                    : 31
                  : 7,
              );
              if (state === "zero") {
                // The approved zero state hides the period controls and the
                // Recent tasks panel.
                await expect(
                  page.getByRole("button", { name: "Week", exact: true }),
                ).toBeHidden();
                await expect(
                  page.getByRole("heading", {
                    name: "Recent tasks",
                    exact: true,
                  }),
                ).toBeHidden();
              }
            }
            await captureDesignState(
              page,
              info,
              proxy.webUIImageID,
              `${file}-${state}-${theme}-${width}`,
            );
          } catch (error) {
            failures.push(error);
            await info.attach(`${file}-${state}-failure`, {
              body: String(error),
              contentType: "text/plain",
            });
          } finally {
            release();
            await context.close();
          }
        }
      if (failures.length)
        throw new AggregateError(failures, "Overview/Tasks presentation batch");
    });
