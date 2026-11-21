import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import { createSourceEntry } from "../fixtures/source-wizard";
import {
  TEAM,
  executorRecord,
  executorRoutes,
  v0048Proxy,
  MATRIX,
  usePresentation,
} from "../fixtures/v0048-ui";

// web-ui: Web UI provides a Settings page with sections (v0048), and
// task-sources-interface "Team has no source".
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 Settings sections without sources and Executors within Settings · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    const empty = { json: { items: [], next_cursor: null } };
    await page.route("**/ui/v1/sources?**", (route) => route.fulfill(empty));
    await page.route("**/ui/v1/flows?**", (route) => route.fulfill(empty));
    await page.route("**/ui/v1/models?**", (route) => route.fulfill(empty));
    await page.route("**/ui/v1/execution-tags?**", (route) =>
      route.fulfill(empty),
    );
    await executorRoutes(page, {
      records: [executorRecord(7)],
      states: [],
      events: new Map(),
      tasks: new Map(),
    });
    const sections = page.getByRole("navigation", {
      name: "Settings sections",
      exact: true,
    });

    await test.step("Settings without sources / Team has no source", async () => {
      await page.goto(`${proxy.baseUrl}/?view=settings&team=${TEAM}`);
      // The section links render after the session loads, so wait for them.
      await expect(sections.getByRole("link")).toHaveText(
        ["Parameters", "Models", "Executors", "Operator"],
        { useInnerText: true },
      );
      await expect(
        sections.getByRole("link", { name: "Parameters", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await page.goto(`${proxy.baseUrl}/?view=sources&team=${TEAM}`);
      // The shared empty state (current sources mockup): "No data".
      await expect(page.locator("main")).toContainText("No data");
      await expect(page.locator("main")).toContainText("No records available.");
      await expect(createSourceEntry(page).first()).toBeVisible();
    });

    await test.step("Operator opens Executors through Settings", async () => {
      for (const route of [
        "view=settings&section=executors",
        "view=executors",
      ]) {
        await page.goto(`${proxy.baseUrl}/?${route}&team=${TEAM}`);
        await expect(
          page
            .locator("#results")
            .getByRole("link", { name: "7", exact: true }),
        ).toBeVisible();
        await expect(
          sections.getByRole("link", { name: "Executors", exact: true }),
        ).toHaveAttribute("aria-current", "page");
        await expect(
          page.locator(".nav-links").getByText("Executors", { exact: true }),
        ).toHaveCount(0);
      }
      await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=7`);
      await expect(
        sections.getByRole("link", { name: "Executors", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Executor 7", exact: true }),
      ).toBeVisible();
    });
  });

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 read-only Source details open the read-only Flow with a separate Edit action · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    const source = {
      source_id: 4,
      team_id: TEAM,
      name: "jira-sync",
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
      webhook_url: "https://receiver.example/webhook/3/jira-sync/task",
      intake_counts: {
        published: 0,
        rejected: 0,
        accepted: 0,
        deduplicated: 0,
        no_target: 0,
        failed: 0,
      },
    };
    const flow = {
      flow_id: 1,
      name: "Intake routing",
      revision: 1,
      execution_tag: "openhands",
      model_aliases: [`${TEAM}/model`],
      prompt_template: "Work {{external_id}}",
      execution_parameters: {},
      default_image: null,
      source_ids: [4],
      source_revisions: { 4: 2 },
      per_task_limit: null,
      flow_limit: null,
      failure_retry_count: 3,
      failure_retry_wait_seconds: 60,
      pending_limit_seconds: 900,
      release_delay_seconds: 300,
      execution_revision: 1,
      created_at: "2026-10-15T09:00:00Z",
      updated_at: "2026-10-15T09:00:00Z",
    };
    const list = (items: unknown[]) => ({ json: { items, next_cursor: null } });
    const writes: string[] = [];
    page.on("request", (request) => {
      // The session token request at page load is not a data write.
      const path = new URL(request.url()).pathname;
      if (
        !["GET", "HEAD"].includes(request.method()) &&
        !path.startsWith("/auth/")
      )
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    await page.route("**/ui/v1/sources?**", (route) =>
      route.fulfill(list([source])),
    );
    await page.route(/\/ui\/v1\/sources\/4$/, (route) =>
      route.fulfill({ json: source, headers: { etag: '"rev-2"' } }),
    );
    await page.route(/\/ui\/v1\/sources\/4\/settings$/, (route) =>
      route.fulfill({
        headers: { etag: '"rev-2"' },
        json: {
          source_id: 4,
          mode: "webhook",
          settings_status: "complete",
          schema_revision: 1,
          revision: 2,
          fields: [],
          platform: { webhook_url: source.webhook_url },
          polling: null,
          last_poll: null,
        },
      }),
    );
    await page.route("**/ui/v1/flows?**", (route) =>
      route.fulfill(list([flow])),
    );
    await page.route(/\/ui\/v1\/flows\/1$/, (route) =>
      route.fulfill({ json: flow, headers: { etag: '"1"' } }),
    );
    await page.route(
      /\/ui\/v1\/flow-llm-settings(?:\/1)?(?:\?.*)?$/,
      (route) => {
        const withModels = {
          ...flow,
          models: [{ model_alias: `${TEAM}/model`, availability: "active" }],
        };
        return route.fulfill(
          new URL(route.request().url()).pathname.endsWith("/1")
            ? { json: withModels }
            : list([withModels]),
        );
      },
    );
    await page.route("**/ui/v1/models?**", (route) => route.fulfill(list([])));
    await page.route("**/ui/v1/execution-tags?**", (route) =>
      route.fulfill(list(["openhands"])),
    );
    await page.route(
      new RegExp(`/ui/v1/teams/${TEAM}/tasks(?:\\?.*)?$`),
      (route) => route.fulfill(list([])),
    );

    await test.step("Operator inspects source settings", async () => {
      await page.goto(`${proxy.baseUrl}/?view=source&team=${TEAM}&id=4`);
      await expect(
        page.getByRole("heading", { name: "jira-sync", exact: true }),
      ).toBeVisible();
      // Source details are read-only.
      await expect(
        page
          .locator("main")
          .locator("input:visible,textarea:visible,select:visible"),
      ).toHaveCount(0);
      const usage = page
        .locator("main")
        .getByRole("link", { name: "Intake routing", exact: true });
      await expect(usage).toHaveAttribute(
        "href",
        `?view=flow&team=${TEAM}&id=1`,
      );
      await usage.click();
      await expect(page).toHaveURL(/[?&]view=flow(&|$)/);
      await expect(page).toHaveURL(/[?&]id=1(&|$)/);
      const main = page.locator("main");
      await expect(main).toContainText("Intake routing");
      // The Flow page is read-only; Edit flow is its own separate action.
      await expect(
        main.getByRole("textbox", { name: "Prompt template", exact: true }),
      ).toHaveCount(0);
      await expect(
        main.locator("input:visible,textarea:visible,select:visible"),
      ).toHaveCount(0);
      await expect(
        main.getByRole("button", { name: /^(Save flow|Save)$/ }),
      ).toHaveCount(0);
      const edit = main
        .getByRole("link", { name: "Edit flow", exact: true })
        .or(main.getByRole("button", { name: "Edit flow", exact: true }));
      await expect(edit).toHaveCount(1);
      await expect(edit).toBeVisible();
      expect(writes).toEqual([]);
    });
  });
