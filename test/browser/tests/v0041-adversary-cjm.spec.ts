import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import {
  openSourceCommand,
  sourceActionsTrigger,
  sourceDialog,
  type SourceCommand,
} from "../fixtures/approved-dialogs";
import {
  createSourceEntry,
  sourceKeyPage,
  sourceWizard,
} from "../fixtures/source-wizard";
import { createFlowEntry, flowEditor, saveFlow } from "../fixtures/flow-editor";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivor of task-sources-interface adversary-cjm.browser.spec.ts (v0041
// D15). The State Registry behind the Gateway is replaced by a stateful
// in-page model of the public /ui/v1 responses; every write the UI sends is
// recorded and checked instead of being read back from the Registry. The
// screenshot/mockup capture of the original carried no oracle and is dropped.
test.use({ actionTimeout: 10_000 });

const alpha = 1,
  beta = 2;
const S1 = 8001,
  S2 = 8002,
  F1 = 8003,
  T1 = 8004,
  E1 = 8005;

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [
        { team_id: alpha, team_name: "intake" },
        { team_id: beta, team_name: "beta" },
      ],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

type Write = { method: string; path: string; etag?: string; body: any };

const stats = (accepted = 0) => ({
  published: accepted,
  rejected: 0,
  accepted,
  deduplicated: 0,
  no_target: 0,
  failed: 0,
});

function sourceRecord(id: number, name: string, mode: string, extra = {}) {
  return {
    source_id: id,
    team_id: alpha,
    name,
    revision: 2,
    mode,
    enabled: true,
    contract_version: "source.v1",
    implementation_version: "1",
    description: "",
    filter_summary: mode === "poller" ? "Poll test" : "",
    settings_status: "complete",
    health: "healthy",
    last_seen_at: null,
    polling:
      mode === "poller"
        ? {
            polling_blocked_at: null,
            consecutive_failures: 0,
            next_poll_at: null,
          }
        : null,
    last_poll: null,
    webhook_url:
      mode === "webhook"
        ? `https://receiver.example/webhook/1/${name}/task`
        : null,
    intake_counts: stats(),
    ...extra,
  };
}

function flowRecord(id: number, name: string, sourceIDs: number[]) {
  return {
    flow_id: id,
    name,
    revision: 1,
    execution_tag: "openhands",
    model_aliases: [`${alpha}/model`],
    prompt_template: "Work {{external_id}}",
    execution_parameters: {},
    default_image: null,
    source_ids: sourceIDs,
    source_revisions: Object.fromEntries(sourceIDs.map((id) => [id, 2])),
    per_task_limit: null,
    flow_limit: null,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
}

// The Alpha team's Sources, Flows, task and Executor, served per working
// token like API Gateway's one-team context; Beta owns nothing.
async function cjmWorld(page: Page) {
  const sources = new Map<number, any>([
    [S1, sourceRecord(S1, "event-source", "webhook")],
    [
      S2,
      sourceRecord(S2, "poller-source", "poller", {
        settings_status: "awaiting_schema",
      }),
    ],
  ]);
  const fields = new Map<number, any[]>([
    [
      S1,
      [
        {
          name: "note",
          label: "Note",
          type: "string",
          required: false,
          default: null,
          value: null,
        },
        {
          name: "flag",
          label: "Flag",
          type: "boolean",
          required: false,
          default: false,
          value: null,
        },
      ],
    ],
    [S2, []],
  ]);
  const flows = new Map<number, any>([[F1, flowRecord(F1, "Flow one", [S1])]]);
  const task = {
    task_id: T1,
    task_name: `intake-${T1}`,
    source_id: S1,
    flow_id: F1,
    external_id: "canonical-cjm-task",
    current_state: "queued",
    attempt: 1,
    claim_seq: 0,
    executor_id: null,
    ingested_at: new Date().toISOString(),
    claimed_at: null,
    completed_at: null,
  };
  // executor-registry record; its journal state is served by executor-states.
  const executor = {
    executor_id: E1,
    team_id: alpha,
    execution_tag: "openhands",
    executor_type: "executor_docker_openhands",
    created_at: new Date().toISOString(),
    token_fingerprint: "ab".repeat(32),
    token_issued_at: new Date().toISOString(),
    reported_ip: null,
    ip_reported_at: null,
  };
  const executorState = {
    executor_id: E1,
    connection_state: "connected",
    connection_changed_at: new Date().toISOString(),
    held_claims: 0,
    max_parallel_tasks: 2,
    available_capacity: 2,
    reported_ip: null,
    ip_changed_at: null,
  };
  const model = {
    name: "model",
    model_alias: `${alpha}/model`,
    paused: false,
    archived_at: null,
    provider: "openai",
    provider_model: "x",
    editable: true,
    credential_configured: false,
  };
  const writes: Write[] = [],
    failedResponses: string[] = [];
  page.on("request", (request) => {
    const p = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method()) && p.startsWith("/ui/"))
      writes.push({
        method: request.method(),
        path: p,
        etag: request.headers()["if-match"],
        body: request.postData() ? request.postDataJSON() : null,
      });
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      failedResponses.push(`${response.status()} ${response.url()}`);
  });
  // Flow bindings are Flow-owned (v0048): the Source view carries none.
  const sourceView = (source: any) => ({ ...source });
  const settingsView = (source: any) => ({
    source_id: source.source_id,
    mode: source.mode,
    revision: source.revision,
    settings_status: source.settings_status,
    fields: fields.get(source.source_id) ?? [],
    platform: {
      poll_url: null,
      poll_interval_minutes: null,
      webhook_url: source.webhook_url,
    },
  });
  const llm = (flow: any) => ({
    ...flow,
    models: flow.model_aliases.map((model_alias: string) => ({
      model_alias,
      availability: "active",
    })),
  });
  const list = (items: unknown[]) => ({ json: { items, next_cursor: null } });
  const notFound = {
    status: 404,
    json: { code: "not_found", message: "resource not found" },
  };
  let created = 0;
  await page.route("**/ui/v1/**", async (route) => {
    const request = route.request(),
      method = request.method(),
      url = new URL(request.url()),
      p = url.pathname,
      team = request.headers().authorization?.replace(/^Bearer working-/, "");
    // Dashboard, launch parameters and operator settings come from the proxy.
    if (
      /^\/ui\/v1\/teams\/[^/]+\/(?:dashboard|launch-parameters)/.test(p) ||
      p.startsWith("/ui/v1/operator/")
    )
      return route.fallback();
    if (team !== String(alpha)) {
      if (method === "GET" && !/\/[0-9a-f-]{36}(?:\/|$)/.test(p))
        return route.fulfill(
          list(p === "/ui/v1/execution-tags" ? ["openhands"] : []),
        );
      return route.fulfill(notFound);
    }
    let m: RegExpMatchArray | null;
    if (p === "/ui/v1/sources" && method === "GET")
      return route.fulfill(list([...sources.values()].map(sourceView)));
    if (p === "/ui/v1/sources" && method === "POST") {
      const body = request.postDataJSON();
      const id = 9100 + ++created;
      const source = sourceRecord(id, body.name, body.mode, {
        revision: 1,
        settings_status: "awaiting_schema",
        implementation_version: body.implementation_version,
      });
      sources.set(id, source);
      return route.fulfill({
        status: 201,
        json: { source, api_key: `tsk_v1_synthetic-created-${created}` },
      });
    }
    if ((m = p.match(/^\/ui\/v1\/sources\/([^/]+)(\/settings)?$/))) {
      const source = sources.get(Number(m[1]));
      if (!source) return route.fulfill(notFound);
      if (!m[2] && method === "GET")
        return route.fulfill({
          json: sourceView(source),
          headers: { etag: `"rev-${source.revision}"` },
        });
      if (m[2] && method === "GET")
        return route.fulfill({
          json: settingsView(source),
          headers: { etag: `"rev-${source.revision}"` },
        });
      if (m[2] && method === "PUT") {
        const body = request.postDataJSON();
        source.revision++;
        fields.set(
          source.source_id,
          (fields.get(source.source_id) ?? []).map((field) =>
            Object.hasOwn(body.values ?? {}, field.name)
              ? { ...field, value: body.values[field.name] }
              : field,
          ),
        );
        return route.fulfill({
          json: settingsView(source),
          headers: { etag: `"rev-${source.revision}"` },
        });
      }
    }
    if (p === "/ui/v1/flows" && method === "GET")
      return route.fulfill(list([...flows.values()]));
    if (p === "/ui/v1/flows" && method === "POST") {
      const body = request.postDataJSON();
      const id = 9200 + ++created;
      const flow = { ...flowRecord(id, body.name, []), ...body, flow_id: id };
      flows.set(id, flow);
      return route.fulfill({
        status: 201,
        json: flow,
        headers: { etag: '"1"' },
      });
    }
    if ((m = p.match(/^\/ui\/v1\/flows\/([^/]+)$/)) && m[1] !== "preview") {
      let flow = flows.get(Number(m[1]));
      if (!flow) return route.fulfill(notFound);
      if (method === "PUT") {
        flow = {
          ...flow,
          ...request.postDataJSON(),
          revision: flow.revision + 1,
        };
        flows.set(flow.flow_id, flow);
      }
      return route.fulfill({
        json: flow,
        headers: { etag: `"${flow.revision}"` },
      });
    }
    if (p === "/ui/v1/flow-llm-settings")
      return route.fulfill(list([...flows.values()].map(llm)));
    if ((m = p.match(/^\/ui\/v1\/flow-llm-settings\/([^/]+)$/)))
      return flows.has(Number(m[1]))
        ? route.fulfill({ json: llm(flows.get(Number(m[1]))) })
        : route.fulfill(notFound);
    if (p === "/ui/v1/models") return route.fulfill(list([model]));
    if (p === "/ui/v1/execution-tags")
      return route.fulfill(list(["openhands"]));
    const base = `/ui/v1/teams/${alpha}`;
    if (p === `${base}/tasks`) return route.fulfill(list([task]));
    if (p === `${base}/tasks/${T1}`) return route.fulfill({ json: task });
    if (p === `${base}/tasks/${T1}/events` || p === `${base}/tasks/${T1}/logs`)
      return route.fulfill(list([]));
    if (p === `${base}/tasks/${T1}/attempts`)
      return route.fulfill({ json: { task_id: T1, items: [] } });
    if (p === `${base}/tasks/${T1}/launch-parameters`)
      return route.fulfill({
        json: { task_id: T1, attempt: null, environment: {}, secret_keys: [] },
      });
    if (p === `${base}/executor-states`)
      return route.fulfill({ json: { items: [executorState] } });
    if (p === `${base}/executors`)
      return route.fulfill({
        json: { items: [executor], next_cursor: null, total_count: 1 },
      });
    if (p === `${base}/executors/${E1}`)
      return route.fulfill({ json: executor });
    if (
      p === `${base}/executors/${E1}/events` ||
      p === `${base}/executors/${E1}/tasks`
    )
      return route.fulfill(list([]));
    return route.fallback();
  });
  return { sources, flows, fields, writes, failedResponses };
}

const views = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "mobile", width: 390, height: 844 },
];
for (const viewport of views) {
  test(`adversary CJM / semantic screens, canonical links and hierarchy at ${viewport.name} · Web UI unit`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const world = await cjmWorld(page);
    const pageErrors: string[] = [],
      consoleErrors: string[] = [],
      origins: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("request", (request) =>
      origins.push(new URL(request.url()).origin),
    );
    const layout = async (name: string) => {
      const observed = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      }));
      expect
        .soft(
          observed.documentWidth <= observed.viewportWidth + 1,
          `${name}: horizontal document overflow at ${viewport.width}px`,
        )
        .toBe(true);
      expect.soft(pageErrors, `${name}: uncaught page errors`).toEqual([]);
    };
    const nav = async () => {
      const menu = page.getByRole("button", {
        name: /^(Open|Close) navigation$/,
      });
      if (viewport.name === "mobile") {
        await expect(menu).toBeVisible();
        await expect(menu).toHaveAttribute("aria-expanded", "false");
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect(menu).toHaveAttribute("aria-expanded", "true");
      }
      const labels = ["Overview", "Flows", "Tasks", "Sources", "Settings"];
      await expect
        .soft(page.locator(".nav-links [data-view]"))
        .toHaveText(labels, { useInnerText: true });
      for (const [index, element] of (
        await page.locator(".nav-links [data-view]").all()
      ).entries()) {
        await expect(element).toBeVisible();
        await expect.soft(element).toHaveAccessibleName(labels[index]);
        await expect(element.locator("svg.nav-icon")).toBeVisible();
        const box = await element.boundingBox();
        expect
          .soft(box?.height, "navigation touch height")
          .toBeGreaterThanOrEqual(44);
      }
      if (viewport.name === "mobile") {
        await page.keyboard.press("Escape");
        await expect(menu).toBeFocused();
        await expect(menu).toHaveAttribute("aria-expanded", "false");
      }
    };
    const go = async (view: string, id?: string | number) => {
      await page.goto(
        `${proxy.baseUrl}/?${new URLSearchParams({ view, team: String(alpha), ...(id ? { id: String(id) } : {}) })}`,
      );
      await expect(page.locator("#team-selector")).toHaveValue(String(alpha));
      if (view === "flows" && id) {
        await expect(flowEditor(page)).toBeVisible();
        if (viewport.name === "mobile")
          await expect(
            page.getByRole("button", { name: /^(Open|Close) navigation$/ }),
          ).toHaveAttribute("aria-expanded", "false");
      } else await nav();
    };

    await go("dashboard");
    await expect(
      page.getByRole("heading", { name: "Overview", exact: true }),
    ).toBeVisible();
    await layout("dashboard");
    await go("flows");
    await expect(createFlowEntry(page)).toBeVisible();
    await layout("flows");
    await createFlowEntry(page).click();
    const createFlow = flowEditor(page);
    await expect(createFlow).toBeVisible();
    await expect(
      createFlow.getByLabel("Prompt template", { exact: true }),
    ).toBeVisible();
    await createFlow
      .getByLabel("Name", { exact: true })
      .fill(`CJM ${viewport.name}`);
    await createFlow
      .getByLabel("Executor tag", { exact: true })
      .selectOption("openhands");
    await createFlow
      .getByLabel("Model", { exact: true })
      .nth(0)
      .selectOption(`${alpha}/model`);
    await createFlow
      .getByLabel("Prompt template", { exact: true })
      .fill("CJM {{external_id}}");
    await createFlow.getByLabel("event-source", { exact: true }).check();
    // Flow forms bind Sources only; shared values live in the Source editor.
    await expect(createFlow.getByLabel(/ override$/)).toHaveCount(0);
    const binding = createFlow.locator(`[data-flow-source="${S1}"]`);
    await expect(
      binding.getByRole("link", { name: "Inspect source", exact: true }),
    ).toHaveAttribute("href", new RegExp(`view=source&.*id=${S1}`));
    await binding
      .getByRole("button", { name: "Actions for event-source", exact: true })
      .click();
    await expect(
      page
        .getByRole("menu", { name: "Actions for event-source", exact: true })
        .getByRole("menuitem", { name: "Edit source", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await layout("flow-create");
    await saveFlow(createFlow).click();
    await expect(createFlow).not.toBeVisible();
    const flowCreates = world.writes.filter(
      (write) => write.method === "POST" && write.path === "/ui/v1/flows",
    );
    expect(flowCreates).toHaveLength(1);
    expect(flowCreates[0].body).toMatchObject({
      name: `CJM ${viewport.name}`,
      execution_tag: "openhands",
      model_aliases: [`${alpha}/model`],
      source_ids: [S1],
      prompt_template: "CJM {{external_id}}",
    });
    // No shared Source value travels with a Flow write.
    expect(Object.keys(flowCreates[0].body)).not.toContain("values");
    const cjmFlow = [...world.flows.values()].find(
      (flow) => flow.name === `CJM ${viewport.name}`,
    );

    await go("history");
    await expect(
      page
        .locator("#results")
        .getByRole("link", { name: `intake-${T1}`, exact: true }),
    ).toHaveAttribute("href", new RegExp(`id=${T1}`));
    // The internal task ID appears only inside the task name.
    expect(
      (await page.locator("#results").innerText())
        .split(`intake-${T1}`)
        .join(" "),
    ).not.toContain(String(T1));
    await layout("task-history");
    await go("task", T1);
    const sourceLink = page
      .locator("main")
      .getByRole("link", { name: "event-source", exact: true });
    const flowLink = page
      .locator("main")
      .getByRole("link", { name: "Flow one", exact: true });
    await expect(sourceLink).toBeVisible();
    await expect(flowLink).toBeVisible();
    await layout("task-detail");
    for (const link of [sourceLink, flowLink]) {
      expect
        .soft((await link.boundingBox())?.height, "canonical link touch target")
        .toBeGreaterThanOrEqual(44);
      expect.soft(await link.getAttribute("href")).toContain("team=");
      await link.focus();
      await expect.soft(link).toBeFocused();
    }
    await sourceLink.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "event-source", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(sourceLink).toBeVisible();
    await flowLink.click();
    await expect(
      page.getByRole("heading", { name: "Flow detail", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#flow-detail")).toContainText("Flow one");
    await expect(page).toHaveURL(new RegExp(`id=${F1}`));
    await expect(flowEditor(page)).toHaveCount(0);
    await page.goBack();
    await expect(sourceLink).toBeVisible();
    await go("executors");
    await expect(page.locator("#results")).toContainText(String(E1));
    await layout("executors");
    await go("executor", E1);
    await expect(page.locator("main")).toContainText("Executor tasks");
    await layout("executor-detail");

    await go("sources");
    await expect(
      page.getByRole("link", { name: "event-source", exact: true }).first(),
    ).toBeVisible();
    await layout("sources");
    await createSourceEntry(page).click();
    const createSource = sourceWizard(page);
    await expect(
      createSource.getByLabel("Name", { exact: true }),
    ).toBeVisible();
    await createSource
      .getByLabel("Name", { exact: true })
      .fill(`cjm-${viewport.name}`);
    await createSource
      .getByRole("button", { name: "Next", exact: true })
      .click();
    await createSource
      .getByLabel("Mode", { exact: true })
      .selectOption("webhook");
    await createSource.locator("details summary").click();
    await createSource
      .getByLabel("Implementation version", { exact: true })
      .fill("1");
    await layout("source-create");
    await createSource
      .getByRole("button", { name: "Create source", exact: true })
      .click();
    const keyPage = sourceKeyPage(page);
    await expect(keyPage).toBeVisible();
    await layout("source-key");
    await keyPage
      .getByRole("button", { name: "Close and clear", exact: true })
      .click();
    await expect(
      page
        .getByRole("link", { name: `cjm-${viewport.name}`, exact: true })
        .first(),
    ).toBeVisible();
    await go("source", S2);
    await expect(page.locator("#source-detail")).toContainText("Poll URL");
    await layout("source-detail-poller");
    await go("source", S1);
    await expect(
      page.getByRole("heading", { name: "event-source", exact: true }),
    ).toBeVisible();
    const beforeWrites = world.writes.length;
    await expect(
      page.locator(
        "#source-detail input,#source-detail textarea,#source-detail select",
      ),
    ).toHaveCount(0);
    await go("sources");
    await page
      .getByRole("link", { name: "poller-source", exact: true })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "poller-source", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("team")).toBe(String(alpha));
    expect(new URL(page.url()).searchParams.get("id")).toBe(String(S2));
    await go("sources");
    await page
      .getByRole("link", { name: "event-source", exact: true })
      .first()
      .focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "event-source", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("team")).toBe(String(alpha));
    expect(new URL(page.url()).searchParams.get("id")).toBe(String(S1));
    expect(world.writes).toHaveLength(beforeWrites);
    await expect(page.locator("#source-detail")).toContainText(
      "Read-only here",
    );
    await layout("source-detail-webhook");
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "event-source", exact: true }),
    ).toBeVisible();
    expect(world.writes).toHaveLength(beforeWrites);
    // Key actions are Sources catalog record commands; detail offers none.
    await expect(
      page
        .locator("main")
        .getByRole("button", { name: /^(Rotate key|Disable source)$/ }),
    ).toHaveCount(0);
    await go("sources");
    for (const action of ["Rotate key", "Disable source"] as SourceCommand[]) {
      await openSourceCommand(page, "event-source", action);
      await expect(sourceDialog(page, action, "event-source")).toBeVisible();
      await layout(action);
      await page.keyboard.press("Escape");
    }
    expect(world.writes).toHaveLength(beforeWrites);

    await go("settings");
    await expect(page.locator('[aria-label="Settings sections"] a')).toHaveText(
      ["Parameters", "Models", "Executors", "Operator"],
    );
    await expect(
      page.locator('[aria-label="Settings sections"] [aria-current="page"]'),
    ).toHaveText("Parameters");
    await expect
      .soft(page.locator("main h1"), "Settings has one page heading")
      .toHaveCount(1);
    await expect
      .soft(page.getByRole("heading", { name: "Parameters", exact: true }))
      .toBeVisible();
    await layout("parameters");
    for (const name of ["Create flow", "Create source"])
      expect
        .soft(
          await page
            .getByRole("link", { name, exact: true })
            .or(page.getByRole("button", { name, exact: true }))
            .count(),
          `${name} is absent on Settings`,
        )
        .toBe(0);
    await page.getByRole("link", { name: "Models", exact: true }).click();
    await expect
      .soft(page.getByRole("heading", { name: "Models", exact: true }))
      .toBeVisible();
    await expect
      .soft(page.getByRole("button", { name: "Create model", exact: true }))
      .toBeVisible();
    await expect(
      page.getByRole("link", { name: "Flow one", exact: true }).first(),
    ).toBeVisible();
    await layout("settings-models");

    // Another Flow bound to the shared Source, created elsewhere.
    const another = flowRecord(8006, `Another ${viewport.name}`, [S1]);
    world.flows.set(another.flow_id, another);
    // Binding-only Flow edit: bind the poller without touching shared values.
    await go("flows", F1);
    const edit = flowEditor(page);
    await expect(
      edit.getByLabel("event-source", { exact: true }),
    ).toBeChecked();
    await expect(
      edit.getByRole("link", { name: "Edit source", exact: true }).first(),
    ).toHaveAttribute("href", new RegExp(`view=source-edit&.*id=${S1}`));
    await expect(edit.getByLabel(/ override$/)).toHaveCount(0);
    await edit.getByLabel("poller-source", { exact: true }).check();
    await layout("settings-flows");
    const beforeEdit = world.writes.length;
    await saveFlow(edit).click();
    await expect(edit).not.toBeVisible();
    const flowEdits = world.writes.slice(beforeEdit);
    expect(flowEdits.map((write) => `${write.method} ${write.path}`)).toEqual([
      `PUT /ui/v1/flows/${F1}`,
    ]);
    expect([...flowEdits[0].body.source_ids].sort()).toEqual([S1, S2].sort());
    expect(Object.keys(flowEdits[0].body)).not.toContain("values");

    // Shared Source values: the standalone Source editor names every using
    // Flow before Save and changes no binding.
    await go("source-edit", S1);
    const sourceForm = page.locator("main");
    await expect(page.locator("#source-settings-form")).toBeVisible();
    for (const affected of [world.flows.get(F1), cjmFlow, another]) {
      const affectedLink = sourceForm.getByRole("link", {
        name: affected.name,
        exact: true,
      });
      await affectedLink.scrollIntoViewIfNeeded();
      expect((await affectedLink.boundingBox())?.height).toBeGreaterThanOrEqual(
        44,
      );
      const affectedURL = new URL(
        (await affectedLink.getAttribute("href"))!,
        page.url(),
      );
      expect(affectedURL.searchParams.get("view")).toBe("flow");
      expect(affectedURL.searchParams.get("id")).toBe(String(affected.flow_id));
      expect(affectedURL.searchParams.get("team")).toBe(String(alpha));
    }
    await layout("settings-sources-webhook");
    await sourceForm
      .getByLabel("Note value state", { exact: true })
      .selectOption("set");
    await sourceForm.getByLabel("Note override", { exact: true }).fill("");
    const beforeSave = world.writes.length;
    await sourceForm
      .getByRole("button", { name: "Save source", exact: true })
      .click();
    await expect(page.locator("[data-source-save-status]")).toContainText(
      "Source saved",
    );
    const sourceSaves = world.writes.slice(beforeSave);
    expect(sourceSaves.map((write) => `${write.method} ${write.path}`)).toEqual(
      [`PUT /ui/v1/sources/${S1}/settings`],
    );
    // The explicit empty string is sent as "", never dropped or nulled, and
    // the save carries no Flow binding.
    expect(sourceSaves[0].body.values).toHaveProperty("note", "");
    expect(sourceSaves[0].body).not.toHaveProperty("flow_ids");
    expect(sourceSaves[0].etag).toBe('"rev-2"');
    await go("source-edit", S2);
    await expect(
      page.getByLabel("Poll URL value state", { exact: true }),
    ).toBeVisible();
    await layout("settings-sources-poller");
    expect
      .soft([...new Set(origins)], "browser uses same proxy origin only")
      .toEqual([proxy.baseUrl]);
    expect.soft(pageErrors).toEqual([]);
    expect
      .soft(world.failedResponses, "successful screens read no failing route")
      .toEqual([]);
    expect
      .soft(consoleErrors, "successful screens have no console errors")
      .toEqual([]);
  });
}

// One test, one step per original check. Each step builds its own in-page
// world on a blank document and removes its routes when it ends.
test("adversary CJM / delayed Source settings cannot reopen prior-team Flow editor; adversary catalog / exact Source metadata and poll outcome at desktop, tablet and mobile · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const isolatedStep = (title: string, body: () => Promise<void>) =>
    test.step(title, async () => {
      await page.goto("about:blank");
      try {
        await body();
      } finally {
        await page.goto("about:blank");
        await page.unrouteAll({ behavior: "ignoreErrors" });
      }
    });
  await isolatedStep(
    "adversary CJM / delayed Source settings cannot reopen prior-team Flow editor · Web UI unit",
    async () => {
      await cjmWorld(page);
      let release!: () => void, seen!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const reached = new Promise<void>((resolve) => (seen = resolve));
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        // Flow editors bind Sources only: their Source read is the same-team
        // Sources catalog. Hold the Alpha read while the team changes.
        await page.route("**/ui/v1/sources?*", async (route) => {
          if (
            route.request().headers().authorization !==
            `Bearer working-${alpha}`
          )
            return route.fallback();
          seen();
          await held;
          // Then the ordinary same-team catalog answer arrives, late.
          await route.fallback().catch(() => undefined);
        });
        await page.goto(`${proxy.baseUrl}/?view=flows&id=${F1}&team=${alpha}`);
        await reached;
        await expect(page.locator("#flow-form")).toBeHidden();
        await expect(
          page.getByRole("button", { name: "Save flow", exact: true }),
        ).toHaveCount(0);
        await page
          .getByLabel("Team", { exact: true })
          .selectOption(String(beta));
        await expect(page.locator("#team-selector")).toHaveValue(String(beta));
        release();
        await expect(page.locator("#flows-results")).toContainText(
          "No records available.",
        );
        await expect(flowEditor(page)).not.toBeVisible();
        await expect(page.locator("#flow-form")).toBeHidden();
        await expect(page.locator("main")).not.toContainText("Flow one");
        expect(errors).toEqual([]);
      } finally {
        release?.();
      }
    },
  );
  await isolatedStep(
    "adversary catalog / exact Source metadata and poll outcome at desktop, tablet and mobile · Web UI unit",
    async () => {
      const world = await cjmWorld(page);
      const sentinelID = 8007;
      world.sources.set(
        sentinelID,
        sourceRecord(sentinelID, "catalog-sentinel", "webhook", {
          revision: 1,
          settings_status: "awaiting_schema",
          implementation_version: "catalog-version-z9",
          filter_summary: "catalog-filter-sentinel",
          description: "catalog-description-sentinel",
        }),
      );
      const webhookURL = world.sources.get(sentinelID).webhook_url as string;
      expect(webhookURL).toContain("/catalog-sentinel/task");
      // As in the original stand, the team's one bound Source is a poller that
      // reached one HTTP 503 poll: last_poll and the failure count as the
      // Registry projects them after the Poll Dispatcher's result.
      world.sources.delete(S2);
      const poller = world.sources.get(S1);
      Object.assign(poller, {
        mode: "poller",
        webhook_url: null,
        revision: 3,
        polling: {
          polling_blocked_at: null,
          consecutive_failures: 1,
          next_poll_at: "2026-10-18T00:02:00Z",
        },
        last_poll: {
          poll_id: 7003,
          status: "finished",
          outcome: "http_error",
          error_code: "http_error",
          http_status: 503,
          started_at: "2026-10-18T00:00:00Z",
          finished_at: "2026-10-18T00:01:00Z",
          returned_tasks: 0,
        },
      });
      for (const viewport of views)
        await test.step(`adversary catalog / exact Source metadata and poll outcome at ${viewport.name}`, async () => {
          await page.setViewportSize(viewport);
          await page.goto(`${proxy.baseUrl}/?view=sources&team=${alpha}`);
          const root = page.locator("#source-results");
          await expect(
            root
              .getByRole("link", { name: "catalog-sentinel", exact: true })
              .first(),
          ).toBeVisible();
          // Each Source renders a table and card trigger. Resolve the visible
          // trigger by Source name so opening one menu cannot renumber the rest.
          for (const { name } of world.sources.values()) {
            const expansion = sourceActionsTrigger(page, name);
            await expect(expansion).toBeVisible();
            await expect(expansion).toHaveAttribute("aria-expanded", "false");
            expect
              .soft(
                (await expansion.boundingBox())?.height,
                "catalog actions expansion touch target",
              )
              .toBeGreaterThanOrEqual(44);
            await expansion.click();
            await expect(expansion).toHaveAttribute("aria-expanded", "true");
            await expect(
              root.getByRole("menu", {
                name: `Actions for ${name}`,
                exact: true,
              }),
            ).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(expansion).toHaveAttribute("aria-expanded", "false");
          }
          const content = await root.innerText();
          await root
            .getByRole("link", { name: "catalog-sentinel", exact: true })
            .first()
            .click();
          await expect(
            page.getByRole("heading", {
              name: "catalog-sentinel",
              exact: true,
            }),
          ).toBeVisible();
          const detail = await page.locator("#source-detail").innerText();
          for (const value of [
            "catalog-version-z9",
            "catalog-filter-sentinel",
            "catalog-description-sentinel",
            webhookURL,
          ])
            expect
              .soft(
                detail,
                `Source details ${viewport.name} omit exact metadata ${value}`,
              )
              .toContain(value);
          await page.goBack();
          await expect(
            root
              .getByRole("link", { name: "catalog-sentinel", exact: true })
              .first(),
          ).toBeVisible();
          await page.goto(
            `${proxy.baseUrl}/?view=source&id=${S1}&team=${alpha}`,
          );
          await expect(page.locator("#source-detail")).toContainText(
            "Last poll",
          );
          expect
            .soft(
              await page.locator("#source-detail").innerText(),
              `Source details ${viewport.name} omit reached last poll HTTP error outcome`,
            )
            .toMatch(/http[ _-]?error/i);
          expect
            .soft(
              content,
              `Sources ${viewport.name} omits confirmed 24-hour counters`,
            )
            .toMatch(/0\s*\/\s*0\s*\/\s*0/);
        });
      expect(world.writes).toEqual([]);
    },
  );
});
