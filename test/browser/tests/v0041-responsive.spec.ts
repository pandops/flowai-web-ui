import path from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import {
  cancelFlow,
  createFlowEntry,
  flowEditor,
  saveFlow,
} from "../fixtures/flow-editor";
import { createSourceEntry } from "../fixtures/source-wizard";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivors of task-sources-interface responsive.browser.spec.ts (v0041 D15).
// The real State Registry is replaced by Gateway-shaped /ui/v1 responses; the
// Registry half (archived models kept in filtered pages) is not asserted here.
// Design screenshots of the original are design capture without an oracle.

const team = 1;
const sourceID = 8013;
const secondSourceID = 8014;
const flowID = 8009;

const sourceRecord = (source_id: number, name: string) => ({
  source_id,
  name,
  team_id: team,
  revision: 2,
  mode: "webhook",
  enabled: true,
  contract_version: "source.v1",
  implementation_version: "1",
  description: "",
  filter_summary: "",
  settings_status: "complete",
  health: "healthy",
  last_seen_at: null,
  polling: null,
  last_poll: null,
  webhook_url: `https://receiver.example/webhook/1/${name}/task`,
  intake_counts: {
    published: 0,
    rejected: 0,
    accepted: 0,
    deduplicated: 0,
    no_target: 0,
    failed: 0,
  },
});

const modelRecord = (name: string, archived = false) => ({
  name,
  model_alias: `${team}/${name}`,
  provider: "openai",
  provider_model: "x",
  api_base: null,
  paused: false,
  archived_at: archived ? "2026-10-18T00:00:00Z" : null,
  editable: true,
  credential_configured: false,
});

type Catalog = {
  sources: ReturnType<typeof sourceRecord>[];
  models: ReturnType<typeof modelRecord>[];
  flows: Record<string, unknown>[];
};

async function mockCatalog(page: Page, catalog: Catalog) {
  const writes: { method: string; path: string; body: string | null }[] = [];
  const list = (route: Route, items: unknown[]) =>
    route.fulfill({ json: { items, next_cursor: null } });
  await page.route(
    /\/ui\/v1\/(?:flows|flow-llm-settings|sources|models|execution-tags)(?:[/?].*)?$/,
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const parts = url.pathname.split("/").slice(3);
      const method = request.method();
      if (method !== "GET")
        writes.push({ method, path: url.pathname, body: request.postData() });
      const [kind, id] = parts;
      if (kind === "execution-tags") return list(route, ["openhands"]);
      if (kind === "models") {
        if (!id)
          return list(
            route,
            catalog.models.filter(
              (model) =>
                (model.archived_at !== null) ===
                (url.searchParams.get("archived") === "true"),
            ),
          );
        const model = catalog.models.find((item) => item.name === id);
        if (!model)
          return route.fulfill({ status: 404, json: { code: "not_found" } });
        if (method === "PUT")
          Object.assign(model, JSON.parse(request.postData() ?? "{}"));
        return route.fulfill({ json: model, headers: { etag: '"m-1"' } });
      }
      if (kind === "sources") {
        if (!id) return list(route, catalog.sources);
        const source = catalog.sources.find(
          (item) => item.source_id === Number(id),
        );
        if (!source)
          return route.fulfill({ status: 404, json: { code: "not_found" } });
        if (parts[2] === "settings")
          return route.fulfill({
            headers: { etag: `"rev-${source.revision}"` },
            json: {
              source_id: id,
              mode: source.mode,
              settings_status: source.settings_status,
              schema_revision: 1,
              revision: source.revision,
              fields: [],
              platform: {
                webhook_url: source.webhook_url,
              },
              polling: null,
              last_poll: null,
            },
          });
        return route.fulfill({
          json: source,
          headers: { etag: `"rev-${source.revision}"` },
        });
      }
      const withModels = (flow: Record<string, any>) => ({
        ...flow,
        models: flow.model_aliases.map((model_alias: string) => ({
          model_alias,
          availability: "active",
        })),
      });
      if (!id) {
        if (method === "POST") {
          const created = {
            ...JSON.parse(request.postData() ?? "{}"),
            flow_id: 8027,
            revision: 1,
          };
          catalog.flows.push(created);
          return route.fulfill({
            status: 201,
            json: created,
            headers: { etag: '"1"' },
          });
        }
        return list(
          route,
          kind === "flows" ? catalog.flows : catalog.flows.map(withModels),
        );
      }
      const flow = catalog.flows.find((item) => item.flow_id === id);
      if (!flow)
        return route.fulfill({ status: 404, json: { code: "not_found" } });
      return route.fulfill({
        json: kind === "flows" ? flow : withModels(flow),
        headers: { etag: `"${flow.revision}"` },
      });
    },
  );
  await page.route(/\/ui\/v1\/teams\/[^/]+\/tasks(?:\?.*)?$/, (route) =>
    list(route, []),
  );
  return writes;
}

const flowRecord = () => ({
  flow_id: flowID,
  name: "Flow one",
  revision: 1,
  execution_tag: "openhands",
  model_aliases: [`${team}/model`],
  prompt_template: "Work {{external_id}}",
  execution_parameters: {},
  default_image: null,
  source_ids: [sourceID],
  source_revisions: { [sourceID]: 2 },
  per_task_limit: null,
  flow_limit: null,
  created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z",
});

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: team, team_name: "intake" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

for (const viewport of [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
]) {
  test(`v0013.2 / ${viewport.name} navigation, catalog alignment and dialog containment`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const catalog: Catalog = {
      sources: [sourceRecord(sourceID, "event-source")],
      models: [modelRecord("model")],
      flows: [flowRecord()],
    };
    const writes = await mockCatalog(page, catalog);
    expect(proxy.webUIImageID).toBeTruthy();
    await page.setViewportSize(viewport);
    await page.goto(`${proxy.baseUrl}/?view=flows&team=${team}`);
    await expect(createFlowEntry(page)).toBeVisible();
    await expect(
      page
        .locator('#flows-results [data-catalog-view="source"]:visible')
        .first(),
    ).toHaveText("event-source");
    // The approved Flows catalog (ui-mockups/flows.html) has no policy
    // disclosure; its create entry is the 44px touch target here.
    await expect(page.locator(".policy-help")).toHaveCount(0);
    expect(
      (await createFlowEntry(page).boundingBox())?.height,
    ).toBeGreaterThanOrEqual(44);
    if (viewport.name === "phone") {
      const menu = page.getByRole("button", {
        name: /^(Open|Close) navigation$/,
      });
      await expect(menu).toBeVisible();
      await menu.click();
    }
    for (const name of ["Overview", "Flows", "Tasks", "Sources", "Settings"]) {
      const link = page
        .locator(".nav-links")
        .getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link.locator("svg.nav-icon")).toBeVisible();
      expect(
        await link.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
      ).toBeGreaterThan(0);
    }
    // v0034 reaches Executors through Settings, not primary navigation.
    await expect(
      page.locator(".nav-links").getByRole("link", { name: "Executors" }),
    ).toHaveCount(0);
    const activeLink = page.locator('.nav-links [aria-current="page"]');
    expect
      .soft(
        await activeLink.evaluate((e) => getComputedStyle(e).backgroundColor),
      )
      .not.toBe("rgba(0, 0, 0, 0)");
    if (viewport.name === "phone") {
      await page.keyboard.press("Escape");
      const menu = page.getByRole("button", {
        name: /^(Open|Close) navigation$/,
      });
      await expect(menu).toBeFocused();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await menu.click();
      const sources = page
        .locator(".nav-links")
        .getByRole("link", { name: "Sources", exact: true });
      await sources.focus();
      await sources.press("Enter");
      await expect(createSourceEntry(page)).toBeVisible();
      await expect(menu).toBeFocused();
      await expect(menu).toHaveAttribute("aria-expanded", "false");
      await menu.click();
      await page
        .locator(".nav-links")
        .getByRole("link", { name: "Flows", exact: true })
        .click();
    }
    await createFlowEntry(page).click();
    // v0034: the Flow editor is a standalone page.
    const dialog = flowEditor(page);
    await expect(dialog).toBeVisible();
    if (viewport.name !== "desktop") {
      for (const control of await dialog
        .locator(
          'button:visible, .button:visible, input:visible:not([type="checkbox"]):not([type="radio"]), select:visible',
        )
        .all())
        expect
          .soft(
            (await control.boundingBox())!.height,
            (await control.getAttribute("aria-label")) ||
              (await control.textContent()),
          )
          .toBeGreaterThanOrEqual(44);
    }
    const sizes = await dialog.evaluate((e) => ({
      width: e.clientWidth,
      content: e.scrollWidth,
    }));
    expect(sizes.content).toBeLessThanOrEqual(sizes.width + 1);
    await saveFlow(dialog).scrollIntoViewIfNeeded();
    await expect(saveFlow(dialog)).toBeInViewport();
    await expect(cancelFlow(dialog)).toBeInViewport();
    // Approved fields (ui-mockups/flow-create.html) fill with the --surface
    // token over the --bg page canvas, so the field stays distinguishable.
    const fieldColors = await dialog
      .locator("textarea")
      .first()
      .evaluate((e) => {
        const probe = document.createElement("span");
        probe.style.cssText =
          "background:var(--surface);color:var(--bg);position:absolute";
        document.body.append(probe);
        const style = getComputedStyle(probe);
        const result = {
          field: getComputedStyle(e).backgroundColor,
          surface: style.backgroundColor,
          canvas: style.color,
        };
        probe.remove();
        return result;
      });
    expect(fieldColors.field).toBe(fieldColors.surface);
    expect(fieldColors.field).not.toBe(fieldColors.canvas);
    await cancelFlow(dialog).click();
    await page.goto(
      `${proxy.baseUrl}/?view=settings&section=models&team=${team}`,
    );
    await expect(
      page.getByRole("button", { name: "Create model", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator("#models-results")
        .getByText("model", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    if (viewport.name === "desktop") {
      const cells = page.locator("#models-results table tbody td");
      for (const cell of await cells.all())
        expect(await cell.evaluate((e) => getComputedStyle(e).display)).toBe(
          "table-cell",
        );
    } else {
      await expect(page.locator("#models-results table")).not.toBeVisible();
      await expect(page.locator("#models-results .cards")).toBeVisible();
    }
    // Approved Models records show the alias as a peer field and keep
    // commands in the record's 44px Actions menu.
    const record = page
      .locator("#models-results")
      .locator("tr:visible,article:visible")
      .filter({ hasText: `${team}/model` })
      .first();
    await expect(record).toBeVisible();
    expect(
      (
        await record
          .getByRole("button", { name: "Actions for model", exact: true })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
    await page.getByLabel("Filter models by provider").selectOption("openai");
    await page.getByLabel("Filter models by state").selectOption("paused");
    await expect(page.locator("#models-results")).toContainText(
      "No models match",
    );
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      page.getByLabel("Search models", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Search models", { exact: true })
      .fill("no-such-model");
    await expect(page.locator("#models-results")).toContainText(
      "No models match",
    );
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(
      page
        .locator("#models-results")
        .getByText("model", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    if (viewport.name !== "desktop") {
      for (const control of await page
        .locator(
          'button:visible, .button:visible, input:visible:not([type="checkbox"]):not([type="radio"]), select:visible',
        )
        .all())
        expect
          .soft(
            (await control.boundingBox())!.height,
            (await control.getAttribute("aria-label")) ||
              (await control.textContent()),
          )
          .toBeGreaterThanOrEqual(44);
    }
    // Approved pager: Previous, the rows-per-page summary and Next share one
    // row at every width.
    await expect
      .soft(page.locator("[data-model-pagination]"))
      .toContainText("10 rows per page");
    if (viewport.name === "phone") {
      const pager = page.locator("[data-model-pagination]");
      const label = await pager.locator("span").boundingBox();
      const previous = await pager
        .locator("[data-model-previous]")
        .boundingBox();
      const next = await pager.locator("[data-model-next]").boundingBox();
      expect
        .soft(previous!.x + previous!.width)
        .toBeLessThanOrEqual(label!.x + 1);
      expect.soft(label!.x + label!.width).toBeLessThanOrEqual(next!.x + 1);
      expect.soft(Math.abs(previous!.y - next!.y)).toBeLessThanOrEqual(1);
    }
    await page
      .getByRole("button", { name: "Create model", exact: true })
      .click();
    const modelDialog = page.getByRole("dialog", {
      name: "Create model",
      exact: true,
    });
    await expect(modelDialog).toBeVisible();
    await expect(
      modelDialog.getByLabel("Remove the stored API key"),
    ).not.toBeVisible();
    await expect(
      modelDialog.getByRole("button", { name: "Save model", exact: true }),
    ).toBeInViewport();
    const checkbox = await modelDialog.getByLabel("Start paused").boundingBox();
    expect(checkbox?.width).toBeLessThanOrEqual(24);
    expect(checkbox?.height).toBeLessThanOrEqual(24);
    await page.keyboard.press("Escape");
    await page.goto(
      `${proxy.baseUrl}/?view=source&id=${sourceID}&team=${team}`,
    );
    // Approved read-only Source detail has no Source switcher and no in-page
    // back link; a webhook Source shows no Last poll section.
    await expect(
      page.getByRole("heading", { name: "event-source", exact: true }),
    ).toBeVisible();
    await expect
      .soft(page.getByRole("heading", { name: "Last poll", exact: true }))
      .toHaveCount(0);
    expect
      .soft(
        await page
          .locator("#source-detail .link-list")
          .filter({ has: page.locator('[data-catalog-view="flow"]') })
          .evaluate((e) => getComputedStyle(e).justifyContent),
      )
      .not.toBe("flex-end");
    // A Source registered after the first read appears in the next catalog.
    catalog.sources.push(sourceRecord(secondSourceID, "second-source"));
    await page.goto(`${proxy.baseUrl}/?view=sources&team=${team}`);
    await page
      .locator("#source-results")
      .getByRole("link", { name: "second-source", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "second-source", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`id=${secondSourceID}`));
    await page.goBack();
    await expect(page).toHaveURL(/view=sources/);
    await expect(
      page
        .locator("#source-results")
        .getByRole("link", { name: "second-source", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
    // Navigation, cancel and dismissal never write.
    expect(writes).toEqual([]);
  });
}

test("v0013.2 / Models filters and pagination retain archived records", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const catalog: Catalog = {
    sources: [sourceRecord(sourceID, "event-source")],
    models: [
      modelRecord("model"),
      ...Array.from({ length: 11 }, (_, n) =>
        modelRecord(`archived-${String(n).padStart(2, "0")}`, true),
      ),
    ],
    flows: [flowRecord()],
  };
  const writes = await mockCatalog(page, catalog);
  await page.goto(
    `${proxy.baseUrl}/?view=settings&section=models&team=${team}`,
  );
  const archive = page.locator("#archived-models-results");
  await expect(archive.locator("table tbody tr")).toHaveCount(10);
  await archive.getByRole("button", { name: "Next", exact: true }).click();
  await expect(archive.locator("table tbody tr")).toHaveCount(1);
  await page.getByLabel("Search models", { exact: true }).fill("archived-05");
  await expect(archive.locator("table tbody tr")).toHaveCount(1);
  await expect(archive).toContainText("archived-05");
  await expect(
    archive.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Filter models by state").selectOption("active");
  await expect(archive).toContainText("No archived models match");
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByLabel("Filter models by state").selectOption("archived");
  await expect(page.locator("#models-results")).toContainText(
    "No models match",
  );
  await expect(archive.locator("table tbody tr")).toHaveCount(10);
  await page.getByLabel("Filter models by provider").selectOption("openai");
  await expect(archive.locator("table tbody tr")).toHaveCount(10);
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(
    page
      .locator("#models-results")
      .getByText("model", { exact: true })
      .filter({ visible: true }),
  ).toBeVisible();
  await expect(archive.locator("table tbody tr")).toHaveCount(10);
  // Current catalog failure must not disable a successful archive's filters.
  await page.route("**/ui/v1/models?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("archived") === "false")
      await route.fulfill({ status: 503, json: { code: "unavailable" } });
    else await route.fallback();
  });
  await page.reload();
  await expect(page.locator("#models-results [role=alert]")).toBeVisible();
  await expect(archive.locator("table tbody tr")).toHaveCount(10);
  await page.getByLabel("Search models", { exact: true }).fill("archived-05");
  await expect(archive.locator("table tbody tr")).toHaveCount(1);
  await expect(archive).toContainText("archived-05");
  await page.unroute("**/ui/v1/models?*");
  await page.reload();
  await expect(archive.locator("table tbody tr")).toHaveCount(10);
  // A delayed Current response must not repaint stale archive data over 503.
  let releaseCurrent!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  await page.route("**/ui/v1/models?*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("archived") === "true")
      await route.fulfill({ status: 503, json: { code: "unavailable" } });
    else {
      await held;
      await route.fallback();
    }
  });
  // v0034 places Pause in the record's single actions menu.
  await page
    .locator("#models-results")
    .getByRole("button", { name: /^Actions for / })
    .first()
    .click();
  await page
    .locator("#models-results [data-pause-model]:visible")
    .first()
    .click();
  const pause = page.locator("#model-pause-dialog");
  await pause.getByRole("button", { name: "Pause model", exact: true }).click();
  await expect(archive.locator("[role=alert]")).toBeVisible();
  releaseCurrent();
  // The paused record offers Resume in its actions menu.
  await expect(
    page.locator("#models-results .badge.paused:visible").first(),
  ).toBeVisible();
  await page
    .locator("#models-results")
    .getByRole("button", { name: /^Actions for / })
    .first()
    .click();
  const recordMenu = page.getByRole("menu", { name: /^Actions for / });
  await expect(
    recordMenu.getByRole("menuitem", { name: "Resume", exact: true }),
  ).toBeVisible();
  await expect(
    recordMenu.getByRole("menuitem", { name: "Pause", exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(archive.locator("[role=alert]")).toBeVisible();
  await expect(archive.locator("table tbody tr")).toHaveCount(0);
  await page.unroute("**/ui/v1/models?*");
  // Pause is one conditional PUT that keeps the provider identity.
  expect(writes).toEqual([
    {
      method: "PUT",
      path: "/ui/v1/models/model",
      body: JSON.stringify({
        provider: "openai",
        provider_model: "x",
        api_base: null,
        paused: true,
      }),
    },
  ]);
});
