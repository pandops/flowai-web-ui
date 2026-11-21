import path from "node:path";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import { cancelFlow, flowEditor, saveFlow } from "../fixtures/flow-editor";
import { modelDialog } from "../fixtures/approved-dialogs";

// Survivor of llm-proxying v0022.9-flow-llm-settings.ui.spec.ts (v0041 D15).
// The State Registry/LiteLLM side of the original (catalog persistence,
// budget-period computation, the real LiteLLM outage) is replaced by a
// stateful mocked /ui/v1 catalog answering per working token with the
// Registry's model, flow and flow-llm-settings shapes and error bodies
// (409 model_name_conflict, 412 stale_revision, 503 model_gateway_unavailable).

test.use({ actionTimeout: 10_000 });

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [
        { team_id: 3, team_name: "acme" },
        { team_id: 2, team_name: "beta" },
      ],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

const PROVIDER_KEY = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9]/;
const CANARY = `canary-ui-provider-key-${Date.now()}`;

function nextMondayUTC(now = new Date()): number {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.getTime();
}

type Model = {
  name: string;
  provider: string;
  provider_model: string;
  api_base: string | null;
  paused: boolean;
  credential: boolean;
  pricing: Record<string, string> | null;
  revision: number;
};

async function registry(page: Page) {
  const acme = "3";
  const models = new Map<string, Model>();
  const flows = new Map<number, any>();
  const state = { outage: false };
  const writes: {
    method: string;
    path: string;
    body: any;
    ifMatch?: string;
  }[] = [];
  const teamOf = (route: Route) =>
    route
      .request()
      .headers()
      .authorization?.replace(/^Bearer working-/, "");
  const fail = (route: Route, status: number, code: string, message: string) =>
    route.fulfill({ status, json: { code, message, request_id: 7032 } });
  const unavailable = (route: Route) =>
    fail(
      route,
      503,
      "model_gateway_unavailable",
      "the model gateway is unavailable",
    );
  const modelView = (m: Model) => ({
    name: m.name,
    model_alias: `${acme}/${m.name}`,
    provider: m.provider,
    provider_model: m.provider_model,
    api_base: m.api_base,
    credential_configured: m.credential,
    created_by: "team",
    model_id: Number.parseInt(
      Buffer.from(m.name).toString("hex").slice(0, 8).padEnd(8, "0"),
      16,
    ),
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    unfinished_task_count: 0,
    paused: m.paused,
    archived_at: null,
    editable: true,
    can_archive: true,
    can_unarchive: false,
    archive_blocking_flows: [],
    pricing_status: m.pricing ? "configured" : "missing",
    pricing: m.pricing,
  });
  const etag = (m: Model) => `"m-${m.name}-${m.revision}"`;
  const availability = (alias: string) =>
    models.get(alias.split("/").at(-1)!)?.paused ? "paused" : "active";
  const settings = (flow: any) => ({
    ...flow,
    models: flow.model_aliases.map((model_alias: string) => ({
      model_alias,
      availability: availability(model_alias),
    })),
    usage:
      !state.outage && flow.flow_limit?.max_budget_usd
        ? {
            spend_usd: 0,
            max_budget_usd: flow.flow_limit.max_budget_usd,
            budget_period: flow.flow_limit.budget_period,
            budget_reset_at: new Date(nextMondayUTC()).toISOString(),
            observed_at: new Date().toISOString(),
          }
        : null,
  });
  const record = (route: Route) => {
    const request = route.request();
    writes.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ? request.postDataJSON() : null,
      ifMatch: request.headers()["if-match"],
    });
  };
  const list = (items: unknown[]) => ({ json: { items, next_cursor: null } });

  await page.route("**/ui/v1/execution-tags**", (route) =>
    route.fulfill(list(teamOf(route) === acme ? ["openhands"] : [])),
  );
  await page.route("**/ui/v1/sources**", (route) => route.fulfill(list([])));
  await page.route("**/ui/v1/teams/*/tasks**", (route) =>
    route.fulfill(list([])),
  );
  await page.route(/\/ui\/v1\/models(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (state.outage) return unavailable(route);
    const team = teamOf(route);
    if (request.method() === "GET") {
      const archived =
        new URL(request.url()).searchParams.get("archived") === "true";
      return route.fulfill(
        list(
          team === acme && !archived ? [...models.values()].map(modelView) : [],
        ),
      );
    }
    record(route);
    const body = request.postDataJSON();
    if (models.has(body.name))
      return fail(
        route,
        409,
        "model_name_conflict",
        "the team already has a model with this name",
      );
    const created: Model = {
      name: body.name,
      provider: body.provider,
      provider_model: body.provider_model,
      api_base: body.api_base,
      paused: Boolean(body.paused),
      credential: Boolean(body.api_key),
      pricing: body.pricing,
      revision: 1,
    };
    models.set(body.name, created);
    return route.fulfill({
      status: 201,
      json: modelView(created),
      headers: { etag: etag(created) },
    });
  });
  await page.route(/\/ui\/v1\/models\/[^/?]+$/, (route) => {
    const request = route.request();
    if (state.outage) return unavailable(route);
    const name = decodeURIComponent(
      new URL(request.url()).pathname.split("/").at(-1)!,
    );
    const model = teamOf(route) === acme ? models.get(name) : undefined;
    if (!model) return fail(route, 404, "not_found", "model not found");
    if (request.method() === "PUT") {
      record(route);
      if (request.headers()["if-match"] !== etag(model))
        return fail(
          route,
          412,
          "stale_revision",
          "the model changed since it was read",
        );
      const body = request.postDataJSON();
      Object.assign(model, {
        provider: body.provider,
        provider_model: body.provider_model,
        api_base: body.api_base,
        paused: Boolean(body.paused),
        pricing: body.pricing ?? model.pricing,
        credential: body.clear_api_key
          ? false
          : Boolean(body.api_key) || model.credential,
        revision: model.revision + 1,
      });
    }
    return route.fulfill({
      json: modelView(model),
      headers: { etag: etag(model) },
    });
  });
  await page.route(/\/ui\/v1\/flows(?:\?.*)?$/, (route) =>
    route.fulfill(list(teamOf(route) === acme ? [...flows.values()] : [])),
  );
  await page.route(/\/ui\/v1\/flows\/[^/?]+$/, (route) => {
    const request = route.request();
    const id = Number(new URL(request.url()).pathname.split("/").at(-1)!);
    const flow = teamOf(route) === acme ? flows.get(id) : undefined;
    if (!flow) return fail(route, 404, "not_found", "flow not found");
    if (request.method() === "PUT") {
      record(route);
      if (state.outage) return unavailable(route);
      if (request.headers()["if-match"] !== `"${flow.revision}"`)
        return fail(
          route,
          412,
          "stale_revision",
          "the flow changed since it was read",
        );
      const body = request.postDataJSON();
      Object.assign(flow, body, { revision: flow.revision + 1 });
    }
    return route.fulfill({
      json: flow,
      headers: { etag: `"${flow.revision}"` },
    });
  });
  await page.route("**/ui/v1/flow-llm-settings**", (route) => {
    const id = Number(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    const team = teamOf(route);
    if (flows.has(id) && team === acme)
      return route.fulfill({
        json: settings(flows.get(id)),
        headers: { etag: `"${flows.get(id).revision}"` },
      });
    return route.fulfill(
      list(team === acme ? [...flows.values()].map(settings) : []),
    );
  });

  const addFlow = (id: number, name: string, aliases: string[]) =>
    flows.set(id, {
      flow_id: id,
      name,
      revision: 2,
      execution_tag: "openhands",
      model_aliases: aliases,
      prompt_template: "Work {{external_id}}",
      execution_parameters: {},
      default_image: null,
      source_ids: [],
      source_revisions: {},
      per_task_limit: null,
      flow_limit: null,
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
    });
  return { models, flows, state, writes, addFlow };
}

const flowCard = (page: Page, name: string) =>
  page
    .locator("#flows-results dl.data-card")
    .filter({ has: page.getByRole("link", { name, exact: true }) });

test("v0022.8 + v0022.9 / web-ui: Settings → Models manages the team catalog without exposing keys; Flows edits ordered models and limits without flow state", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const fake = await registry(page);
  const browserRequests: string[] = [];
  page.on("request", (request) => browserRequests.push(request.url()));
  const acme = "3";

  await test.step("v0022.8 / web-ui: Settings → Models manages the team catalog without exposing keys", async () => {
    // 1. Settings has Parameters and Models; Flows has its own navigation entry.
    await page.goto(
      `${proxy.baseUrl}/?view=settings&section=models&team=${acme}`,
    );
    const nav = page.getByRole("navigation", { name: "Main navigation" });
    await expect(nav.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.getByRole("button", { name: "Models" })).toHaveCount(0);
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
    });
    await expect(
      sections.getByRole("link", { name: "Models" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(sections.getByRole("link")).toHaveText([
      "Parameters",
      "Models",
      "Executors",
      "Operator",
    ]);
    await expect(sections.getByRole("link", { name: "Flows" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Models", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("No current models.")).toBeVisible();
    expect(
      await page.locator("a[href*='litellm'], a[href*=':4000']").count(),
    ).toBe(0);

    await nav.getByRole("link", { name: "Flows", exact: true }).click();
    await expect(page).toHaveURL(/view=flows/);
    await expect(
      page.getByRole("heading", { name: "Flows", level: 1 }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Flows", level: 1 }),
    ).toBeVisible();
    await nav.getByRole("link", { name: "Settings", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("link", { name: "Models" })
      .click();
    await expect(page).toHaveURL(/section=models/);

    // 2. Create a model with a write-only provider key.
    const createModel = async (name: string, key?: string) => {
      await page.getByRole("button", { name: "Create model" }).click();
      const dialog = page.getByRole("dialog", { name: "Create model" });
      await dialog.getByLabel("Name").fill(name);
      await dialog
        .getByLabel("Provider", { exact: true })
        .selectOption("openai");
      await dialog.getByLabel("Provider model").fill("gpt-4o");
      await dialog
        .getByLabel("API base URL (optional)")
        .fill("https://fixture-provider.invalid/v1");
      await dialog.getByLabel("Input price (USD per 1M tokens)").fill("2.5");
      await dialog.getByLabel("Output price (USD per 1M tokens)").fill("10");
      if (key) await dialog.getByLabel("API key (write-only)").fill(key);
      await dialog
        .getByRole("button", { name: "Save model", exact: true })
        .click();
      return dialog;
    };
    const created = await createModel("gpt-4o", CANARY);
    await expect(created).toBeHidden();
    // The key leaves the browser once, in the create body only.
    const create = fake.writes.find((w) => w.path === "/ui/v1/models")!;
    expect(create.body).toMatchObject({
      name: "gpt-4o",
      provider: "openai",
      provider_model: "gpt-4o",
      api_base: "https://fixture-provider.invalid/v1",
      api_key: CANARY,
      pricing: {
        input_usd_per_million_tokens: "2.5",
        output_usd_per_million_tokens: "10",
      },
    });
    const row = page
      .locator("#models-results tr:visible,#models-results article:visible")
      .filter({ has: page.getByRole("link", { name: "gpt-4o", exact: true }) });
    const command = async (label: string) => {
      await row
        .getByRole("button", { name: "Actions for gpt-4o", exact: true })
        .click();
      await page
        .getByRole("menu", { name: "Actions for gpt-4o", exact: true })
        .getByRole("menuitem", { name: label, exact: true })
        .click();
    };
    await expect(row).toContainText(`${acme}/gpt-4o`);
    await expect(row).toContainText("openai");
    await expect(row).toContainText("Active");
    await expect(row).toContainText("Configured");
    await page.reload();
    await expect(row).toContainText("Configured");
    expect(await page.content()).not.toContain(CANARY);
    const stored = await page.evaluate(
      () =>
        JSON.stringify({ ...localStorage }) +
        JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toContain(CANARY);

    // 3. A duplicate name is a conflict shown in the form.
    const duplicate = await createModel("gpt-4o");
    await expect(duplicate.getByRole("alert")).toContainText(
      "already has a model",
    );
    await duplicate.getByRole("button", { name: "Cancel" }).click();

    // Edit: the key field is never pre-filled; a newer change is a conflict.
    await command("Edit model");
    const edit = page.locator("#standalone-model-form");
    await expect(
      page
        .locator(".editor-identity > div", {
          has: page.locator("dt", { hasText: /^Name$/ }),
        })
        .locator("dd"),
    ).toHaveText("gpt-4o");
    await expect(edit.locator('[name="name"]')).toHaveCount(0);
    await expect(
      edit.getByLabel("Replacement API key (write-only)"),
    ).toHaveValue("");
    // Another writer changes the model after the editor read it.
    const model = fake.models.get("gpt-4o")!;
    model.provider_model = "gpt-4o-2024";
    model.revision += 1;
    await edit.getByLabel("Provider model").fill("gpt-4o-mini");
    await edit.getByRole("button", { name: "Save model", exact: true }).click();
    await expect(edit.getByRole("alert")).toContainText("revision changed");
    await edit
      .getByRole("link", { name: "Refresh model", exact: true })
      .click();
    await expect(edit.getByLabel("Provider model")).toHaveValue("gpt-4o-2024");
    await edit.getByLabel("Provider model").fill("gpt-4o-mini");
    await edit.getByLabel("Remove the stored API key").check();
    await edit.getByRole("button", { name: "Save model", exact: true }).click();
    await expect(edit).toBeHidden();
    const puts = fake.writes.filter((w) => w.path === "/ui/v1/models/gpt-4o");
    expect(puts).toHaveLength(2);
    expect(puts[0].ifMatch).toBe('"m-gpt-4o-1"');
    expect(puts[1]).toMatchObject({
      ifMatch: '"m-gpt-4o-2"',
      body: { provider_model: "gpt-4o-mini", clear_api_key: true },
    });
    expect(puts[1].body).not.toHaveProperty("api_key");
    await expect(page.locator("#model-view")).toContainText("gpt-4o-mini");
    await expect(
      page
        .locator("#model-view dt", { hasText: /^Credential configured$/ })
        .locator("xpath=following-sibling::dd[1]"),
    ).toHaveText("No");
    await page
      .getByRole("link", { name: "Back to Models", exact: true })
      .click();
    await expect(row).toContainText("gpt-4o-mini");
    await expect(row).toContainText("Not configured");

    // Pause explains the effect on tasks; Resume restores Active.
    await command("Pause");
    const pause = modelDialog(page, "Pause", "gpt-4o");
    await expect(pause).toContainText("Running tasks keep this model");
    await expect(pause).toContainText(
      "New tasks of Flows with no other active model wait in Pending",
    );
    await pause
      .getByRole("button", { name: "Pause model", exact: true })
      .click();
    await expect(row).toContainText("Paused");
    await command("Resume");
    await modelDialog(page, "Resume", "gpt-4o")
      .getByRole("button", { name: "Resume model", exact: true })
      .click();
    await expect(row).toContainText("Active");
    const lifecycle = fake.writes
      .filter((w) => w.path === "/ui/v1/models/gpt-4o")
      .slice(2)
      .map((w) => w.body.paused);
    expect(lifecycle).toEqual([true, false]);
  });

  const m1 = `${acme}/m1`;
  const m2 = `${acme}/m2`;
  const ttA = "tt-a",
    ttB = "tt-b";
  const idA = 8028,
    idB = 8029;
  const dialog = flowEditor(page);
  const limits = (title: RegExp) =>
    dialog.locator("section:has(> .panel-head > h2)").filter({
      has: page.getByRole("heading", { name: title }),
    });
  const edit = async (row: Locator, name: string) => {
    await row
      .getByRole("button", { name: `Actions for ${name}`, exact: true })
      .click();
    await page
      .getByRole("menu", { name: `Actions for ${name}`, exact: true })
      .getByRole("menuitem", { name: "Edit flow", exact: true })
      .click();
  };

  await test.step("v0022.9 / web-ui: Flows edits ordered models and limits without flow state", async () => {
    for (const name of ["m0", "m1", "m2"])
      fake.models.set(name, {
        name,
        provider: "openai",
        provider_model: "x",
        api_base: null,
        paused: name === "m0",
        credential: false,
        pricing: {
          input_usd_per_million_tokens: "1",
          output_usd_per_million_tokens: "2",
        },
        revision: 1,
      });
    fake.addFlow(idA, ttA, [`${acme}/m0`]);
    fake.addFlow(idB, ttB, [`${acme}/m0`]);

    // Unconfigured flows: explained, with no state badge or filter.
    await page.goto(`${proxy.baseUrl}/?view=flows&team=${acme}`);
    const section = page.locator("#settings-section");
    const notices = page.locator("[data-flow-notices]");
    await expect(notices).toContainText("Model unavailable");
    await expect(notices).toContainText(
      "if none is active, they remain Pending",
    );
    const rowA = flowCard(page, ttA);
    const rowB = flowCard(page, ttB);
    for (const row of [rowA, rowB]) {
      await expect(row.locator(".flow-models a")).toHaveText(["m0"]);
      await expect(row.locator(".flow-models .badge")).toHaveText(["Paused"]);
      await expect(row.locator(".flow-models a[title]")).toHaveAttribute(
        "title",
        `${acme}/m0`,
      );
    }
    await expect(rowA.locator("dt")).toHaveText([
      "Flow",
      "Executor tag",
      "Models (in order)",
      "Per-task limit",
      "Flow limit",
      "Usage",
      "Sources",
    ]);
    await expect(
      section.locator(".badge:not(.flow-models .badge)"),
    ).toHaveCount(0);
    await expect(section.locator(".flow-models .badge")).toHaveCount(2);
    await expect(section.getByRole("combobox")).toHaveCount(1);
    await expect(
      section.getByRole("combobox", { name: "Rows per page" }),
    ).toHaveCount(1);

    // Edit tt-b: ordered models and both limits.
    await edit(rowB, ttB);
    const resetHelp = dialog.locator("[data-flow-reset-help]");
    await expect(resetHelp).toContainText("budget periods reset daily at");
    await expect(resetHelp).toContainText("weekly on");
    await expect(resetHelp).toContainText("monthly on");
    await expect(resetHelp).toContainText(
      "Tasks wait in Pending while no listed model is active",
    );
    await expect(dialog.getByLabel("Name")).toHaveValue(ttB);
    await expect(dialog.getByLabel("Executor tag")).toHaveValue("openhands");
    await dialog.getByLabel("Model", { exact: true }).nth(0).selectOption(m1);
    await dialog.getByRole("button", { name: "Add existing model" }).click();
    await dialog.getByLabel("Model", { exact: true }).nth(1).selectOption(m2);
    const perTask = limits(/^Per task/);
    await perTask.getByLabel("Budget (USD)").fill("1");
    await perTask.getByLabel("RPM").fill("10");
    const flow = limits(/all runs\)$/);
    await flow.getByLabel("Budget (USD)").fill("20");
    await flow.getByLabel("Period").selectOption("week");
    await flow.getByLabel("RPM").fill("100");
    await saveFlow(dialog).click();
    await expect(dialog).toHaveCount(0);
    const saved = fake.writes.filter((w) => w.path === `/ui/v1/flows/${idB}`);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      method: "PUT",
      ifMatch: '"2"',
      body: {
        name: ttB,
        execution_tag: "openhands",
        model_aliases: [m1, m2],
        per_task_limit: { max_budget_usd: "1.00", rpm: 10 },
        flow_limit: {
          max_budget_usd: "20.00",
          budget_period: "week",
          rpm: 100,
        },
      },
    });
    // No flow state reaches the write.
    expect(Object.keys(saved[0].body)).not.toContain("state");
    expect(Object.keys(saved[0].body)).not.toContain("status");
    await page.goto(`${proxy.baseUrl}/?view=flows&team=${acme}`);
    await expect(rowB.locator(".flow-models a")).toHaveText(["m1", "m2"]);
    await expect(rowB.locator(".flow-models .badge")).toHaveText([
      "Active",
      "Active",
    ]);
    expect(
      await rowB
        .locator(".flow-models a[title]")
        .evaluateAll((models) =>
          models.map((model) => model.getAttribute("title")),
        ),
    ).toEqual([m1, m2]);
    await expect(rowB).toContainText("1.00 USD · 10 RPM");
    await expect(rowB).toContainText("20.00 USD / week · 100 RPM");
    await expect(rowB).toContainText("0.00 / 20.00 USD");
    await expect(rowB).toContainText("Next reset:");
    const reset = await rowB
      .locator("[data-budget-reset]")
      .getAttribute("data-budget-reset");
    expect(Date.parse(reset ?? "")).toBe(nextMondayUTC());

    // A paused model is marked in the list.
    fake.models.get("m2")!.paused = true;
    await page.reload();
    await expect(flowCard(page, ttB).locator(".flow-models a")).toHaveText([
      "m1",
      "m2",
    ]);
    await expect(flowCard(page, ttB).locator(".flow-models .badge")).toHaveText(
      ["Active", "Paused"],
    );

    // A newer change is a conflict with Reload.
    await edit(flowCard(page, ttB), ttB);
    await expect(dialog.getByLabel("Model", { exact: true })).toHaveCount(2);
    Object.assign(fake.flows.get(idB), {
      model_aliases: [m1],
      per_task_limit: null,
      flow_limit: null,
      revision: fake.flows.get(idB).revision + 1,
    });
    await limits(/^Per task/)
      .getByLabel("RPM")
      .fill("11");
    await saveFlow(dialog).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Reload the current resource",
    );
    await dialog.getByRole("button", { name: "Reload" }).click();
    await expect(
      dialog.getByLabel("Model", { exact: true }).nth(1),
    ).toHaveCount(0);
    await expect(
      dialog.getByLabel("Model", { exact: true }).nth(0),
    ).toHaveValue(m1);
    await cancelFlow(dialog).click();

    // Prepare tt-b with a flow budget, then open tt-a for the outage save.
    Object.assign(fake.flows.get(idB), {
      flow_limit: { max_budget_usd: "20.00", budget_period: "week" },
      revision: fake.flows.get(idB).revision + 1,
    });
    await page.goto(`${proxy.baseUrl}/?view=flows&team=${acme}`);
    await edit(flowCard(page, ttA), ttA);
    await dialog.getByLabel("Model", { exact: true }).nth(0).selectOption(m1);
  });

  await test.step("v0022.8 + v0022.9 / web-ui: one LiteLLM outage", async () => {
    fake.state.outage = true;
    await saveFlow(dialog).click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Model gateway unavailable",
    );
    await expect(dialog.getByRole("alert")).toContainText(
      "The Flow remains unchanged",
    );
    await cancelFlow(dialog).click();
    await page.goto(`${proxy.baseUrl}/?view=flows&team=${acme}`);
    await expect(flowCard(page, ttB)).toContainText("Unknown");
    await expect(flowCard(page, ttA).locator(".flow-models a")).toHaveText([
      "m0",
    ]);
    await expect(flowCard(page, ttA).locator(".flow-models .badge")).toHaveText(
      ["Paused"],
    );
    await expect(
      flowCard(page, ttA).locator(".flow-models a[title]"),
    ).toHaveAttribute("title", `${acme}/m0`);
    expect(await page.content()).not.toMatch(PROVIDER_KEY);

    // Models: a temporary error without an in-place Retry command.
    await page.goto(
      `${proxy.baseUrl}/?view=settings&section=models&team=${acme}`,
    );
    const currentList = page.locator("#models-results");
    await expect(currentList.getByRole("alert")).toContainText(
      "temporarily unavailable",
    );
    await expect(
      currentList.getByRole("button", { name: "Retry" }),
    ).toHaveCount(0);
    fake.state.outage = false;
    await page.reload();
    await expect(
      page
        .locator("#models-results tr:visible,#models-results article:visible")
        .filter({
          has: page.getByRole("link", { name: "gpt-4o", exact: true }),
        }),
    ).toBeVisible();
  });

  await test.step("v0022.8 / web-ui: another team sees none of acme's models", async () => {
    await page.locator("#team-selector").selectOption("2");
    await page.goto(`${proxy.baseUrl}/?view=settings&section=models&team=2`);
    await expect(page.getByText("No current models.")).toBeVisible();
  });

  expect(await page.content()).not.toMatch(PROVIDER_KEY);
  expect(await page.content()).not.toContain(CANARY);
  expect(browserRequests.length).toBeGreaterThan(0);
  for (const url of browserRequests)
    expect(url.startsWith(proxy.baseUrl), url).toBe(true);
});
