import { captureDesignState, designViewport } from "../fixtures/design-capture";
import { sourceWizard } from "../fixtures/source-wizard";
import { cancelFlow, flowEditor } from "../fixtures/flow-editor";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { flowFixture, flowID } from "../fixtures/v0034-flow";
import { parameterFixture } from "../fixtures/v0034-parameters";

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

type CreationResource = "Flows" | "Sources" | "Models" | "Parameters";

const creationView = (resource: CreationResource) =>
  resource === "Models" || resource === "Parameters"
    ? `settings&section=${resource.toLowerCase()}`
    : resource.toLowerCase();

const creationName = (resource: CreationResource) =>
  resource === "Parameters"
    ? "Create parameter"
    : `Create ${{ Flows: "flow", Sources: "source", Models: "model" }[resource]}`;

// Flows and Sources open standalone pages (links); Models and Parameters
// open a dialog or menu (buttons).
const creationButton = (page: Page, resource: CreationResource) =>
  page.getByRole(
    resource === "Flows" || resource === "Sources" ? "link" : "button",
    { name: creationName(resource), exact: true },
  );

// Every step starts on a fresh document with focus on the body and the
// pointer where a new page has it, so no step depends on another.
async function openCatalog(page: Page, view: string) {
  await page.mouse.move(0, 0);
  await page.goto(`${proxy.baseUrl}?view=${view}&team=1`);
}

async function creationTooltipStep(
  page: Page,
  resource: CreationResource,
  width: number,
  writes: unknown[],
) {
  await openCatalog(page, creationView(resource));
  const name = creationName(resource);
  const button = creationButton(page, resource);
  await expect(button).toBeVisible();
  await button.hover();
  const tooltip = page.getByRole("tooltip").filter({ hasText: name });
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(name);
  const target = await button.boundingBox(),
    hint = await tooltip.boundingBox();
  expect(target).not.toBeNull();
  expect(hint).not.toBeNull();
  expect(hint!.x).toBeGreaterThanOrEqual(0);
  expect(hint!.x + hint!.width).toBeLessThanOrEqual(width);
  expect(hint!.y).toBeGreaterThanOrEqual(0);
  expect(hint!.y + hint!.height).toBeLessThanOrEqual(1000);
  expect(
    hint!.x >= target!.x + target!.width ||
      hint!.x + hint!.width <= target!.x ||
      hint!.y >= target!.y + target!.height ||
      hint!.y + hint!.height <= target!.y,
  ).toBe(true);
  await tooltip.hover();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await page.mouse.move(width - 1, 999);
  for (let count = 0; count < 60; count++) {
    await page.keyboard.press("Tab");
    if (await button.evaluate((element) => element === document.activeElement))
      break;
  }
  await expect(button).toBeFocused();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await expect(button).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(writes).toEqual([]);
}

async function creationIconStep(page: Page, resource: CreationResource) {
  await openCatalog(page, creationView(resource));
  const name = creationName(resource);
  const button = creationButton(page, resource);
  await expect(button).toHaveCount(1);
  await expect(button).toHaveAttribute("title", name);
  const icon = button.locator("svg[aria-hidden=true]");
  await expect(icon).toHaveCount(1);
  await expect(icon).toHaveAttribute("focusable", "false");
  await expect(icon).toHaveAttribute("stroke-width", "1.8");
  await expect(icon).toHaveAttribute("viewBox", "0 0 24 24");
  expect(
    await icon.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    })),
  ).toEqual({ width: 18, height: 18 });
  expect(await button.innerText()).toBe("");
  const box = await button.boundingBox();
  expect(box!.width).toBe(44);
  expect(box!.height).toBe(44);
  const heading =
    resource === "Models" || resource === "Parameters"
      ? page.getByRole("heading", { name: resource, exact: true }).last()
      : page.locator("h1");
  const title = await heading.boundingBox();
  expect(
    Math.abs(box!.y + box!.height / 2 - title!.y - title!.height / 2),
  ).toBeLessThanOrEqual(4);
  if (resource === "Models" || resource === "Parameters") {
    // The title icon is the section's only creation control: no lower
    // duplicate create/add/new entry, and no menu item shown before it opens.
    const main = page.locator("main");
    const creation = main
      .locator("button:visible,a:visible,[role=menuitem]:visible")
      .filter({ hasText: /^\s*(create|add|new)\b/i });
    await expect(creation).toHaveCount(0);
    // Only the icon button itself is named as a creation action.
    await expect(
      main.getByRole("button", { name: /^(create|add|new)\b/i }),
    ).toHaveCount(1);
    await expect(
      main.getByRole("link", { name: /^(create|add|new)\b/i }),
    ).toHaveCount(0);
    for (const name of ["Add variable", "Add secret"])
      await expect(
        main
          .getByRole("button", { name, exact: true })
          .or(main.getByRole("link", { name, exact: true }))
          .or(main.getByRole("menuitem", { name, exact: true })),
      ).toHaveCount(0);
  }
  await button.click();
  if (resource === "Parameters") {
    const menu = page.getByRole("menu", { name, exact: true });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Add variable",
      "Add secret",
    ]);
    await menu
      .getByRole("menuitem", { name: "Add variable", exact: true })
      .click();
  }
  await expect(
    resource === "Flows"
      ? flowEditor(page)
      : resource === "Sources"
        ? sourceWizard(page)
        : page.getByRole("dialog", {
            name: resource === "Parameters" ? "Add variable" : "Create model",
            exact: true,
          }),
  ).toBeVisible();
}

async function flowEdgeCommandStep(page: Page, writes: unknown[]) {
  await openCatalog(page, "flows");
  const root = page.locator("#flows-results");
  await expect(
    root.getByRole("link", { name: "Order flow", exact: true }),
  ).toBeVisible();
  await expect(root.locator("th").filter({ hasText: /^Actions$/ })).toHaveCount(
    0,
  );
  // The Flow catalog record is one dl.data-card per Flow.
  const row = root.locator("dl.data-card:visible").filter({
    has: page.getByRole("link", { name: "Order flow", exact: true }),
  });
  const trigger = row.getByRole("button", {
    name: "Actions for Order flow",
    exact: true,
  });
  await expect(trigger).toBeVisible();
  await expect(row.locator("button:visible")).toHaveCount(1);
  await trigger.click();
  await page
    .getByRole("menu", { name: "Actions for Order flow", exact: true })
    .getByRole("menuitem", { name: "Edit flow", exact: true })
    .click();
  await expect(
    flowEditor(page).getByLabel("Name", { exact: true }),
  ).toHaveValue("Order flow");
  await cancelFlow(flowEditor(page)).click();
  await row.getByRole("link", { name: "Order flow", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`view=flow&team=1&id=${flowID}`));
  expect(writes).toEqual([]);
}

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440]) {
    // Flows, Sources and Models share flowFixture's routes.
    test(`v0034.12/v0034.6 Flows, Sources, Models creation icon, tooltip and Flow edge command ${theme} ${width}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const { writes } = await flowFixture(page);
      for (const resource of ["Flows", "Sources", "Models"] as const) {
        await test.step(`v0034.12 ${resource} creation tooltip is visible on hover and keyboard focus ${theme} ${width}`, () =>
          creationTooltipStep(page, resource, width, writes));
        await test.step(`v0034.12 ${resource} has one title-adjacent 44px creation icon ${theme} ${width}`, () =>
          creationIconStep(page, resource));
      }
      await test.step(`v0034.6 Flow catalog single edge command and full canonical fields ${theme} ${width}`, () =>
        flowEdgeCommandStep(page, writes));
    });
    // parameterFixture serves its own Flow list, so Parameters stays apart.
    test(`v0034.12 Parameters creation icon and tooltip ${theme} ${width}`, async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const { writes } = await parameterFixture(page);
      await test.step(`v0034.12 Parameters creation tooltip is visible on hover and keyboard focus ${theme} ${width}`, () =>
        creationTooltipStep(page, "Parameters", width, writes));
      await test.step(`v0034.12 Parameters has one title-adjacent 44px creation icon ${theme} ${width}`, () =>
        creationIconStep(page, "Parameters"));
    });
  }

test("v0034.10 Flow catalog failure: network failure, no in-place Retry, reload loading and recovery", async ({
  page,
}) => {
  const { flows, writes } = await flowFixture(page);
  let reads = 0,
    phase: "network" | "loading" = "network",
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/ui/v1/flow-llm-settings?**", async (route) => {
    if (++reads === 1)
      return route.fulfill({
        status: 503,
        json: { code: "model_gateway_unavailable" },
      });
    if (phase === "network" && reads === 2) return route.abort("failed");
    if (phase === "loading") await held;
    await route.fulfill({
      json: {
        items: [...flows.values()].map((flow) => ({
          ...flow,
          models: flow.model_aliases.map((model_alias) => ({
            model_alias,
            availability: "active",
          })),
          usage: null,
        })),
        next_cursor: null,
      },
    });
  });
  const root = page.locator("#flows-results");
  try {
    await test.step("v0034.10 Flow catalog failure handles network failure and recovers on reload", async () => {
      await page.goto(`${proxy.baseUrl}?view=flows&team=1`);
      // Owner review 2026-10-25: the failure shows without an in-place Retry
      // command; recovery reloads the page.
      await expect(root.getByRole("alert")).toBeVisible();
      await expect(
        root.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect.poll(() => reads).toBe(2);
      await expect(root.getByRole("alert")).toContainText(
        /connection|could not|unavailable|retry/i,
      );
      await expect(
        root.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
      await page.reload();
      await expect(
        root.getByRole("link", { name: "Order flow", exact: true }),
      ).toBeVisible();
      expect(reads).toBe(3);
      expect(writes).toEqual([]);
    });
    await test.step("v0034.10 Flow catalog failure offers no in-place Retry and reload exposes loading", async () => {
      reads = 0;
      phase = "loading";
      await page.goto(`${proxy.baseUrl}?view=flows&team=1`);
      await expect(root.getByRole("alert")).toBeVisible();
      await expect(
        root.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
      await page.reload();
      await expect(root.getByRole("status")).toContainText(/loading/i);
      expect(reads).toBe(2);
      release();
      await expect(
        root.getByRole("link", { name: "Order flow", exact: true }),
      ).toBeVisible();
      expect(writes).toEqual([]);
    });
  } finally {
    release();
  }
});

test("v0034.6 Flow catalog traverses all pages and preserves local search and paging", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const { writes, flows } = await flowFixture(page);
  const base = flows.get(flowID)!;
  const all = Array.from({ length: 217 }, (_, index) => ({
    ...base,
    flow_id: 4400 + index + 1,
    name: `Flow ${String(index + 1).padStart(3, "0")}`,
    model_aliases: [],
    source_ids: [],
  }));
  const reads: string[] = [];
  for (const path of ["flows", "flow-llm-settings"]) {
    await page.route(`**/ui/v1/${path}**`, (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== `/ui/v1/${path}`) {
        const item = all.find((item) =>
          url.pathname.endsWith(`/${item.flow_id}`),
        );
        return route.fulfill({ json: item, headers: { etag: '"1"' } });
      }
      reads.push(`${path}:${url.searchParams.get("cursor") || "first"}`);
      expect([...url.searchParams.keys()].sort()).toEqual(
        url.searchParams.has("cursor") ? ["cursor", "limit"] : ["limit"],
      );
      const cursor = url.searchParams.get("cursor");
      expect(cursor === null || cursor === `${path}-second`).toBe(true);
      return route.fulfill({
        json: {
          items: cursor ? all.slice(200) : all.slice(0, 200),
          next_cursor: cursor ? null : `${path}-second`,
        },
      });
    });
  }
  await page.goto(`${proxy.baseUrl}?view=flows&team=1`);
  await expect
    .poll(() => reads.includes("flow-llm-settings:flow-llm-settings-second"))
    .toBe(true);
  const results = page.locator("#flows-results");
  const visibleLinks = results.locator('a[data-catalog-view="flow"]:visible');
  await expect(visibleLinks).toHaveCount(10);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(visibleLinks.first()).toHaveText("Flow 011");
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(visibleLinks.first()).toHaveText("Flow 011");
  await page.getByLabel("Search", { exact: true }).fill("Flow 217");
  await page.getByLabel("Search", { exact: true }).press("Enter");
  await expect(visibleLinks).toHaveText(["Flow 217"]);
  await visibleLinks.click();
  await expect(
    page.getByRole("heading", { name: "Flow identity", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Back to Flows", exact: true }).click();
  await expect(page.getByLabel("Search", { exact: true })).toHaveValue(
    "Flow 217",
  );
  await expect(visibleLinks).toHaveText(["Flow 217"]);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page
    .getByRole("search", { name: "Flow filters" })
    .getByLabel("Rows per page", { exact: true })
    .selectOption("25");
  await expect(visibleLinks).toHaveCount(25);
  await page.getByLabel("Search", { exact: true }).fill("unknown flow");
  await page.getByLabel("Search", { exact: true }).press("Enter");
  await expect(results).toContainText("No flows match these filters.");
  expect(writes).toEqual([]);
});

test("v0034.6 Flow catalog rejects later-page-error and cursor-cycle without partial success", async ({
  page,
}) => {
  const { writes, flows } = await flowFixture(page);
  let mode: "later-page-error" | "cursor-cycle" = "later-page-error",
    reads = 0,
    recovered = false;
  await page.route("**/ui/v1/flow-llm-settings?**", (route) => {
    reads++;
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (recovered)
      return route.fulfill({
        json: { items: [...flows.values()], next_cursor: null },
      });
    if ((mode === "later-page-error" && cursor) || reads >= 3)
      return route.fulfill({
        status: 503,
        json: { code: "fixture_failure" },
      });
    return route.fulfill({
      json: {
        items: [...flows.values()],
        next_cursor: "fixture-repeat-cursor",
      },
    });
  });
  for (const current of ["later-page-error", "cursor-cycle"] as const)
    await test.step(`v0034.6 Flow catalog rejects ${current} without presenting partial success`, async () => {
      mode = current;
      reads = 0;
      recovered = false;
      await page.goto(`${proxy.baseUrl}?view=flows&team=1`);
      const root = page.locator("#flows-results");
      await expect(root.getByRole("alert")).toBeVisible();
      await expect(
        root.locator('a[data-catalog-view="flow"]:visible'),
      ).toHaveCount(0);
      expect(reads).toBe(2);
      // Owner review 2026-10-25: no in-place Retry command; recovery reloads.
      await expect(
        root.getByRole("button", { name: "Retry", exact: true }),
      ).toHaveCount(0);
      recovered = true;
      await page.reload();
      await expect(
        root.getByRole("link", { name: "Order flow", exact: true }),
      ).toBeVisible();
      expect(writes).toEqual([]);
    });
});

test("v0034.6 Flow catalog controls preserve context while empty, error and loading", async ({
  page,
}) => {
  const { writes } = await flowFixture(page);
  let mode: "loading" | "empty" | "error" = "empty",
    release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/ui/v1/flow-llm-settings?**", async (route) => {
    if (mode === "loading") await held;
    await route.fulfill(
      mode === "error"
        ? { status: 503, json: {} }
        : { json: { items: [], next_cursor: null } },
    );
  });
  const failures: unknown[] = [];
  try {
    // Loading runs last: its held read is released only in teardown.
    for (const current of ["empty", "error", "loading"] as const)
      await test.step(`v0034.6 Flow catalog controls preserve context while ${current}`, async () => {
        mode = current;
        await page.goto(
          `${proxy.baseUrl}?view=flows&team=1&search=saved&limit=25`,
        );
        const root = page.locator("#flows-results");
        if (mode === "loading")
          await expect(root.getByRole("status")).toBeVisible();
        if (mode === "empty")
          await expect(root).toContainText("No records available.");
        if (mode === "error")
          await expect(root.getByRole("alert")).toBeVisible();
        // The loading/empty/error states hide the filter toolbar; the saved
        // query stays in the hidden controls and in the URL.
        const search = page.locator("#flow-filter-search");
        await expect(search).toHaveValue("saved");
        await expect(search).toBeHidden();
        await expect(page).toHaveURL(/search=saved/);
        if (mode !== "empty") await expect(search).toBeDisabled();
        // Programmatic submission also must not navigate when controls are disabled.
        expect(
          await page
            .locator("[data-flow-filters]")
            .evaluate((form) =>
              form.dispatchEvent(
                new Event("submit", { bubbles: true, cancelable: true }),
              ),
            ),
        ).toBe(false);
        await expect(page).toHaveURL(/view=flows&team=1/);
        expect(writes).toEqual([]);
      });
  } catch (error) {
    failures.push(error);
  } finally {
    release();
    try {
      await page.unrouteAll({ behavior: "wait" });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, "Flow filter and teardown failures");
});

for (const theme of ["dark", "light"] as const)
  for (const width of [390, 820, 1440])
    test(`v0034.6 Flow catalog approved presentation states ${theme} ${width}`, async ({
      context,
    }) => {
      test.setTimeout(180_000);
      for (const state of [
        "default",
        "model-unavailable",
        "limit-unknown",
        "loading",
        "empty",
        "error",
      ]) {
        const page = await context.newPage(),
          failures: unknown[] = [];
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
          const { writes, flows } = await flowFixture(page);
          const flow = flows.get(flowID)!;
          await page.route("**/ui/v1/flow-llm-settings?**", async (route) => {
            if (state === "loading") await held;
            if (state === "error")
              return route.fulfill({ status: 503, json: {} });
            return route.fulfill({
              json: {
                items:
                  state === "empty"
                    ? []
                    : [
                        {
                          ...flow,
                          models: flow.model_aliases.map((model_alias) => ({
                            model_alias,
                            availability:
                              state === "model-unavailable"
                                ? "unavailable"
                                : "active",
                          })),
                          flow_limit:
                            state === "limit-unknown"
                              ? { max_budget_usd: "5.00", budget_period: "day" }
                              : null,
                          usage: null,
                        },
                      ],
                next_cursor: null,
              },
            });
          });
          await page.goto(`${proxy.baseUrl}?view=flows&team=1`);
          const root = page.locator("#flows-results");
          if (state === "loading")
            await expect(root.getByRole("status")).toContainText("Loading…");
          else if (state === "empty")
            await expect(root).toContainText("No records available.");
          else if (state === "error")
            await expect(root.getByRole("alert")).toBeVisible();
          else {
            await expect(
              root.getByRole("link", { name: "Order flow", exact: true }),
            ).toBeVisible();
            if (state === "model-unavailable")
              await expect(root.locator(".badge:visible")).toHaveText([
                "Unavailable",
                "Unavailable",
                "Unavailable",
              ]);
            if (state === "limit-unknown") {
              await expect(root).toContainText("Unknown");
              await expect(
                page.locator("[data-flow-notices]").getByRole("status"),
              ).toContainText("Usage unknown");
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
            `flows.html-${state}-${theme}-${width}`,
          );
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
            "Flow state and teardown failures",
          );
      }
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
