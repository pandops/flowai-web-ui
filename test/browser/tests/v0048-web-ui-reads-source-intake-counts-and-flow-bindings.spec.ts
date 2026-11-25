import { expect, test, type Page } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  v0048Proxy,
  MATRIX,
  usePresentation,
  expectNoHorizontalScroll,
} from "../fixtures/v0048-ui";

// web-ui: the Sources page lists platform-derived ingestion statistics and
// bound flow usage links (v0048). source-controller serves each Source with
// its all-time `intake_counts` and no Flow list; Flow bindings are
// Flow-owned `source_ids` (flow-registry). Bugfix-14: the owner's Sources
// page failed with "Cannot read properties of undefined (reading
// 'trailing_24h')" on the demo stand. Owner decision 2026-11-14: the list
// uses the detail label "Lifetime accepted / deduplicated / failed".
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const LABEL = "Lifetime accepted / deduplicated / failed";

// Exactly the v0048 operator Source view of source-controller.
function source(
  source_id: number,
  name: string,
  mode: "poller" | "webhook",
  counts: [number, number, number],
) {
  const [accepted, deduplicated, failed] = counts;
  return {
    id: source_id,
    source_id,
    team_id: TEAM,
    name,
    mode,
    contract_version: "source.v1",
    implementation_version: "1.0.0",
    description: null,
    filter_summary: "",
    enabled: true,
    revision: 2,
    settings_status: "complete",
    health: "healthy",
    activity: null,
    intake_counts: {
      published: accepted + deduplicated + failed + 1,
      rejected: 1,
      accepted,
      deduplicated,
      no_target: 0,
      failed,
    },
    created_at: "2026-10-15T09:00:00Z",
    polling:
      mode === "poller"
        ? {
            consecutive_failures: 0,
            polling_blocked_at: null,
            next_poll_at: "2026-10-15T09:05:00Z",
          }
        : null,
    last_poll: null,
    webhook_url:
      mode === "webhook"
        ? `https://receiver.example/webhook/ops/${name}/task`
        : null,
    last_seen_at: null,
    observed_counters: null,
  };
}
const SOURCES = [
  source(4, "jira-sync", "poller", [9, 2, 1]),
  source(5, "webhook-events", "webhook", [0, 0, 0]),
];
function flow(flow_id: number, name: string, source_ids: number[]) {
  return {
    flow_id,
    name,
    execution_tag: "openhands",
    model_aliases: [`${TEAM}/model`],
    per_task_limit: null,
    flow_limit: null,
    prompt_template: "Work {{external_id}}",
    execution_parameters: {},
    default_image: null,
    source_ids,
    failure_retry_count: 3,
    failure_retry_wait_seconds: 60,
    pending_limit_seconds: 900,
    release_delay_seconds: 300,
    revision: 1,
    execution_revision: 1,
    created_at: "2026-10-15T09:00:00Z",
    updated_at: "2026-10-15T09:00:00Z",
  };
}
// Both Flows bind Source 4; Source 5 is unbound.
const FLOWS = [flow(1, "Intake routing", [4]), flow(2, "Release routing", [4])];

async function routes(page: Page, flowsFail: () => boolean) {
  const list = (items: unknown[]) => ({ json: { items, next_cursor: null } });
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill(list(SOURCES)),
  );
  await page.route(/\/ui\/v1\/sources\/(\d+)$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/")[4]);
    const found = SOURCES.find((item) => item.source_id === id);
    return route.fulfill(
      found
        ? { json: found, headers: { etag: '"rev-2"' } }
        : { status: 404, json: { code: "not_found" } },
    );
  });
  await page.route(/\/ui\/v1\/sources\/(\d+)\/settings$/, (route) => {
    const id = Number(new URL(route.request().url()).pathname.split("/")[4]);
    const found = SOURCES.find((item) => item.source_id === id)!;
    return route.fulfill({
      headers: { etag: '"rev-2"' },
      json: {
        source_id: id,
        mode: found.mode,
        settings_status: "complete",
        schema_revision: 1,
        revision: 2,
        fields: [],
        platform:
          found.mode === "poller"
            ? {
                poll_url: "https://jira.example/poll",
                poll_interval_minutes: 5,
              }
            : { webhook_url: found.webhook_url },
        polling: found.polling,
        last_poll: null,
      },
    });
  });
  await page.route("**/ui/v1/flows?**", (route) =>
    flowsFail()
      ? route.fulfill({ status: 503, json: { code: "unavailable" } })
      : route.fulfill(list(FLOWS)),
  );
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 Sources read intake_counts and Flow-owned bindings · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    let flowsFail = false;
    await routes(page, () => flowsFail);
    const main = page.locator("main");

    await test.step("Sources list shows lifetime intake counts and bound Flows", async () => {
      await page.goto(`${proxy.baseUrl}/?view=sources&team=${TEAM}`);
      const catalog = page.locator(".source-catalog");
      await expect(catalog).toBeVisible();
      await expect(main).not.toContainText("Request failed");
      await expect(main).not.toContainText("24 h");
      const usage = (id: number) =>
        page.locator(`[data-source-flow-links="${id}"]:visible`);
      for (const [name, flowID] of [
        ["Intake routing", 1],
        ["Release routing", 2],
      ] as const)
        await expect(
          usage(4).getByRole("link", { name, exact: true }),
        ).toHaveAttribute("href", `?view=flow&team=${TEAM}&id=${flowID}`);
      await expect(usage(5)).toHaveText("Not used by a flow");
      // The visible table or card layout carries the label with each value.
      await expect(catalog.getByText(LABEL).first()).toBeAttached();
      await expect(
        catalog.getByText("9 / 2 / 1").filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        catalog.getByText("0 / 0 / 0").filter({ visible: true }).first(),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });

    await test.step("Source detail shows lifetime counts and linked Flows", async () => {
      await page.goto(`${proxy.baseUrl}/?view=source&team=${TEAM}&id=4`);
      const detail = page.locator("#source-detail");
      await expect(
        detail.locator("dt").filter({ hasText: new RegExp(`^${LABEL}$`) }),
      ).toBeVisible();
      await expect(
        detail
          .locator("div")
          .filter({ has: page.locator("dt", { hasText: LABEL }) })
          .locator("dd"),
      ).toHaveText("9 / 2 / 1");
      const linked = detail.locator(".link-list");
      await expect(linked.getByRole("link")).toHaveText([
        "Intake routing",
        "Release routing",
      ]);
      await expect(main).not.toContainText("Request failed");
      await page.goto(`${proxy.baseUrl}/?view=source&team=${TEAM}&id=5`);
      await expect(detail).toContainText("Not used by a flow");
      await expectNoHorizontalScroll(page);
    });

    await test.step("Source editor names the Flows a change affects", async () => {
      await page.goto(`${proxy.baseUrl}/?view=source-edit&team=${TEAM}&id=4`);
      const editor = page.locator("#source-editor");
      await expect(editor).toContainText(
        "Changes to this Source can affect these bound Flows.",
      );
      await expect(
        editor.locator("[data-source-impact]").getByRole("link"),
      ).toHaveText(["Intake routing", "Release routing"]);
      await page.goto(`${proxy.baseUrl}/?view=source-edit&team=${TEAM}&id=5`);
      await expect(editor).toContainText(
        "No Flow is bound to this Source. Its settings can still be saved.",
      );
    });

    await test.step("Flow catalog failure leaves Source pages usable", async () => {
      flowsFail = true;
      await page.goto(`${proxy.baseUrl}/?view=source&team=${TEAM}&id=4`);
      const detail = page.locator("#source-detail");
      await expect(detail).toContainText("Flow usage unavailable");
      await expect(detail).toContainText("9 / 2 / 1");
      await expect(detail).not.toContainText("Not used by a flow");
      await page.goto(`${proxy.baseUrl}/?view=sources&team=${TEAM}`);
      await expect(page.locator("[data-flow-names-fault]")).toBeVisible();
      await expect(
        page.locator('[data-source-flow-links="4"]:visible'),
      ).toHaveText("Flow usage unavailable");
      await expect(
        page.locator('[data-source-flow-links="5"]:visible'),
      ).toHaveText("Flow usage unavailable");
      await page.goto(`${proxy.baseUrl}/?view=source-edit&team=${TEAM}&id=4`);
      await expect(page.locator("#source-editor")).toContainText(
        "Bound Flows are unavailable. You can still save Source settings.",
      );
    });
  });
