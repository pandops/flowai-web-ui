import type { Page } from "@playwright/test";

export const flowID = 44;
export const aliases = ["first", "second", "third", "fourth", "fifth"].map(
  (name) => `1/${name}`,
);

export const secondFlowID = 55;

export async function flowFixture(page: Page, includeSecond = false) {
  let flow = {
    flow_id: flowID,
    name: "Order flow",
    revision: 1,
    execution_tag: "openhands",
    model_aliases: aliases.slice(0, 3),
    prompt_template: "Work {{external_id}}",
    execution_parameters: {},
    default_image: null,
    source_ids: [] as number[],
    source_revisions: {},
    per_task_limit: null,
    flow_limit: null,
    failure_retry_count: 3,
    failure_retry_wait_seconds: 60,
    pending_limit_seconds: 900,
    release_delay_seconds: 300,
    execution_revision: 1,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
  const flows = new Map<number, typeof flow>([[flowID, flow]]);
  if (includeSecond)
    flows.set(secondFlowID, {
      ...flow,
      flow_id: secondFlowID,
      name: "Other flow",
      model_aliases: [aliases[2]],
    });
  const models = aliases.map((model_alias, index) => ({
    name: model_alias.split("/")[1],
    model_alias,
    paused: index === 1,
    archived_at: null,
    provider: "openai",
    provider_model: "fixture",
    editable: true,
    credential_configured: false,
  }));
  const writes: { path: string; body: any; etag?: string }[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/ui/v1/")
    )
      writes.push({
        path: new URL(request.url()).pathname,
        body: request.postData() ? request.postDataJSON() : null,
        etag: request.headers()["if-match"],
      });
  });
  await page.route("**/ui/v1/flows?**", (route) =>
    route.fulfill({ json: { items: [...flows.values()], next_cursor: null } }),
  );
  // flow-registry flow-create: generated integer flow_id, defaults applied.
  let nextFlowID = 60;
  await page.route(/\/ui\/v1\/flows$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const created = {
      ...flow,
      failure_retry_count: 3,
      failure_retry_wait_seconds: 60,
      pending_limit_seconds: 900,
      release_delay_seconds: 300,
      source_ids: [],
      ...route.request().postDataJSON(),
      flow_id: nextFlowID++,
      revision: 1,
    };
    delete created.source_revisions;
    flows.set(created.flow_id, created);
    return route.fulfill({
      status: 201,
      json: created,
      headers: { etag: `"1"` },
    });
  });
  await page.route(/\/ui\/v1\/flows\/[1-9][0-9]*$/, (route) => {
    const id = Number(
      new URL(route.request().url()).pathname.split("/").at(-1),
    );
    let current = flows.get(id)!;
    if (!current)
      return route.fulfill({ status: 404, json: { code: "not_found" } });
    if (route.request().method() === "PUT") {
      current = {
        ...current,
        ...route.request().postDataJSON(),
        revision: current.revision + 1,
      };
      flows.set(id, current);
    }
    return route.fulfill({
      json: current,
      headers: { etag: `"${current.revision}"` },
    });
  });
  await page.route("**/ui/v1/flow-llm-settings**", (route) => {
    const settings = [...flows.values()].map((current) => ({
      ...current,
      models: current.model_aliases.map((model_alias) => ({
        model_alias,
        availability: model_alias === aliases[1] ? "paused" : "active",
      })),
    }));
    const id = Number(
      new URL(route.request().url()).pathname.split("/").at(-1),
    );
    return route.fulfill({
      json: flows.has(id)
        ? settings.find((current) => current.flow_id === id)
        : { items: settings, next_cursor: null },
    });
  });
  await page.route("**/ui/v1/models?**", (route) =>
    route.fulfill({ json: { items: models, next_cursor: null } }),
  );
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  await page.route("**/ui/v1/execution-tags?**", (route) =>
    route.fulfill({ json: { items: ["openhands"], next_cursor: null } }),
  );
  await page.route("**/ui/v1/teams/1/tasks?**", (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  return { writes, flows };
}
