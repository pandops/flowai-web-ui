import path from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { createFlowEntry, flowEditor, saveFlow } from "../fixtures/flow-editor";
import { startMockedProxy } from "../fixtures/mocked_proxy";

// Survivors of task-sources-interface flow-editor.browser.spec.ts and
// foreign-flow.browser.spec.ts (v0041 D15). The real State
// Registry is replaced by Gateway-shaped /ui/v1 responses.

const team = 1;
const sourceID = 8013;
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

test("v0013.3 / Flow form owns prompt, models and bindings; unavailable Flow cannot fall back to creation", async ({
  context,
}) => {
  test.setTimeout(240_000);
  const proxy = await startMockedProxy(
    [{ team_id: team, team_name: "intake" }],
    path.resolve(__dirname, "../../../web/index.html"),
  );
  // Each step has its own page and mocked catalog; a failing step does not
  // hide the other.
  const failures: unknown[] = [];
  const steps: [string, (page: Page) => Promise<void>][] = [
    [
      "v0013.3 / unavailable Flow cannot fall back to creation",
      async (page) => {
        const writes = await mockCatalog(page, {
          sources: [sourceRecord(sourceID, "event-source")],
          models: [modelRecord("model")],
          flows: [flowRecord()],
        });
        // Both the read-only Flow view and the editor route stay unavailable for
        // an identifier the Registry answers 404 (unknown or foreign).
        for (const view of ["flow", "flows"]) {
          await page.goto(
            `${proxy.baseUrl}/?view=${view}&id=8015&team=${team}`,
          );
          const main = page.locator("main");
          await expect(main).toContainText(/no longer available|unavailable/i);
          // The standalone editor page keeps its (empty) form element parked
          // hidden while it shows the unavailable state; no form is exposed.
          await expect(main.getByLabel("Prompt template")).toBeHidden();
          await expect(
            main.getByRole("button", {
              name: /^(Save flow|Save|Create flow)$/,
            }),
          ).toHaveCount(0);
          await expect(page.getByRole("dialog", { name: /flow/i })).toHaveCount(
            0,
          );
        }
        expect(writes).toEqual([]);
      },
    ],
    [
      "v0013.3 / one Flow form owns prompt, models and Source bindings",
      async (page) => {
        const catalog: Catalog = {
          sources: [sourceRecord(sourceID, "event-source")],
          models: [modelRecord("model")],
          flows: [flowRecord()],
        };
        const writes = await mockCatalog(page, catalog);
        await page.goto(`${proxy.baseUrl}/?view=flows&team=${team}`);
        // v0034 opens Create flow as the standalone Flow editor page.
        await createFlowEntry(page).click();
        const editor = flowEditor(page);
        await expect(
          editor.getByLabel("Prompt template", { exact: true }),
        ).toBeVisible();
        await editor.getByLabel("Name", { exact: true }).fill("Browser Flow");
        await editor
          .getByLabel("Executor tag", { exact: true })
          .selectOption("openhands");
        await editor
          .getByLabel("Model", { exact: true })
          .nth(0)
          .selectOption(`${team}/model`);
        await editor
          .getByLabel("Prompt template", { exact: true })
          .fill("Browser {{external_id}}");
        await editor.getByLabel("event-source", { exact: true }).check();
        // Flow forms bind Sources but never edit their shared configuration.
        await expect(editor.getByLabel(/ override$/)).toHaveCount(0);
        await saveFlow(editor).click();
        await expect(editor).toHaveCount(0);
        // One Flow write owns prompt, models and bindings; no Source write.
        expect(writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
          "POST /ui/v1/flows",
        ]);
        expect(JSON.parse(writes[0].body!)).toMatchObject({
          name: "Browser Flow",
          execution_tag: "openhands",
          model_aliases: [`${team}/model`],
          prompt_template: "Browser {{external_id}}",
          execution_parameters: {},
          source_ids: [sourceID],
          source_revisions: { [sourceID]: 2 },
        });
      },
    ],
  ];
  try {
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
  } finally {
    await proxy.close();
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, `${failures.length} steps failed`);
});
