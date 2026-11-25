import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import {
  startFakeGateway,
  stored,
  type FakeGateway,
} from "../fixtures/fake_gateway";

// Survivors of the executor_k8s_openhands Mission Control cases (v0041 D15):
// the Web UI half of each case against the mocked Registry projection. Pod
// environment injection and claim ordering are Executor/Registry tests.

// Shared-host container and trace teardown outlasts the 30s default.
test.describe.configure({ timeout: 120_000 });

let proxy: MockedProxy;
let registry: FakeGateway;
let initial: Pick<FakeGateway, "tasks" | "launchParameters">;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  registry = await startFakeGateway();
  initial = structuredClone({
    tasks: registry.tasks,
    launchParameters: registry.launchParameters,
  });
  proxy = await startMockedProxy(
    [{ team_id: 1, team_name: "alpha" }],
    path.resolve(__dirname, "../../../web/index.html"),
    registry.origin,
  );
});
test.afterAll(async () => {
  test.setTimeout(120_000);
  await proxy?.close();
  await registry?.close();
});

function recordWrites(page: Page) {
  const writes: { method: string; path: string; body: unknown }[] = [];
  page.on("request", (request) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
      new URL(request.url()).pathname.startsWith("/ui/v1/")
    )
      writes.push({
        method: request.method(),
        path: new URL(request.url()).pathname,
        body: request.postData() ? request.postDataJSON() : null,
      });
  });
  return writes;
}

const definitionRow = (page: Page, key: string) =>
  page
    .locator("#definitions tr:visible,#definitions article:visible")
    .filter({ has: page.getByRole("link", { name: key, exact: true }) });

// One test, one step per original check. Every step restores the mocked
// Registry's tasks and launch parameters, starts from a blank document at
// the default viewport and removes its own routes, so no step depends on
// another step's writes or order.
async function isolatedStep(
  page: import("@playwright/test").Page,
  viewport: { width: number; height: number },
  title: string,
  body: () => Promise<void>,
) {
  await test.step(title, async () => {
    registry.tasks.splice(0, Infinity, ...structuredClone(initial.tasks));
    registry.launchParameters.splice(
      0,
      Infinity,
      ...structuredClone(initial.launchParameters),
    );
    await page.goto("about:blank");
    await page.setViewportSize(viewport);
    try {
      await body();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
  });
}

test("v0006.26/.27/.28/.30/.32/.33 K8s Mission Control: pending claim wait, env and secret mutations, live dashboard refresh", async ({
  page,
}) => {
  // Three original cases; the file-level 120 s budget applied to each.
  test.setTimeout(240_000);
  const viewport = page.viewportSize()!;
  await isolatedStep(
    page,
    viewport,
    "v0006.28 a pending task shows the claim wait and no lifecycle events, then its finished timeline",
    async () => {
      // The step restored the fixture, so this is always the fixture's first
      // pending task, never one another check added.
      const pending = registry.tasks.find(
        (task) => task.current_state === "queued",
      )!;
      expect(pending.task_id).toBe(1);
      await page.goto(`${proxy.baseUrl}?view=history&status=queued`);
      const link = page.locator(
        `a.resource-link:visible[href*="view=task&"][data-catalog-id="${pending.task_id}"]`,
      );
      await expect(link).toBeVisible();
      await link.click();
      await expect(
        page.getByText(
          "Waiting for a successful claim. There are no lifecycle events yet.",
        ),
      ).toBeVisible();
      await expect(page.locator(".timeline li")).toHaveCount(0);

      // The task is later claimed and runs to completion.
      const claimedAt = new Date().toISOString();
      Object.assign(pending, {
        current_state: "finished",
        claim_seq: 1,
        executor_id: 7,
        claimed_at: claimedAt,
        completed_at: claimedAt,
      });
      await page.route(
        `**/ui/v1/teams/1/tasks/${pending.task_id}/events?**`,
        (route) =>
          route.fulfill({
            json: {
              items: ["created", "running", "finished"].map((kind, index) =>
                stored(1600 + index, "executor", kind, claimedAt, {
                  team_id: 1,
                  task_id: pending.task_id,
                  attempt: 1,
                  claim_seq: 1,
                  executor_id: 7,
                }),
              ),
              next_cursor: null,
            },
          }),
      );
      await page.reload();
      await expect(
        page.locator("section").filter({
          has: page.getByRole("heading", {
            name: "Execution timeline",
            exact: true,
          }),
        }),
      ).toContainText(/created · .*running · .*finished · /);
      await expect(
        page.getByText(
          "Waiting for a successful claim. There are no lifecycle events yet.",
        ),
      ).toHaveCount(0);
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.26/.27/.32/.33 UI env and secret mutations write and remove exact launch parameters",
    async () => {
      const envKey = "FLOWAI_ENV_K8S",
        envValue = "env-k8s-value",
        secretKey = "FLOWAI_SECRET_K8S",
        secretValue = "secret-k8s-never-rendered";
      const writes = recordWrites(page);
      const consoleText: string[] = [];
      page.on("console", (message) => consoleText.push(message.text()));
      await page.goto(`${proxy.baseUrl}?view=parameters`);
      await page
        .getByRole("button", { name: "Create parameter", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Add variable", exact: true })
        .click();
      await page.locator("#env-dialog").getByLabel("Key name").fill(envKey);
      await page
        .locator("#env-dialog")
        .getByLabel("Value", { exact: true })
        .fill(envValue);
      await page
        .locator("#env-dialog")
        .getByRole("button", { name: "Save variable", exact: true })
        .click();
      await expect(definitionRow(page, envKey)).toContainText(envValue);
      // The team definition already exists, so the variable is merged into it.
      expect(writes).toEqual([
        {
          method: "PUT",
          path: "/ui/v1/teams/1/launch-parameters/1",
          body: {
            scope: "team",
            flow_id: null,
            name: "Team parameters",
            env: { FLOWAI_VISIBLE: "fixture-value", [envKey]: envValue },
          },
        },
      ]);
      const definitionID = new URL(
        (await page
          .getByRole("link", { name: envKey, exact: true })
          .getAttribute("href"))!,
        page.url(),
      ).searchParams.get("id");
      expect(definitionID).toBe("1");

      await page
        .getByRole("button", { name: "Create parameter", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Add secret", exact: true })
        .click();
      await page
        .locator("#secret-dialog")
        .getByLabel("Target definition", { exact: true })
        .selectOption(definitionID!);
      await page
        .locator("#secret-dialog")
        .getByLabel("Key name", { exact: true })
        .fill(secretKey);
      await page
        .locator("#secret-dialog")
        .getByLabel("New secret value")
        .fill(secretValue);
      await page
        .locator("#secret-dialog")
        .getByRole("button", { name: "Save secret" })
        .click();
      await expect(definitionRow(page, secretKey)).toContainText(
        "value hidden",
      );
      await expect(page.getByText(secretValue)).toHaveCount(0);
      expect(writes[1]).toEqual({
        method: "POST",
        path: "/ui/v1/teams/1/launch-parameters/1/secrets",
        body: { key: secretKey, value: secretValue },
      });
      // The write-only value leaves the browser only in that one request.
      expect(
        await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            url: location.href,
            dom: document.documentElement.outerHTML,
          }),
        ),
      ).not.toContain(secretValue);
      expect(consoleText.join("\n")).not.toContain(secretValue);

      await page
        .getByRole("button", { name: `Actions for ${envKey}`, exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Delete variable", exact: true })
        .click();
      await page
        .locator("#parameter-delete-dialog")
        .getByRole("button", { name: "Delete variable", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: envKey, exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: `Actions for ${secretKey}`, exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Delete secret", exact: true })
        .click();
      await page
        .locator("#parameter-delete-dialog")
        .getByRole("button", { name: "Delete secret", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: secretKey, exact: true }),
      ).toHaveCount(0);
      // Removal reaches the Registry projection: neither key remains for a new task.
      const team = registry.launchParameters.find(
        (item) => item.environment_id === 1,
      );
      expect(team.env).toEqual({ FLOWAI_VISIBLE: "fixture-value" });
      expect(team.secrets.map((secret: { key: string }) => secret.key)).toEqual(
        ["FLOWAI_SECRET"],
      );
      expect(
        writes.slice(2).map(({ method, path }) => `${method} ${path}`),
      ).toHaveLength(2);
      expect(writes[2]).toMatchObject({
        path: "/ui/v1/teams/1/launch-parameters/1",
      });
      expect(writes[3]).toMatchObject({
        method: "DELETE",
        path: expect.stringMatching(
          /^\/ui\/v1\/teams\/1\/launch-parameters\/1\/secrets\/[1-9][0-9]*$/,
        ),
      });
    },
  );
  await isolatedStep(
    page,
    viewport,
    "v0006.30 a pushed same-team task frame refreshes the open dashboard once",
    async () => {
      const today = new Date();
      const todayKey = today.toISOString().slice(0, 10);
      const bucketCount = (label: string | null) =>
        Number(label?.match(/: (\d+) runs?; open Tasks$/)?.[1]);
      const total = async () =>
        (
          await page
            .locator("[data-dashboard-date]")
            .evaluateAll((links) =>
              links.map((a) => a.getAttribute("aria-label")),
            )
        ).reduce((sum, label) => sum + bucketCount(label), 0);
      const todayCount = async () =>
        bucketCount(
          await page
            .locator(`[data-dashboard-date="${todayKey}"]`)
            .getAttribute("aria-label"),
        );
      let dashboardReads = 0;
      page.on("request", (request) => {
        if (/\/ui\/v1\/teams\/1\/dashboard/.test(request.url()))
          dashboardReads++;
      });
      await page.goto(proxy.baseUrl);
      await expect(
        page.getByRole("button", { name: "Week", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        page.locator(`[data-dashboard-date="${todayKey}"]`),
      ).toHaveAttribute("aria-label", /runs?; open Tasks$/);
      await expect(page.getByTestId("live-frame")).toHaveAttribute(
        "data-stream-state",
        "connected",
      );
      const totalBefore = await total();
      const todayBefore = await todayCount();
      const readsBefore = dashboardReads;

      // The Registry commits one pending task and fans out one frame for it.
      const taskID = 19;
      registry.tasks.unshift({
        ...registry.tasks.find((task) => task.current_state === "queued")!,
        task_id: taskID,
        task_name: `alpha-${taskID}`,
        external_id: "external-live",
        ingested_at: new Date().toISOString(),
      });
      // A journal task_committed frame for the new queued task.
      const frame = {
        frame_id: 7026,
        frame_type: "task_committed",
        team_id: 1,
        task_id: taskID,
        data: stored(7026, "task-manager", "queued", new Date().toISOString(), {
          team_id: 1,
          task_id: taskID,
          attempt: 1,
        }),
      };
      registry.push(1, frame);
      await expect(page.getByTestId("live-frame")).toContainText(
        String(taskID),
      );
      await expect.poll(total).toBe(totalBefore + 1);
      await expect.poll(todayCount).toBe(todayBefore + 1);
      expect(dashboardReads).toBeGreaterThan(readsBefore);
      // Let the refresh of the first frame settle, then record how many
      // dashboard reads one applied frame causes.
      let settled = -1;
      await expect
        .poll(async () => {
          const reads = dashboardReads;
          await page.waitForTimeout(400);
          const stable = reads === dashboardReads;
          settled = dashboardReads;
          return stable;
        })
        .toBe(true);
      const readsAfter = settled;
      const readsPerFrame = readsAfter - readsBefore;

      // A later distinct frame is applied once: one frame's worth of reads.
      registry.push(1, {
        frame_id: 7027,
        frame_type: "task_committed",
        team_id: 1,
        task_id: taskID,
        data: stored(7027, "task-manager", "queued", new Date().toISOString(), {
          team_id: 1,
          task_id: taskID,
          attempt: 1,
        }),
      });
      await expect(page.getByTestId("live-frame")).toContainText("7027");
      await expect.poll(() => dashboardReads).toBe(readsAfter + readsPerFrame);
      await page.waitForTimeout(750);
      const readsMid = dashboardReads;
      expect(readsMid).toBe(readsAfter + readsPerFrame);

      // A repeated frame for the same committed task is not applied again:
      // the stream applies each frame_id once (v0048), and the dashboard never
      // increments locally. The live-frame shows every received frame, so
      // the duplicate replacing frame 7027 there proves it was delivered.
      registry.push(1, frame);
      await expect(page.getByTestId("live-frame")).not.toContainText("7027");
      await expect(page.getByTestId("live-frame")).toContainText("7026");
      // Longer than the UI's render debounce: a UI that applied the
      // duplicate would read the dashboard again here.
      await page.waitForTimeout(750);
      expect(dashboardReads).toBe(readsMid);
      expect(await total()).toBe(totalBefore + 1);
      expect(await todayCount()).toBe(todayBefore + 1);
    },
  );
});
