import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import {
  cancelFlow,
  createFlowEntry,
  flowEditor,
  saveFlow,
} from "../fixtures/flow-editor";

// Survivor of llm-proxying v0022.15-flow-creation.ui.spec.ts (v0041 D15).
// A stateful mocked /ui/v1 catalog answers per working token (one team per
// token) with the State Registry's flow, model and execution-tag shapes and
// its rejection bodies (400 paused-only, 409 flow_name_conflict).

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

type Team = "3" | "2";
const model = (team: string, name: string, paused: boolean) => ({
  name,
  model_alias: `${team}/${name}`,
  provider: "openai",
  provider_model: "x",
  api_base: null,
  credential_configured: false,
  created_by: "team",
  model_id: 6000 + name.length * 1000 + name.charCodeAt(name.length - 1),
  created_at: "2026-10-18T00:00:00Z",
  updated_at: "2026-10-18T00:00:00Z",
  unfinished_task_count: 0,
  paused,
  archived_at: null,
  editable: true,
  can_archive: true,
  can_unarchive: false,
  archive_blocking_flows: [],
  pricing_status: "configured",
  pricing: {
    input_usd_per_million_tokens: "1",
    output_usd_per_million_tokens: "2",
  },
});

async function registry(page: Page) {
  const state = {
    tags: { "3": [], "2": [] } as Record<Team, string[]>,
    models: { "3": [], "2": [] } as Record<Team, ReturnType<typeof model>[]>,
    flows: { "3": [], "2": [] } as Record<Team, any[]>,
  };
  const writes: { method: string; body: any }[] = [];
  const teamOf = (route: import("@playwright/test").Route) =>
    route
      .request()
      .headers()
      .authorization?.replace(/^Bearer working-/, "") as Team;
  const page_ = (items: unknown[]) => ({
    json: { items, next_cursor: null },
  });
  await page.route("**/ui/v1/execution-tags**", (route) =>
    route.fulfill(page_(state.tags[teamOf(route)] ?? [])),
  );
  await page.route("**/ui/v1/models?**", (route) =>
    route.fulfill(
      page_(
        new URL(route.request().url()).searchParams.get("archived") === "true"
          ? []
          : (state.models[teamOf(route)] ?? []),
      ),
    ),
  );
  await page.route("**/ui/v1/sources**", (route) => route.fulfill(page_([])));
  await page.route("**/ui/v1/flow-llm-settings**", (route) => {
    const team = teamOf(route);
    return route.fulfill(
      page_(
        (state.flows[team] ?? []).map((flow) => ({
          ...flow,
          models: flow.model_aliases.map((alias: string) => ({
            model_alias: alias,
            availability: state.models[team].find(
              (m) => m.model_alias === alias,
            )?.paused
              ? "paused"
              : "active",
          })),
          usage: null,
        })),
      ),
    );
  });
  await page.route(/\/ui\/v1\/flows(?:\?.*)?$/, (route) => {
    const team = teamOf(route);
    const request = route.request();
    if (request.method() === "GET")
      return route.fulfill(page_(state.flows[team] ?? []));
    const body = request.postDataJSON();
    writes.push({ method: request.method(), body });
    const selected = state.models[team].filter((m) =>
      body.model_aliases.includes(m.model_alias),
    );
    if (!selected.some((m) => !m.paused))
      return route.fulfill({
        status: 400,
        json: {
          code: "invalid_request",
          message: "at least one selected model must be active",
          request_id: 7014,
        },
      });
    if (
      state.flows[team].some(
        (flow) => flow.name.toLowerCase() === body.name.toLowerCase(),
      )
    )
      return route.fulfill({
        status: 409,
        json: {
          code: "flow_name_conflict",
          message: "the team already has a flow with this name",
          request_id: 7015,
        },
      });
    const flow = {
      ...body,
      flow_id: 8015,
      revision: 1,
      created_at: "2026-10-18T00:00:00Z",
      updated_at: "2026-10-18T00:00:00Z",
    };
    state.flows[team].push(flow);
    return route.fulfill({
      status: 201,
      json: flow,
      headers: { etag: '"1"' },
    });
  });
  await page.route(/\/ui\/v1\/flows\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const flow = (state.flows[teamOf(route)] ?? []).find(
      (f) => String(f.flow_id) === id,
    );
    return flow
      ? route.fulfill({ json: flow, headers: { etag: '"1"' } })
      : route.fulfill({
          status: 404,
          json: { code: "not_found", message: "flow not found" },
        });
  });
  return { state, writes };
}

test("v0022.15 / web-ui: standalone Flows creates a flow only with a chosen tag and model", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { state, writes } = await registry(page);
  const browserRequests: string[] = [];
  page.on("request", (request) => browserRequests.push(request.url()));
  const flowsURL = `${proxy.baseUrl}/?view=flows&team=3`;

  // 1. Nothing to choose yet: the form says what to register or create.
  await page.goto(flowsURL);
  await expect(
    page.getByRole("heading", { name: "Flows", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("No records available.")).toBeVisible();
  await expect(
    page.getByText(
      "Models are shown in selection order. Usage is Unknown when the gateway does not answer.",
      { exact: true },
    ),
  ).toBeHidden();
  await createFlowEntry(page).click();
  let dialog = flowEditor(page);
  await expect(dialog).toContainText("No Executor serves this team yet");
  await expect(dialog).toContainText("No active model");
  await expect(
    dialog.getByRole("link", { name: "Manage models", exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("Each task keeps its own lifecycle");
  const refusedSave = async (invalid: string[]) => {
    await saveFlow(dialog).click();
    await expect(dialog.getByRole("alert")).toContainText("Validation needed");
    for (const label of invalid)
      await expect(
        dialog.getByLabel(label, { exact: true }).first(),
      ).toHaveAttribute("aria-invalid", "true");
    await expect(dialog).toBeVisible();
    expect(writes).toEqual([]);
    expect(state.flows["3"]).toEqual([]);
  };
  await refusedSave(["Name", "Executor tag"]);
  await cancelFlow(dialog).click();

  // 2. With an eligible tag and models, nothing is preselected and saving is
  //    refused until every required choice is made.
  state.models["3"].push(model("3", "m1", false), model("3", "m2", true));
  state.tags["3"].push("openhands");
  state.tags["2"].push("beta-private");
  await page.goto(flowsURL);
  await createFlowEntry(page).click();
  dialog = flowEditor(page);
  const tag = dialog.getByLabel("Executor tag");
  const modelSelect = dialog.getByLabel("Model", { exact: true }).nth(0);
  await expect(tag).toHaveValue("");
  await expect(modelSelect).toHaveValue("");
  await expect(tag.locator("option")).toHaveText([
    "Select executor tag",
    "openhands",
  ]);
  await expect(modelSelect.locator("option")).toHaveText([
    "Select model",
    "m1 · active",
    "m2 · paused",
  ]);
  expect(
    await modelSelect
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["", "3/m1", "3/m2"]);
  await expect(dialog).toContainText(
    "Every eligible Executor with this tag may claim a task. Exactly one wins each claim.",
  );
  await expect(dialog).toContainText("first active model");
  await expect(dialog).toContainText(
    "Tasks wait in Pending while no listed model is active",
  );
  const save = saveFlow(dialog);
  await refusedSave(["Name", "Executor tag"]);
  await dialog.getByLabel("Name").fill("Code review");
  await dialog
    .getByLabel("Prompt template", { exact: true })
    .fill("Work {{external_id}}");
  await refusedSave(["Executor tag"]);
  await tag.selectOption("openhands");
  await refusedSave([]);
  await expect(dialog).toContainText(
    "Choose one to five models before saving.",
  );

  // A paused-only choice is refused by State Registry; nothing is created.
  await modelSelect.selectOption("3/m2");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog.getByRole("alert")).toContainText("active");
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    method: "POST",
    body: {
      name: "Code review",
      execution_tag: "openhands",
      model_aliases: ["3/m2"],
      prompt_template: "Work {{external_id}}",
    },
  });
  expect(state.flows["3"]).toEqual([]);

  // 3. A complete form creates the flow, listed with tag and model and no
  //    state or status.
  await modelSelect.selectOption("3/m1");
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({
    method: "POST",
    body: {
      name: "Code review",
      execution_tag: "openhands",
      model_aliases: ["3/m1"],
    },
  });
  await page.goto(flowsURL);
  await expect(
    page.getByText(
      "Models are shown in selection order. Usage is Unknown when the gateway does not answer.",
      { exact: true },
    ),
  ).toBeVisible();
  const row = page.locator("#flows-results dl.data-card").filter({
    has: page.getByRole("link", { name: "Code review", exact: true }),
  });
  await expect(row).toContainText("openhands");
  await expect(row.locator(".flow-models a")).toHaveText(["m1"]);
  await expect(row.locator(".flow-models .badge")).toHaveText(["Active"]);
  await expect(row.locator(".flow-models a[title]")).toHaveAttribute(
    "title",
    "3/m1",
  );
  await expect(
    page.locator("#settings-section .badge:not(.flow-models .badge)"),
  ).toHaveCount(0);
  await expect(page.locator("#settings-section")).not.toContainText(
    /\bstatus\b/i,
  );

  // A duplicate name is a conflict shown in the form.
  await createFlowEntry(page).click();
  dialog = flowEditor(page);
  await dialog.getByLabel("Name").fill("code REVIEW");
  await dialog
    .getByLabel("Prompt template", { exact: true })
    .fill("Work {{external_id}}");
  await dialog.getByLabel("Executor tag").selectOption("openhands");
  await dialog.getByLabel("Model", { exact: true }).nth(0).selectOption("3/m1");
  await saveFlow(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText("already has a Flow");
  expect(state.flows["3"]).toHaveLength(1);
  await cancelFlow(dialog).click();

  // Another team sees neither the flow nor acme's tag.
  await page.goto(`${proxy.baseUrl}/?view=flows&team=2`);
  await expect(page.getByText("No records available.")).toBeVisible();
  await createFlowEntry(page).click();
  await expect(
    flowEditor(page).getByLabel("Executor tag").locator("option"),
  ).toHaveText(["Select executor tag", "beta-private"]);

  // The browser talked only to the Gateway origin.
  expect(browserRequests.length).toBeGreaterThan(0);
  for (const url of browserRequests)
    expect(url.startsWith(proxy.baseUrl), url).toBe(true);
});

// v0041 D20: the form takes the image override as a pinned
// repository@sha256:<digest> reference; the Flow API takes and returns
// { repository, digest }. Each step has its own page and mocked catalog.
test("v0041 / web-ui: Flow image override is optional, sent pinned and shown pinned", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const failures: unknown[] = [];
  const steps: [string, (page: Page) => Promise<void>][] = [
    [
      "v0041 / web-ui: a Flow without an image override sends none",
      async (page) => {
        const { state, writes } = await registry(page);
        state.models["3"].push(model("3", "m1", false));
        state.tags["3"].push("openhands");
        await page.goto(`${proxy.baseUrl}/?view=flows&team=3`);
        await createFlowEntry(page).click();
        const dialog = flowEditor(page);
        await dialog.getByLabel("Name").fill("Team image");
        await dialog
          .getByLabel("Prompt template", { exact: true })
          .fill("Work {{external_id}}");
        await dialog.getByLabel("Executor tag").selectOption("openhands");
        await dialog
          .getByLabel("Model", { exact: true })
          .nth(0)
          .selectOption("3/m1");
        await saveFlow(dialog).click();
        await expect(dialog).toHaveCount(0);
        expect(writes).toHaveLength(1);
        expect(writes[0].body.default_image).toBeNull();
      },
    ],
    [
      "v0041 / web-ui: Flow image override is sent and shown as a pinned reference",
      async (page) => {
        const { state, writes } = await registry(page);
        state.models["3"].push(model("3", "m1", false));
        state.tags["3"].push("openhands");
        const digest = `sha256:${"ab".repeat(32)}`;
        const repository = "registry.example/flowai/runtime";

        await page.goto(`${proxy.baseUrl}/?view=flows&team=3`);
        await createFlowEntry(page).click();
        const dialog = flowEditor(page);
        await dialog.getByLabel("Name").fill("Pinned image");
        await dialog
          .getByLabel("Prompt template", { exact: true })
          .fill("Work {{external_id}}");
        await dialog.getByLabel("Executor tag").selectOption("openhands");
        await dialog
          .getByLabel("Model", { exact: true })
          .nth(0)
          .selectOption("3/m1");
        const image = dialog.getByLabel("Flow image override (optional)");

        // An unpinned reference is refused in the form; nothing is written.
        await image.fill(`${repository}:v1`);
        await saveFlow(dialog).click();
        await expect(dialog).toContainText(
          "Enter the Flow image override as repository@sha256:<digest>.",
        );
        expect(writes).toEqual([]);

        await image.fill(`  ${repository}@${digest}  `);
        await saveFlow(dialog).click();
        await expect(dialog).toHaveCount(0);
        expect(writes).toHaveLength(1);
        expect(writes[0].body.default_image).toEqual({ repository, digest });

        // Editing shows the stored object as the same pinned reference.
        await page.goto(`${proxy.baseUrl}/?view=flows&team=3`);
        await page
          .getByRole("link", { name: "Pinned image", exact: true })
          .click();
        await page
          .getByRole("link", { name: "Edit flow", exact: true })
          .click();
        await expect(
          flowEditor(page).getByLabel("Flow image override (optional)"),
        ).toHaveValue(`${repository}@${digest}`);
      },
    ],
  ];
  for (const [title, run] of steps) {
    const page = await context.newPage();
    try {
      await test.step(title, () => run(page));
    } catch (error) {
      failures.push(error);
    }
    try {
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
});
