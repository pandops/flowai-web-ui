import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  catalogRoutes,
  executorRecord,
  executorRoutes,
  recordRequests,
  v0048Proxy,
  type ExecutorFake,
  type Recorded,
  MATRIX,
  usePresentation,
  expectNoHorizontalScroll,
} from "../fixtures/v0048-ui";

// web-ui: Web UI manages team Executors and their one-time NATS tokens.
// Behavior tests run at the supported desktop resolution (1440 x 900);
// the matrix tests below set each supported resolution themselves.
test.use({ actionTimeout: 10_000, viewport: { width: 1440, height: 900 } });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const fake = (): ExecutorFake => ({
  records: [
    executorRecord(7),
    executorRecord(8, { executor_type: "executor_k8s_openhands" }),
  ],
  states: [],
  events: new Map(),
  tasks: new Map(),
});

const writes = (requests: Recorded[]) =>
  requests.filter((request) => request.method !== "GET");

async function setup(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await catalogRoutes(page);
  const executors = fake();
  await executorRoutes(page, executors);
  const requests = recordRequests(page);
  return { executors, requests };
}

async function openCreate(page: Page) {
  await page.goto(`${proxy.baseUrl}/?view=executors&team=${TEAM}`);
  await page
    .getByRole("button", { name: "Create Executor", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Create Executor" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const tokenHeading = (page: Page, id: number) =>
  page.getByRole("heading", {
    name: `One-time token for Executor ${id}`,
    exact: true,
  });

/** No token is kept anywhere the browser could show it again. */
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

test("v0048 operator creates an Executor with only tag and type and sees its token once · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { requests, executors } = await setup(page);

  const createDialog = () =>
    page.getByRole("dialog").filter({
      has: page.getByLabel("Execution tag", { exact: true }),
    });

  await test.step("Create form asks only for tag and type", async () => {
    const dialog = await openCreate(page);
    const fields = dialog.locator(
      "input:visible,select:visible,textarea:visible",
    );
    await expect(fields).toHaveCount(2);
    await expect(
      dialog.getByLabel("Execution tag", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel("Executor type", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByLabel(/name|identifier|ID/i)).toHaveCount(0);
  });

  await test.step("Create form has no scope choice", async () => {
    const dialog = createDialog();
    await expect(dialog).not.toContainText(/scope|system|team-wide|global/i);
    await expect(dialog.getByRole("radio")).toHaveCount(0);
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    await expect(dialog.getByLabel(/scope|team|owner/i)).toHaveCount(0);
    await dialog.getByLabel("Execution tag", { exact: true }).fill("gpu");
    await dialog
      .getByLabel("Executor type", { exact: true })
      .selectOption("executor_k8s_openhands");
    await dialog
      .getByRole("button", { name: "Create Executor", exact: true })
      .click();
    await expect(tokenHeading(page, 13)).toBeVisible();
    const creates = writes(requests);
    expect(creates).toHaveLength(1);
    expect(creates[0].path).toBe(`/ui/v1/teams/${TEAM}/executors`);
    expect(creates[0].body).toEqual({
      execution_tag: "gpu",
      executor_type: "executor_k8s_openhands",
    });
  });

  await test.step("Token view shows the start command of the Executor type (k8s)", async () => {
    const view = page.locator("main");
    await expect(view).toContainText("Executor ID 13");
    await expect(view).toContainText(
      "Copy this token now. It cannot be shown again.",
    );
    await expect(view).toContainText(
      "Pass it to the Executor's Helm release at its first install.",
    );
    await expect(view).toContainText(
      "helm upgrade --install … --set broker.token=jwt-created-token",
    );
    await expect(view).toContainText(
      "The chart stores the token in a Kubernetes Secret.",
    );
    await view.getByRole("button", { name: "Copy", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "jwt-created-token",
    );
    expect(page.url()).not.toContain("jwt-created-token");
  });

  await test.step("Copy failure does not claim success", async () => {
    await page.evaluate(() => {
      navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
    });
    await page
      .locator("main")
      .getByRole("button", { name: "Copy", exact: true })
      .click();
    await expect(page.locator("main")).not.toContainText(/copied/i);
  });

  await test.step("Operator creates an Executor: the token is gone after closing", async () => {
    await page
      .getByRole("button", { name: "Close and clear", exact: true })
      .click();
    await expect(tokenHeading(page, 13)).toHaveCount(0);
    await expectTokenGone(page, "jwt-created-token");
    // Create form has no scope choice: it is listed in the current team.
    await expect(
      page.locator("#results").getByRole("link", { name: "13", exact: true }),
    ).toBeVisible();
    // Back returns to the inventory that showed the token.
    await page
      .locator("#results")
      .getByRole("link", { name: "13", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Executor 13", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/view=executors/);
    await expectTokenGone(page, "jwt-created-token");
    await page.reload();
    await expectTokenGone(page, "jwt-created-token");
    await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=13`);
    await expect(
      page.getByRole("heading", { name: "Executor 13", exact: true }),
    ).toBeVisible();
    await expectTokenGone(page, "jwt-created-token");
    expect(executors.records.map((record) => record.team_id)).toEqual([
      TEAM,
      TEAM,
      TEAM,
    ]);
  });

  await test.step("Token view shows the start command of the Executor type (docker)", async () => {
    const dialog = await openCreate(page);
    await dialog.getByLabel("Execution tag", { exact: true }).fill("openhands");
    await dialog
      .getByLabel("Executor type", { exact: true })
      .selectOption("executor_docker_openhands");
    await dialog
      .getByRole("button", { name: "Create Executor", exact: true })
      .click();
    await expect(tokenHeading(page, 14)).toBeVisible();
    const view = page.locator("main");
    await expect(view).toContainText(
      "Pass it to the Executor with --token at its first start.",
    );
    await expect(view).toContainText(
      "executor_docker_openhands --token jwt-created-token",
    );
    await expect(view).not.toContainText("helm upgrade");
  });
});

test("v0048 operator reissues an Executor token after confirmation · Web UI unit", async ({
  page,
}) => {
  const { requests } = await setup(page);
  await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=8`);
  await expect(
    page.getByRole("heading", { name: "Executor 8", exact: true }),
  ).toBeVisible();

  await test.step("Operator reissues a token", async () => {
    await page
      .getByRole("button", { name: "Reissue token", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Reissue token" });
    await expect(dialog).toContainText("The current token stops working now");
    await expect(dialog).toContainText("connection is closed");
    await expect(dialog).toContainText("released and queued again");
    await expect(dialog).toContainText(
      "Restart the Executor with the new token to reconnect.",
    );
    // No promise that running agents continue.
    await expect(dialog).not.toContainText(/continue|keeps? running/i);
    expect(writes(requests)).toEqual([]);
    await dialog
      .getByRole("button", { name: "Reissue token", exact: true })
      .click();
    await expect(tokenHeading(page, 8)).toBeVisible();
    const sent = writes(requests);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "POST",
      path: `/ui/v1/teams/${TEAM}/executors/8/token`,
    });
    await expect(page.locator("main")).toContainText(
      "helm upgrade --install … --set broker.token=jwt-reissued-8",
    );
    await page
      .getByRole("button", { name: "Close and clear", exact: true })
      .click();
    await expectTokenGone(page, "jwt-reissued-8");
  });
});

test("v0048 operator deletes an Executor by typing its decimal ID · Web UI unit", async ({
  page,
}) => {
  const { requests } = await setup(page);
  await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=7`);

  await test.step("Operator deletes an Executor", async () => {
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Delete Executor 7?" });
    await expect(dialog).toContainText("Its token is revoked");
    await expect(dialog).toContainText("it can no longer connect");
    const confirm = dialog.getByRole("button", {
      name: "Delete Executor",
      exact: true,
    });
    const field = dialog.getByLabel("Type 7 to confirm", { exact: true });
    for (const value of ["", "07", "8", " 7"]) {
      await field.fill(value);
      await expect(
        confirm,
        `confirm with ${JSON.stringify(value)}`,
      ).toBeDisabled();
    }
    await field.fill("7");
    await expect(confirm).toBeEnabled();
    expect(writes(requests)).toEqual([]);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    const sent = writes(requests);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "DELETE",
      path: `/ui/v1/teams/${TEAM}/executors/7`,
    });
    await page.goto(`${proxy.baseUrl}/?view=executors&team=${TEAM}`);
    await expect(
      page.locator("#results").getByRole("link", { name: "8", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("#results").getByRole("link", { name: "7", exact: true }),
    ).toHaveCount(0);
  });
});

test("v0048 Executor create dialog and token view at every supported resolution and theme · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await setup(page);
  for (const { theme, width, height } of MATRIX)
    await test.step(`${theme} ${width}`, async () => {
      await usePresentation(page, theme, { width, height });
      const dialog = await openCreate(page);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await dialog
        .getByLabel("Execution tag", { exact: true })
        .fill("openhands");
      await dialog
        .getByRole("button", { name: "Create Executor", exact: true })
        .click();
      await expect(
        page.getByRole("heading", {
          name: /^One-time token for Executor \d+$/,
        }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page
        .getByRole("button", { name: "Close and clear", exact: true })
        .click();
    });
});
