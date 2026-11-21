import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  captureStreams,
  catalogRoutes,
  event,
  executorRecord,
  executorRoutes,
  recordRequests,
  v0048Proxy,
  type ExecutorFake,
  type Recorded,
} from "../fixtures/v0048-ui";

// web-ui: the one-time token view survives the team's live updates. Another
// Executor of the team (or a task) changing while the operator creates an
// Executor or reissues a token re-renders the Executors page; the token the
// operator sees only once must stay until Close and clear or leaving the
// page, and must still never be stored or read again.
test.use({ actionTimeout: 10_000, viewport: { width: 1440, height: 900 } });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const tokenHeading = (page: Page, id: number) =>
  page.getByRole("heading", {
    name: `One-time token for Executor ${id}`,
    exact: true,
  });

async function expectTokenGone(page: Page, token: string) {
  await expect(page.locator("body")).not.toContainText(token);
  expect(page.url()).not.toContain(token);
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
        history: history.state,
      }),
    ),
  ).not.toContain(token);
}

const k8sCommand =
  "helmfile -f .helmfile/executor.helmfile.yaml.gotmpl -e dtu --state-values-file executor.yaml apply";

async function expectKubernetesToken(page: Page, token: string) {
  const view = page.locator("[data-executor-token]");
  await expect(view.locator("[data-token-value]")).toHaveText(token);
  await expect(view.locator("[data-token-command]")).toHaveText(k8sCommand);
}

const reads = (requests: Recorded[], path: string) =>
  requests.filter((r) => r.method === "GET" && r.path === path).length;

async function setup(page: Page) {
  await catalogRoutes(page);
  const executors: ExecutorFake = {
    records: [
      executorRecord(7),
      executorRecord(8, { executor_type: "executor_k8s_openhands" }),
    ],
    states: [],
    events: new Map(),
    tasks: new Map(),
  };
  await executorRoutes(page, executors);
  const requests = recordRequests(page);
  const stream = await captureStreams(page);
  return { executors, requests, stream };
}

/** Holds the next matching POST until release() so frames arrive first. */
async function holdPost(page: Page, url: RegExp) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let seen!: () => void;
  const sent = new Promise<void>((resolve) => (seen = resolve));
  await page.route(url, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    seen();
    await gate;
    await route.fallback();
  });
  return { sent, release };
}

/** Another Executor's frames and a task frame, as a parallel lane sends them. */
async function otherTeamActivity(
  stream: Awaited<ReturnType<typeof setup>>["stream"],
  removed?: number,
) {
  await stream.send(
    event(
      "executor_status",
      1,
      { executor_id: 7 },
      {
        connection_state: "connected",
        held_claims: 1,
        available_capacity: 0,
      },
    ),
  );
  await stream.send(
    event("running", 1, {
      task_id: 16,
      attempt: 1,
      claim_seq: 1,
      executor_id: 7,
    }),
  );
  if (removed)
    await stream.send(event("executor_removed", 1, { executor_id: removed }));
}

test("v0048 one-time token view survives other Executors' live updates until Close and clear · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { requests, stream } = await setup(page);
  const list = `/ui/v1/teams/${TEAM}/executors`;
  await page.goto(`${proxy.baseUrl}/?view=executors&team=${TEAM}`);
  await expect(
    page.locator("#results").getByRole("link", { name: "8", exact: true }),
  ).toBeVisible();

  await test.step("Frames that arrive while Create is pending do not drop the token", async () => {
    const post = await holdPost(
      page,
      new RegExp(`/ui/v1/teams/${TEAM}/executors$`),
    );
    await page
      .getByRole("button", { name: "Create Executor", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Create Executor" });
    await dialog.getByLabel("Execution tag", { exact: true }).fill("k8s-lane");
    await dialog
      .getByLabel("Executor type", { exact: true })
      .selectOption("executor_k8s_openhands");
    const before = reads(requests, list);
    await dialog
      .getByRole("button", { name: "Create Executor", exact: true })
      .click();
    await post.sent;
    // Executor 13's own registration and another lane's Executor and task.
    await stream.send(event("executor_registered", 1, { executor_id: 13 }));
    await otherTeamActivity(stream);
    await expect.poll(() => reads(requests, list)).toBeGreaterThan(before);
    post.release();
    await expect(tokenHeading(page, 13)).toBeVisible();
    await expectKubernetesToken(page, "jwt-created-token");
  });

  await test.step("Frames after the token view renders keep it open and unchanged", async () => {
    const before = reads(requests, list);
    await otherTeamActivity(stream, 8);
    await expect.poll(() => reads(requests, list)).toBeGreaterThan(before);
    // Let every scheduled re-render finish before checking.
    await page.waitForTimeout(500);
    await expect(tokenHeading(page, 13)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Executor token",
    );
    await expectKubernetesToken(page, "jwt-created-token");
    await expect(page.locator(".executor-filters")).toBeHidden();
    // Exactly one create, and the token was never fetched again.
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  await test.step("Close and clear ends the token view; later frames do not bring it back", async () => {
    await page
      .getByRole("button", { name: "Close and clear", exact: true })
      .click();
    await expect(tokenHeading(page, 13)).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Executors",
    );
    const before = reads(requests, list);
    await stream.send(event("executor_removed", 2, { executor_id: 7 }));
    await expect.poll(() => reads(requests, list)).toBeGreaterThan(before);
    await page.waitForTimeout(500);
    await expect(
      page.locator("#results").getByRole("link", { name: "13", exact: true }),
    ).toBeVisible();
    await expectTokenGone(page, "jwt-created-token");
  });

  await test.step("Leaving the page ends the token view", async () => {
    await page
      .getByRole("button", { name: "Create Executor", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Create Executor" });
    await dialog
      .getByLabel("Execution tag", { exact: true })
      .fill("docker-lane");
    await dialog
      .getByRole("button", { name: "Create Executor", exact: true })
      .click();
    await expect(tokenHeading(page, 14)).toBeVisible();
    await page.locator('.nav-links [data-view="flows"]').first().click();
    await expect(page).toHaveURL(/view=flows/);
    await page.goBack();
    await expect(page).toHaveURL(/view=executors/);
    await expect(
      page.locator("#results").getByRole("link", { name: "14", exact: true }),
    ).toBeVisible();
    await stream.send(event("executor_removed", 3, { executor_id: 13 }));
    await page.waitForTimeout(500);
    await expect(tokenHeading(page, 14)).toHaveCount(0);
    await expectTokenGone(page, "jwt-created-token");
  });
});

test("v0048 reissued token view survives live updates on Executor detail · Web UI unit", async ({
  page,
}) => {
  const { requests, stream } = await setup(page);
  const detail = `/ui/v1/teams/${TEAM}/executors/8`;
  await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=8`);
  await expect(
    page.getByRole("heading", { name: "Executor 8", exact: true }),
  ).toBeVisible();

  const reissue = async () => {
    await page
      .getByRole("button", { name: "Reissue token", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Reissue token" })
      .getByRole("button", { name: "Reissue token", exact: true })
      .click();
  };
  const posts = () => requests.filter((r) => r.method === "POST").length;

  await test.step("Frames after the reissued token view renders keep it open", async () => {
    await reissue();
    await expect(tokenHeading(page, 8)).toBeVisible();
    const before = reads(requests, detail);
    await otherTeamActivity(stream);
    await stream.send(event("executor_registered", 1, { executor_id: 13 }));
    await expect.poll(() => reads(requests, detail)).toBeGreaterThan(before);
    await page.waitForTimeout(500);
    await expect(tokenHeading(page, 8)).toBeVisible();
    await expectKubernetesToken(page, "jwt-reissued-8");
    expect(posts()).toBe(1);
    await page
      .getByRole("button", { name: "Close and clear", exact: true })
      .click();
    await expectTokenGone(page, "jwt-reissued-8");
  });

  await test.step("Frames while Reissue is pending do not drop the token", async () => {
    const post = await holdPost(
      page,
      new RegExp(`/ui/v1/teams/${TEAM}/executors/8/token$`),
    );
    const before = reads(requests, detail);
    await reissue();
    await post.sent;
    await otherTeamActivity(stream, 7);
    await expect.poll(() => reads(requests, detail)).toBeGreaterThan(before);
    post.release();
    await expect(tokenHeading(page, 8)).toBeVisible();
    await expectKubernetesToken(page, "jwt-reissued-8");
    expect(posts()).toBe(2);
    await page
      .getByRole("button", { name: "Close and clear", exact: true })
      .click();
    await expectTokenGone(page, "jwt-reissued-8");
  });
});
