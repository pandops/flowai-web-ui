import { captureDesignState, designViewport } from "../fixtures/design-capture";
import { flowEditor } from "../fixtures/flow-editor";
import path from "node:path";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { flowFixture, flowID } from "../fixtures/v0034-flow";

// Fail missing-control actions before the test deadline, leaving teardown time.
test.use({ actionTimeout: 10_000 });

let proxy: MockedProxy;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  proxy = await startMockedProxy(
    [{ team_id: 1, team_name: "alpha" }],
    path.resolve(__dirname, "../../../web/index.html"),
  );
});
test.afterAll(async () => {
  // Stopping the Web UI container is slow on a busy container store.
  test.setTimeout(120_000);
  await proxy?.close();
});

// Approved primary and Settings navigation with its decorative Lucide icons,
// recorded once from the v0034 settings-models design.
const approvedNavigation = [
  { nav: "Main navigation", name: "Overview", icon: "layout-dashboard" },
  { nav: "Main navigation", name: "Flows", icon: "workflow" },
  { nav: "Main navigation", name: "Tasks", icon: "list-checks" },
  { nav: "Main navigation", name: "Sources", icon: "radio-tower" },
  { nav: "Main navigation", name: "Settings", icon: "settings-2" },
  { nav: "Settings sections", name: "Parameters", icon: "sliders-horizontal" },
  { nav: "Settings sections", name: "Models", icon: "brain-circuit" },
  { nav: "Settings sections", name: "Executors", icon: "server" },
  { nav: "Settings sections", name: "Operator", icon: "user-round" },
];

// Each step runs on its own page with its own mocked routes, keeps the final
// capture of the test it came from, and a failing step does not hide later ones.
async function runSteps(
  context: BrowserContext,
  info: TestInfo,
  theme: string,
  width: number,
  list: [string, (page: Page) => Promise<void>][],
) {
  const failures: unknown[] = [];
  for (const [title, run] of list) {
    const page = await context.newPage();
    try {
      await test.step(title, async () => {
        await page.setViewportSize(designViewport(width));
        await page.addInitScript(
          (theme) => localStorage.setItem("flowai.theme", theme),
          theme,
        );
        await run(page);
      });
    } catch (error) {
      failures.push(error);
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
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
}

const mergedPrefix = "v0034.12+v0034.2 shared header";

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`${mergedPrefix}, navigation icons, badges${width <= 820 ? " and Menu after scrolling" : ""} ${theme} ${width}`, async ({
      context,
    }, info) => {
      test.setTimeout(30_000 * (width <= 820 ? 4 : 3));
      const list: [string, (page: Page) => Promise<void>][] = [
        [
          `v0034.12 Team label stays visible with aligned selector and theme controls ${theme} ${width}`,
          async (page) => {
            await flowFixture(page);
            await page.goto(
              `${proxy.baseUrl}?view=settings&section=models&team=1`,
            );
            const team = page.locator(".team");
            const label = team.locator("label");
            await expect(label).toHaveText("Team");
            await expect(label).toBeVisible();
            const selector = team.getByRole("combobox", {
              name: "Team",
              exact: true,
            });
            const themeControl = team.getByRole("button", {
              name: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
              exact: true,
            });
            await expect(selector).toBeVisible();
            await expect(themeControl).toBeVisible();
            const boxes = await Promise.all([
              selector.boundingBox(),
              themeControl.boundingBox(),
              label.boundingBox(),
            ]);
            expect(boxes[0]!.height).toBe(44);
            expect(boxes[1]!.height).toBe(44);
            expect(boxes[0]!.y).toBeCloseTo(boxes[1]!.y, 0);
            expect(boxes[0]!.y + boxes[0]!.height).toBeCloseTo(
              boxes[1]!.y + boxes[1]!.height,
              0,
            );
            const header = await page
              .locator(width > 680 ? ".topbar" : ".mobile-bar")
              .boundingBox();
            expect(header).not.toBeNull();
            expect(boxes[0]!.y).toBeGreaterThanOrEqual(header!.y);
            expect(boxes[0]!.y + boxes[0]!.height).toBeLessThanOrEqual(
              header!.y + header!.height,
            );
            expect(boxes[2]!.x).toBeGreaterThanOrEqual(0);
            expect(boxes[2]!.x + boxes[2]!.width).toBeLessThanOrEqual(width);
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true);
          },
        ],
        [
          `v0034.2 navigation uses approved decorative18px icon paths ${theme} ${width}`,
          async (page) => {
            await flowFixture(page);
            await page.goto(
              `${proxy.baseUrl}?view=settings&section=models&team=1`,
            );
            const menu = page.getByRole("button", {
              name: /^(Open|Close) navigation$/,
            });
            if (await menu.isVisible()) await menu.click();
            for (const reference of approvedNavigation) {
              // Phone widths show primary navigation in the approved Menu panel.
              const nav = page.getByRole("navigation", {
                name:
                  reference.nav === "Main navigation" && width <= 680
                    ? "Mobile navigation"
                    : reference.nav,
                exact: true,
              });
              const link = nav.getByRole("link", {
                  name: reference.name,
                  exact: true,
                }),
                icon = link.locator("svg");
              await expect(link).toBeVisible();
              await expect(icon).toHaveAttribute("aria-hidden", "true");
              await expect(icon).toHaveAttribute("focusable", "false");
              await expect(icon).toHaveAttribute(
                "data-lucide-icon",
                reference.icon,
              );
              expect(
                await icon.evaluate((element) => ({
                  width: element.getBoundingClientRect().width,
                  height: element.getBoundingClientRect().height,
                })),
              ).toEqual({ width: 18, height: 18 });
            }
            // Navigation order: each nav lists exactly the approved links in order.
            for (const [label, names] of [
              [
                width <= 680 ? "Mobile navigation" : "Main navigation",
                ["Overview", "Flows", "Tasks", "Sources", "Settings"],
              ],
              [
                "Settings sections",
                ["Parameters", "Models", "Executors", "Operator"],
              ],
            ] as const)
              await expect(
                page
                  .getByRole("navigation", { name: label, exact: true })
                  .getByRole("link"),
              ).toHaveText([...names]);
          },
        ],
        [
          `v0034.12 shared badges retain approved typography padding and full long labels ${theme} ${width}`,
          async (page) => {
            await flowFixture(page);
            await page.goto(`${proxy.baseUrl}?view=flow&team=1&id=${flowID}`);
            const badge = page
              .locator("#flow-detail .flow-models .badge")
              .first();
            await expect(badge).toBeVisible();
            const geometry = await badge.evaluate((element) => {
              const style = getComputedStyle(element),
                box = element.getBoundingClientRect();
              return {
                height: box.height,
                font: style.fontSize,
                weight: style.fontWeight,
                tracking: parseFloat(style.letterSpacing),
                lineHeight: style.lineHeight,
                transform: style.textTransform,
                borderWidth: style.borderTopWidth,
                borderStyle: style.borderTopStyle,
                radius: style.borderRadius,
                top: style.paddingTop,
                bottom: style.paddingBottom,
                left: style.paddingLeft,
                right: style.paddingRight,
                interactive: element.matches("button,a,input,[tabindex]"),
              };
            });
            expect(geometry).toEqual({
              height: 28,
              font: "12px",
              weight: "600",
              tracking: 0.72,
              lineHeight: "16.2px",
              transform: "uppercase",
              borderWidth: "1px",
              borderStyle: "solid",
              radius: "4px",
              top: "4px",
              bottom: "4px",
              left: "8px",
              right: "8px",
              interactive: false,
            });
            const wrapping = await badge.evaluate((element) => {
              const box = document.createElement("div");
              box.style.cssText = "width:72px;max-width:72px";
              const sample = element.cloneNode(true) as HTMLElement;
              sample.textContent = "Unavailable";
              box.append(sample);
              element.closest("section")!.append(box);
              const style = getComputedStyle(sample),
                rect = sample.getBoundingClientRect();
              const result = {
                height: rect.height,
                width: rect.width,
                scroll: sample.scrollHeight,
                client: sample.clientHeight,
                padding:
                  parseFloat(style.paddingTop) +
                  parseFloat(style.paddingBottom),
                text: sample.textContent,
              };
              box.remove();
              return result;
            });
            expect(wrapping.text).toBe("Unavailable");
            expect(wrapping.width).toBeLessThanOrEqual(72);
            expect(wrapping.height).toBeGreaterThan(28);
            expect(wrapping.scroll).toBeLessThanOrEqual(wrapping.client + 1);
            expect(wrapping.padding).toBe(8);
            await page
              .getByRole("link", { name: "Edit flow", exact: true })
              .click();
            await expect(
              flowEditor(page).getByLabel("Name", { exact: true }),
            ).toHaveValue("Order flow");
            for (const control of await page
              .locator(
                "#flow-form [data-model-grip],#flow-form [data-command-trigger],#flow-form [data-model-list] select",
              )
              .all()) {
              const box = await control.boundingBox();
              expect(box!.height).toBeGreaterThanOrEqual(44);
            }
          },
        ],
      ];
      // Spec scenario "Mobile navigation after scrolling": the Menu panel
      // opens below the actual sticky header after the page scrolled, stays
      // within the viewport, keeps every link reachable, and Escape returns
      // focus to Menu.
      if (width <= 820)
        list.push([
          `v0034.2 Menu after scrolling opens below the sticky header ${theme} ${width}`,
          async (page) => {
            for (const resource of ["sources", "flows"])
              await page.route(`**/ui/v1/${resource}?**`, (route) =>
                route.fulfill({ json: { items: [], next_cursor: null } }),
              );
            await page.goto(`${proxy.baseUrl}?view=sources&team=1`);
            await expect(page.locator("html")).toHaveAttribute(
              "data-theme",
              theme,
            );
            // Make the page longer than the viewport, then scroll far down.
            await page.locator("main").evaluate((main) => {
              const spacer = document.createElement("div");
              spacer.style.height = "4000px";
              spacer.setAttribute("aria-hidden", "true");
              main.append(spacer);
            });
            await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
            await expect
              .poll(() => page.evaluate(() => scrollY))
              .toBeGreaterThan(1000);
            const menu = page.getByRole("button", {
              name: /^(Open|Close) navigation$/,
            });
            if (width <= 600) await expect(menu).toBeVisible();
            if (!(await menu.isVisible())) {
              // Wider layouts keep primary navigation itself reachable instead.
              for (const name of [
                "Overview",
                "Flows",
                "Tasks",
                "Sources",
                "Settings",
              ]) {
                const link = page
                  .getByRole("navigation", { name: "Main navigation" })
                  .getByRole("link", { name, exact: true });
                await link.focus();
                await expect(link).toBeInViewport();
              }
              return;
            }
            const header = await menu.evaluate((button) => {
              const bar = button.closest("header, .mobile-bar, nav") ?? button;
              const box = bar.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            });
            expect(header.top).toBeGreaterThanOrEqual(-1);
            await menu.click();
            await expect(menu).toHaveAttribute("aria-expanded", "true");
            const panel = page.getByRole("navigation", {
              name: "Mobile navigation",
              exact: true,
            });
            await expect(panel).toBeVisible();
            const box = (await panel.boundingBox())!;
            expect(box.y).toBeGreaterThanOrEqual(header.bottom - 1);
            expect(box.y + box.height).toBeLessThanOrEqual(
              designViewport(width).height + 1,
            );
            for (const name of [
              "Overview",
              "Flows",
              "Tasks",
              "Sources",
              "Settings",
            ]) {
              const link = panel.getByRole("link", { name, exact: true });
              await link.focus();
              await expect(link).toBeFocused();
              await expect(link).toBeInViewport();
              const target = (await link.boundingBox())!;
              expect(target.height).toBeGreaterThanOrEqual(44);
            }
            await page.keyboard.press("Escape");
            await expect(menu).toHaveAttribute("aria-expanded", "false");
            await expect(menu).toBeFocused();
            await expect(panel).not.toBeInViewport();
          },
        ]);
      await runSteps(context, info, theme, width, list);
    });

test("v0034.12 task fields use a fitting two-line table before stacked records", async ({
  page,
}, info) => {
  await flowFixture(page);
  const sourceID = 8013;
  const taskID = 8027;
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({
      json: {
        items: [{ source_id: sourceID, name: "Customer support intake" }],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/ui/v1/flows?**", (route) =>
    route.fulfill({
      json: {
        items: [{ flow_id: flowID, name: "Daily customer response" }],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/ui/v1/teams/1/tasks?**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            task_id: taskID,
            task_name: `alpha-${taskID}`,
            source_id: sourceID,
            flow_id: flowID,
            external_id: "customer event 42",
            current_state: "finished",
            ingested_at: "2026-10-18T00:00:00Z",
            claimed_at: "2026-10-18T00:00:01Z",
            completed_at: "2026-10-18T00:00:21Z",
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.setViewportSize(designViewport(1440));
  await page.goto(`${proxy.baseUrl}?view=history&team=1`);
  // The approved Tasks panel is itself a task collection; the adaptive
  // table/cards wrapper sits inside it.
  const collection = page.locator("#results [data-adaptive-collection]");
  await expect(page.locator("body")).toHaveCSS("font-size", "14px");
  await expect(page.locator("body")).toHaveCSS("line-height", "21px");
  await expect(page.locator("main h1")).toHaveCSS("line-height", "38.4px");
  await expect(collection.locator(":scope > table")).toBeVisible();
  await expect(collection.locator(":scope > .cards")).toBeHidden();
  const cells = collection.locator("tbody td");
  // v0050: seven fields, Task first.
  await expect(cells).toHaveCount(7);
  expect(
    await collection.evaluate((element) => {
      const table = element.querySelector(":scope > table")!;
      const bounds = table.getBoundingClientRect(),
        host = element.getBoundingClientRect();
      return (
        bounds.left >= host.left &&
        bounds.right <= host.right + 1 &&
        table.scrollWidth <= element.clientWidth + 1 &&
        document.documentElement.scrollWidth <= innerWidth
      );
    }),
  ).toBe(true);
  let maximumFieldLines = 0;
  for (const cell of await cells.all()) {
    const lines = await cell.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let maximum = 0;
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        maximum = Math.max(maximum, range.getClientRects().length);
      }
      return maximum;
    });
    maximumFieldLines = Math.max(maximumFieldLines, lines);
    expect(lines).toBeGreaterThanOrEqual(1);
    expect(lines).toBeLessThanOrEqual(2);
  }
  expect(maximumFieldLines).toBe(2);
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    "task-fields-fit-two-lines",
  );
  for (const value of [
    "Customer support intake",
    "Daily customer response",
    "customer event 42",
  ])
    await expect(
      collection.locator(":scope > table").getByText(value, { exact: true }),
    ).toBeVisible();
  await page.setViewportSize(designViewport(820));
  await expect(collection.locator(":scope > table")).toBeHidden();
  await expect(collection.locator(":scope > .cards")).toBeVisible();
  await page.setViewportSize(designViewport(390));
  await expect(collection.locator(":scope > table")).toBeHidden();
  await expect(collection.locator(":scope > .cards")).toBeVisible();
  for (const value of [
    "Customer support intake",
    "Daily customer response",
    "customer event 42",
  ])
    await expect(
      collection.locator(":scope > .cards").getByText(value, { exact: true }),
    ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

// Retained screenshots complement behavior assertions; they are not a full visual verdict.
test.afterEach(async ({ page }, info) => {
  // Merged tests capture the final state of every step themselves.
  if (info.title.startsWith(mergedPrefix)) return;
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});
