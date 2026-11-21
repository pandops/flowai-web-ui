import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { flowEditor } from "../fixtures/flow-editor";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";

// Survivor of task-sources-interface task-links.browser.spec.ts (v0041 D15):
// the Registry is replaced by public /ui/v1 responses of the same shapes.
test.use({ actionTimeout: 10_000 });

const teamID = 1,
  taskID = 8024,
  sourceID = 8025,
  flowID = 8026;

let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [{ team_id: teamID, team_name: "intake" }],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

async function linkedTaskApi(page: Page) {
  const source = {
    source_id: sourceID,
    team_id: teamID,
    name: "event-source",
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
    webhook_url: "https://receiver.example/webhook/1/event-source/task",
    intake_counts: {
      published: 1,
      rejected: 0,
      accepted: 1,
      deduplicated: 0,
      no_target: 0,
      failed: 0,
    },
  };
  const flow = {
    flow_id: flowID,
    name: "Flow one",
    revision: 1,
    execution_tag: "openhands",
    model_aliases: [`${teamID}/model`],
    prompt_template: "Work {{external_id}}",
    execution_parameters: {},
    default_image: null,
    source_ids: [sourceID],
    source_revisions: { [sourceID]: 2 },
    per_task_limit: null,
    flow_limit: null,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
  };
  const task = {
    task_id: taskID,
    task_name: `intake-${taskID}`,
    source_id: sourceID,
    flow_id: flowID,
    external_id: "linked-task",
    current_state: "queued",
    executor_id: null,
    ingested_at: "2026-10-18T00:00:00Z",
    claimed_at: null,
    completed_at: null,
    environment: {},
    secret_keys: [],
  };
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      !["GET", "HEAD"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/ui/v1/")
    )
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const list = (items: unknown[]) => ({ json: { items, next_cursor: null } });
  await page.route("**/ui/v1/**", async (route) => {
    const url = new URL(route.request().url()),
      p = url.pathname;
    if (route.request().method() !== "GET") return route.fallback();
    if (p === "/ui/v1/sources") return route.fulfill(list([source]));
    if (p === `/ui/v1/sources/${sourceID}`)
      return route.fulfill({ json: source, headers: { etag: '"rev-2"' } });
    if (p === `/ui/v1/sources/${sourceID}/settings`)
      return route.fulfill({
        json: {
          source_id: sourceID,
          mode: "webhook",
          revision: 2,
          settings_status: "complete",
          fields: [],
          platform: {
            poll_url: null,
            poll_interval_minutes: null,
            webhook_url: source.webhook_url,
          },
        },
        headers: { etag: '"rev-2"' },
      });
    if (p === "/ui/v1/flows") return route.fulfill(list([flow]));
    if (p === `/ui/v1/flows/${flowID}`)
      return route.fulfill({ json: flow, headers: { etag: '"1"' } });
    const settings = {
      ...flow,
      models: flow.model_aliases.map((model_alias) => ({
        model_alias,
        availability: "active",
      })),
    };
    if (p === "/ui/v1/flow-llm-settings")
      return route.fulfill(list([settings]));
    if (p === `/ui/v1/flow-llm-settings/${flowID}`)
      return route.fulfill({ json: settings });
    if (p === "/ui/v1/models")
      return route.fulfill(
        list([
          {
            name: "model",
            model_alias: `${teamID}/model`,
            paused: false,
            archived_at: null,
            provider: "openai",
            provider_model: "x",
            editable: true,
            credential_configured: false,
          },
        ]),
      );
    if (p === "/ui/v1/execution-tags")
      return route.fulfill(list(["openhands"]));
    if (p === `/ui/v1/teams/${teamID}/tasks`)
      return route.fulfill(list([task]));
    if (p === `/ui/v1/teams/${teamID}/tasks/${taskID}`)
      return route.fulfill({ json: task });
    if (
      p === `/ui/v1/teams/${teamID}/tasks/${taskID}/events` ||
      p === `/ui/v1/teams/${teamID}/tasks/${taskID}/logs` ||
      p === `/ui/v1/teams/${teamID}/tasks/${taskID}/attempts`
    )
      return route.fulfill(list([]));
    return route.fallback();
  });
  return { writes };
}

test("v0013.2 / task links address canonical Source and Flow with browser Back · Web UI unit", async ({
  page,
}) => {
  const { writes } = await linkedTaskApi(page);
  await page.goto(`${proxy.baseUrl}/?view=task&id=${taskID}&team=${teamID}`);
  // v0034 names canonical references by resource name; hrefs keep IDs.
  const flow = page
    .locator("main")
    .getByRole("link", { name: "Flow one", exact: true });
  const source = page
    .locator("main")
    .getByRole("link", { name: "event-source", exact: true });
  await expect(flow).toBeVisible();
  await expect(source).toBeVisible();
  expect(await flow.getAttribute("href")).toContain(String(flowID));
  expect(await source.getAttribute("href")).toContain(String(sourceID));
  await expect
    .poll(async () => (await source.boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
  await source.click();
  await expect(
    page.getByRole("heading", { name: "event-source", exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(flow).toBeVisible();
  await flow.click();
  // The reference opens the read-only Flow page; editing is a separate action.
  await expect(
    page.getByRole("heading", { name: "Flow detail", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.locator("#flow-detail")).toContainText("Flow one");
  await expect(page).toHaveURL(new RegExp(String(flowID)));
  await expect(flowEditor(page)).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Edit flow", exact: true }),
  ).toHaveAttribute("href", new RegExp(`id=${flowID}`));
  expect(writes).toEqual([]);
});
