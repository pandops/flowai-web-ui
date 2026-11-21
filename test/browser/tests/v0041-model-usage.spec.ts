import path from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivor of task-sources-interface model-usage.browser.spec.ts (v0041 D15). The real State
// Registry is replaced by Gateway-shaped /ui/v1 responses.

const team = 1;
const sourceID = 8013;
const flowID = 8009;

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: team, team_name: "intake" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

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

test("v0013.3 / Models links include every Flow including secondary model references", async ({
  page,
}) => {
  const multiID = 8027;
  await mockCatalog(page, {
    sources: [sourceRecord(sourceID, "event-source")],
    models: [modelRecord("model"), modelRecord("other"), modelRecord("unused")],
    flows: [
      flowRecord(),
      {
        ...flowRecord(),
        flow_id: multiID,
        name: "Multi-model Flow",
        // The model is this Flow's secondary (fallback) reference.
        model_aliases: [`${team}/other`, `${team}/model`],
        source_revisions: { [sourceID]: 3 },
      },
    ],
  });
  await page.goto(
    `${proxy.baseUrl}/?view=settings&section=models&team=${team}`,
  );
  // Rows fall back to stacked records when fields do not fit.
  const row = page
    .locator("#models-results tbody tr, #models-results article")
    .filter({ has: page.getByText(`${team}/model`, { exact: true }) });
  await expect(
    row.getByRole("link", { name: "Flow one", exact: true }),
  ).toBeVisible();
  await expect(
    row.getByRole("link", { name: "Multi-model Flow", exact: true }),
  ).toHaveAttribute(
    "href",
    // Usage links open the read-only Flow page.
    new RegExp(`view=flow&.*id=${multiID}`),
  );
  // An unused model shows the explicit unused state and no Flow link.
  const unused = page
    .locator(
      "#models-results tbody tr:visible, #models-results article:visible",
    )
    .filter({ has: page.getByText(`${team}/unused`, { exact: true }) });
  await expect(unused).toContainText(/Not used by a flow/i);
  await expect(unused.getByRole("link", { name: /Flow/ })).toHaveCount(0);
});
