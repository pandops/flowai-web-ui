import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import {
  createSourceEntry,
  sourceKeyPage,
  sourceWizard,
} from "../fixtures/source-wizard";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { workerProxy } from "../fixtures/worker-proxy";
import {
  MATRIX,
  expectTaskCollection,
  usePresentation,
} from "../fixtures/v0048-ui";

// Survivor of task-sources-interface team-back.browser.spec.ts (v0041 D15):
// team-scoped Source reads follow the working token, as API Gateway does.
test.use({ actionTimeout: 10_000 });

const alpha = 1,
  beta = 2;
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await workerProxy(() =>
    startMockedProxy(
      [
        { team_id: alpha, team_name: "alpha" },
        { team_id: beta, team_name: "beta" },
      ],
      path.resolve(__dirname, "../../../web/index.html"),
    ),
  );
});

const sourceRecord = (team: number, id: number, name: string) => ({
  source_id: id,
  team_id: team,
  name,
  revision: 1,
  mode: "webhook",
  enabled: true,
  contract_version: "source.v1",
  implementation_version: "1",
  description: "",
  filter_summary: "",
  settings_status: "awaiting_schema",
  health: "healthy",
  last_seen_at: null,
  polling: null,
  last_poll: null,
  webhook_url: `https://receiver.example/webhook/${team}/${name}/task`,
  intake_counts: {
    published: 0,
    rejected: 0,
    accepted: 0,
    deduplicated: 0,
    no_target: 0,
    failed: 0,
  },
});

async function teamScopedSources(page: Page) {
  const sources = new Map<number, any[]>([
    [alpha, [sourceRecord(alpha, 8016, "event-source")]],
    [beta, []],
  ]);
  const reads: number[] = [],
    creates: { team: number; body: any }[] = [];
  const team = (authorization?: string) =>
    Number(authorization?.replace(/^Bearer working-/, "") ?? "");
  await page.route("**/ui/v1/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      caller = team(request.headers().authorization);
    if (url.pathname === "/ui/v1/sources" && request.method() === "GET") {
      reads.push(caller);
      return route.fulfill({
        json: { items: sources.get(caller) ?? [], next_cursor: null },
      });
    }
    if (url.pathname === "/ui/v1/sources" && request.method() === "POST") {
      const body = request.postDataJSON();
      creates.push({ team: caller, body });
      const created = sourceRecord(caller, 8017, body.name);
      sources.get(caller)!.push(created);
      return route.fulfill({
        status: 201,
        json: { source: created, api_key: "tsk_v1_synthetic-beta-key" },
      });
    }
    if (
      ["/ui/v1/flows", "/ui/v1/flow-llm-settings"].includes(url.pathname) &&
      request.method() === "GET"
    )
      return route.fulfill({ json: { items: [], next_cursor: null } });
    return route.fallback();
  });
  return { reads, creates };
}

test("v0013.5 / browser Back across teams clears transient key and refreshes working identity · Web UI unit", async ({
  page,
}) => {
  const { reads, creates } = await teamScopedSources(page);
  await page.goto(`${proxy.baseUrl}/?view=sources&team=${alpha}`);
  await expect(
    page.getByRole("link", { name: "event-source", exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Team", { exact: true }).selectOption(String(beta));
  await createSourceEntry(page).click();
  const create = sourceWizard(page);
  await create.getByLabel("Name", { exact: true }).fill("beta-source");
  await create.getByRole("button", { name: "Next", exact: true }).click();
  await create.getByLabel("Mode", { exact: true }).selectOption("webhook");
  await create.locator("details summary").click();
  await create.getByLabel("Implementation version", { exact: true }).fill("1");
  await create
    .getByRole("button", { name: "Create source", exact: true })
    .click();
  await expect(sourceKeyPage(page)).toBeVisible();
  // The Source was created with the Beta working token, not the prior team's.
  expect(creates).toHaveLength(1);
  expect(creates[0]).toMatchObject({
    team: beta,
    body: { name: "beta-source", mode: "webhook", implementation_version: "1" },
  });
  const readsBeforeBack = reads.length;
  await page.goBack();
  await expect(page.locator("[data-source-key]")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    "tsk_v1_synthetic-beta-key",
  );
  await expect(page.getByLabel("Team", { exact: true })).toHaveValue(
    String(alpha),
  );
  await expect(
    page.getByRole("link", { name: "event-source", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "beta-source", exact: true }),
  ).toHaveCount(0);
  // The Alpha catalog is re-read with a refreshed Alpha working identity.
  expect(reads.slice(readsBeforeBack)).toContain(alpha);
  expect(reads.slice(readsBeforeBack)).not.toContain(beta);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain("tsk_v1_synthetic-beta-key");
});

// v0050: task rows of each team carry that team's task names. Both teams
// hold tasks 1 and 2, so only the reply's task_name tells them apart. Beta's
// reply names (`beta-802`, `beta-801`) differ from `<team_name>-<task_id>`,
// so a Web UI that composes names from the new team fails on them.
const replyName = (team_name: string, task_id: number) =>
  team_name === "beta" ? `beta-${800 + task_id}` : `${team_name}-${task_id}`;
const taskRow = (team: number, team_name: string, task_id: number) => ({
  task_id,
  task_name: replyName(team_name, task_id),
  team_id: team,
  flow_id: 1,
  source_id: 4,
  external_id: `${team_name}-upstream-${task_id}`.toUpperCase(),
  required_tag: "openhands",
  current_state: "finished",
  attempt: 1,
  executor_id: 7,
  ingested_at: `2026-10-15T09:0${task_id}:00Z`,
  claimed_at: `2026-10-15T09:0${task_id}:05Z`,
  completed_at: `2026-10-15T09:0${task_id}:35Z`,
});
const teamTasks = new Map([
  [alpha, [2, 1].map((id) => taskRow(alpha, "alpha", id))],
  [beta, [2, 1].map((id) => taskRow(beta, "beta", id))],
]);

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0050 team switch shows the new team's task names · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    for (const catalog of ["sources", "flows"])
      await page.route(`**/ui/v1/${catalog}?**`, (route) =>
        route.fulfill({
          json: {
            items:
              catalog === "sources"
                ? [{ source_id: 4, name: "jira-sync", mode: "poller" }]
                : [{ flow_id: 1, name: "Intake routing" }],
            next_cursor: null,
          },
        }),
      );
    // Alpha's list reads after the first are held until released, so one
    // is still in flight when the operator switches to beta.
    let alphaReads = 0,
      staleDelivered = false,
      release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      /\/ui\/v1\/teams\/[0-9]+\/tasks(?:\?.*)?$/,
      async (route) => {
        const team = Number(
          new URL(route.request().url()).pathname.split("/")[4],
        );
        if (team === alpha && alphaReads++ > 0) {
          await held;
          await route.fulfill({
            json: { items: teamTasks.get(alpha), next_cursor: null },
          });
          staleDelivered = true;
          return;
        }
        return route.fulfill({
          json: { items: teamTasks.get(team) ?? [], next_cursor: null },
        });
      },
    );
    await page.route(/\/ui\/v1\/teams\/[0-9]+\/tasks\/.+/, (route) =>
      route.fulfill({ status: 404, json: { code: "not_found" } }),
    );
    const results = page.locator("#results");
    const shown = (team_name: string) =>
      [2, 1].map((id) => ({
        id,
        name: replyName(team_name, id),
        external: `${team_name}-upstream-${id}`.toUpperCase(),
      }));

    await test.step("Tasks of team alpha show alpha's task names", async () => {
      await page.goto(`${proxy.baseUrl}/?view=history&team=${alpha}`);
      await expectTaskCollection(page, results, shown("alpha"), alpha);
    });

    await test.step("Team switch shows beta's task names, never stale alpha rows", async () => {
      await page.getByLabel("Search", { exact: true }).fill("upstream");
      await expect.poll(() => alphaReads).toBeGreaterThan(1);
      await page.getByLabel("Team", { exact: true }).selectOption(String(beta));
      await expectTaskCollection(page, results, shown("beta"), beta);
      release();
      await expect.poll(() => staleDelivered).toBe(true);
      await expectTaskCollection(page, results, shown("beta"), beta);
      await expect(page.locator("main")).not.toContainText("alpha-");
      // The composed form of beta's tasks is never shown.
      for (const id of [1, 2])
        await expect(
          results.getByText(`beta-${id}`, { exact: true }),
        ).toHaveCount(0);
    });

    await test.step("Not-found task detail composes the selected team's name", async () => {
      await page.goto(`${proxy.baseUrl}/?view=task&team=${beta}&id=77`);
      const main = page.locator("main");
      await expect(main).toContainText(/Requested task\s*beta-77/);
      await expect(main).not.toContainText("alpha-77");
    });
  });
