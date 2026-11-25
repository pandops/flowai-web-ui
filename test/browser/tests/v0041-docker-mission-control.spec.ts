import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import {
  startFakeGateway,
  stored,
  type FakeGateway,
} from "../fixtures/fake_gateway";

// Survivor of state-registry contracts/12-v0005-real-docker-runtime-smoke
// (v0041 D15): the Mission Control views of a Docker OpenHands run against the
// mocked Registry. Container environment, marker and claim order belong to
// Executor/Registry tests; the parameter UI is in v0041-k8s-mission-control.

// Shared-host container and trace teardown outlasts the 30s default.
test.describe.configure({ timeout: 120_000 });

let proxy: MockedProxy;
let registry: FakeGateway;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  registry = await startFakeGateway();
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

test("v0005.4 / v0006.23-.25/.31 Docker OpenHands run streams reasoning and work, then shows its finished timeline and executor", async ({
  page,
}) => {
  const taskID = 3;
  await page.goto(`${proxy.baseUrl}?view=task&id=${taskID}`);
  await expect(
    page.getByRole("heading", { name: `alpha-${taskID}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("live-frame")).toHaveAttribute(
    "data-stream-state",
    "connected",
  );
  const reasoning = page
    .locator(".log-line.reasoning")
    .filter({ hasText: "Проверяю рабочее дерево" });
  const marker = page
    .locator(".log-line.work")
    .filter({ hasText: "flowai-real-runtime.marker" });
  const complete = page
    .locator(".log-line.work")
    .filter({ hasText: "Task complete." });
  await expect(reasoning).toHaveCount(0);
  // A journal frame: frame_id is the stored log entry's event_id.
  const frame = (offset: number, stream: string, text: string) => ({
    frame_id: 6000 + offset,
    frame_type: "task_log",
    team_id: 1,
    task_id: taskID,
    data: {
      event_id: 6000 + offset,
      task_id: taskID,
      attempt: 1,
      claim_seq: 1,
      executor_id: 7,
      log_offset: offset,
      stream,
      text,
      publisher_seq: 6000 + offset,
      occurred_at: new Date().toISOString(),
    },
  });
  registry.push(1, frame(10, "reasoning", "Проверяю рабочее дерево"));
  await expect(reasoning).toHaveCount(1);
  registry.push(
    1,
    frame(11, "work", "wrote /workspace/project/flowai-real-runtime.marker"),
  );
  registry.push(1, frame(12, "work", "Task complete."));
  await expect(marker).toHaveCount(1);
  await expect(complete).toHaveCount(1);
  // A frame for another task never reaches this task's output.
  const other = frame(13, "work", "other task output");
  registry.push(1, {
    ...other,
    task_id: 7016,
    data: { ...other.data, task_id: 7016 },
  });
  await page.waitForTimeout(500);
  // (The raw live-frame diagnostic shows every frame; the task log does not.)
  await expect(page.getByTestId("live-frame")).toContainText(
    "other task output",
  );
  await expect(
    page.locator("[data-log]").getByText("other task output"),
  ).toHaveCount(0);

  // The Registry finishes the run: created, running, finished.
  const task = registry.tasks.find((item) => item.task_id === taskID)!;
  await page.route(`**/ui/v1/teams/1/tasks/${taskID}/events?**`, (route) =>
    route.fulfill({
      json: {
        items: ["created", "running", "finished"].map((kind, index) =>
          stored(1500 + index, "executor", kind, task.claimed_at!, {
            team_id: 1,
            task_id: taskID,
            attempt: 1,
            claim_seq: 1,
            executor_id: 7,
          }),
        ),
        next_cursor: null,
      },
    }),
  );
  await page.goto(`${proxy.baseUrl}?view=executors`);
  await expect(page.getByRole("combobox", { name: "Team" })).toHaveValue("1");
  await expect(
    page.locator("#results").getByRole("link", { name: "7", exact: true }),
  ).toBeVisible();
  await page.goto(`${proxy.baseUrl}?view=history&search=${taskID}`);
  await page
    .locator(
      `a.resource-link:visible[href*="view=task&"][data-catalog-id="${taskID}"]`,
    )
    .click();
  await expect(
    page.getByRole("link", { name: "Executor 7", exact: true }).first(),
  ).toBeVisible();
  const timeline = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Execution timeline", exact: true }),
  });
  const order = /created · .*running · .*finished · /;
  await expect(timeline).toContainText(order);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: `alpha-${taskID}`, exact: true }),
  ).toBeVisible();
  await expect(timeline).toContainText(order);
  await page.goto(`${proxy.baseUrl}?view=executor&id=7`);
  await expect(
    page.getByRole("heading", { name: "Executor detail", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("executor_docker_openhands")).toBeVisible();
});
