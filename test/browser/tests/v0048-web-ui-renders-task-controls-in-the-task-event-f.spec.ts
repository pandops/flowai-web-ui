import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  attempt,
  captureStreams,
  catalogRoutes,
  claim,
  event,
  recordRequests,
  taskRecord,
  taskRoutes,
  v0048Proxy,
  type TaskFake,
  MATRIX,
  usePresentation,
} from "../fixtures/v0048-ui";

// web-ui: Web UI renders task controls in the task event feed (v0048).
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const k = (
  task_id: number,
  executor_id: number | null,
  control_id?: number,
) => ({
  task_id,
  attempt: 1,
  claim_seq: executor_id ? 1 : null,
  executor_id,
  control_id: control_id ?? null,
});

const running = (task_id: number, executor_id: number): TaskFake => ({
  task: taskRecord(task_id, {
    executor_id,
    attempts: [attempt(1, "running", [claim(1, 1, executor_id, 1)])],
  }),
  events: [
    event("created", 1, k(task_id, executor_id)),
    event("running", 2, k(task_id, executor_id)),
  ],
});

/** Opens the task, confirms Cancel task and replies with `reply`. */
async function cancel(
  page: Page,
  fake: TaskFake,
  reply: { status: number; json: Record<string, unknown> },
) {
  const stream = await captureStreams(page);
  await catalogRoutes(page);
  await taskRoutes(page, [fake]);
  await page.route(
    `**/ui/v1/teams/${TEAM}/tasks/${fake.task.task_id}/controls/cancel`,
    (route) => route.fulfill(reply),
  );
  const requests = recordRequests(page);
  await page.goto(
    `${proxy.baseUrl}/?view=task&team=${TEAM}&id=${fake.task.task_id}`,
  );
  // While pending, the same control reads "Cancellation requested".
  const button = page
    .locator("main")
    .getByRole("button", { name: /^(Cancel task|Cancellation requested)$/ });
  await button.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel task", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const posts = requests.filter((request) => request.method === "POST");
  expect(posts).toHaveLength(1);
  const timeline = page
    .locator("section,div")
    .filter({
      has: page.getByRole("heading", {
        name: "Execution timeline",
        exact: true,
      }),
    })
    .last();
  const status = page
    .locator("main div,main tr")
    .filter({ has: page.locator("dt,th").getByText("Status", { exact: true }) })
    .last();
  return { stream, button, timeline, status };
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 operator cancels a running task · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    const fake = running(1030, 7);
    const { stream, button, timeline, status } = await cancel(page, fake, {
      status: 202,
      json: {
        task_id: 1030,
        control_id: 41,
        control: "cancel",
        status: "requested",
      },
    });
    await test.step("Operator cancels a running task", async () => {
      await expect(button).toBeDisabled();
      await stream.send(
        event("control_requested", 3, k(1030, 7, 41), { control: "cancel" }),
      );
      await expect(timeline).toContainText("control_requested");
      await stream.send(
        event("control_acknowledged", 4, k(1030, 7, 41), { control: "cancel" }),
      );
      await expect(button).toBeDisabled();
      fake.task.current_state = "cancelled";
      await stream.send(event("cancelled", 5, k(1030, 7)));
      await expect(timeline).toContainText("cancelled");
      const text = await timeline.innerText();
      expect(text.indexOf("control_requested")).toBeLessThan(
        text.lastIndexOf("cancelled"),
      );
      await expect(status).toContainText(/cancelled/i);
      await expect(button).toHaveCount(0);
    });
  });

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 operator cancels a task of a deleted Executor · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    const fake = running(1031, 9);
    const { stream, timeline, status } = await cancel(page, fake, {
      status: 200,
      json: {
        task_id: 1031,
        control_id: 42,
        control: "cancel",
        status: "cancelled",
      },
    });
    await test.step("Operator cancels a task of a deleted Executor", async () => {
      await stream.send(
        event("control_requested", 3, k(1031, 9, 42), { control: "cancel" }),
      );
      fake.task.current_state = "cancelled";
      await stream.send(
        event("cancelled", 4, { ...k(1031, 9, 42), publisher: "task-manager" }),
      );
      await expect(timeline).toContainText("control_requested");
      await expect(timeline).toContainText("cancelled");
      await expect(timeline).not.toContainText("control_acknowledged");
      // Matched by control_id: the control is shown applied, not pending.
      await expect(timeline).not.toContainText(/not applied|pending/i);
      await expect(status).toContainText(/cancelled/i);
    });
  });

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 cancellation that does not take effect is shown not applied · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    const fake = running(1032, 7);
    const { stream, button, timeline, status } = await cancel(page, fake, {
      status: 202,
      json: {
        task_id: 1032,
        control_id: 43,
        control: "cancel",
        status: "requested",
      },
    });
    await test.step("Cancellation processing fails", async () => {
      await stream.send(
        event("control_requested", 3, k(1032, 7, 43), { control: "cancel" }),
      );
      fake.task.current_state = "finished";
      await stream.send(event("finished", 4, k(1032, 7)));
      await stream.send(
        event("control_failed", 5, k(1032, 7, 43), {
          control: "cancel",
          failure_reason: "task_terminal",
        }),
      );
      await expect(timeline).toContainText("finished");
      await expect(timeline).toContainText(/not applied/i);
      await expect(status).toContainText(/finished/i);
      await expect(button).toHaveCount(0);
    });
  });

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0050 cancel dialog names the task · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    // The reply's task_name differs from `<team_name>-<task_id>` on purpose:
    // the dialogs show the reply's name, the request keeps the integer.
    const fake = running(1033, 7);
    fake.task.task_name = "ops-7033";
    await catalogRoutes(page);
    await taskRoutes(page, [fake]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      `**/ui/v1/teams/${TEAM}/tasks/*/controls/cancel`,
      async (route) => {
        await held;
        await route.fulfill({ status: 500, json: { code: "internal" } });
      },
    );
    const requests = recordRequests(page);
    await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=1033`);
    const dialog = page.getByRole("dialog");
    const noBareID = async () =>
      expect(
        (await dialog.innerText()).split("ops-7033").join(" "),
      ).not.toMatch(/(^|\D)1033(\D|$)/);

    await test.step("Confirm dialog names the task", async () => {
      await page
        .locator("main")
        .getByRole("button", { name: "Cancel task", exact: true })
        .click();
      await expect(dialog).toContainText("Task ops-7033 is Running.");
      await noBareID();
    });

    await test.step("Pending dialog names the task", async () => {
      await dialog
        .getByRole("button", { name: "Cancel task", exact: true })
        .click();
      await expect(
        dialog.getByRole("heading", {
          name: "Cancel task request pending",
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog).toContainText(
        "One cancellation request for ops-7033 is in flight.",
      );
      await noBareID();
      // The request path keeps the integer task ID.
      await expect
        .poll(() =>
          requests
            .filter((request) => request.method === "POST")
            .map((request) => request.path),
        )
        .toEqual([`/ui/v1/teams/${TEAM}/tasks/1033/controls/cancel`]);
    });

    await test.step("Failed dialog names the task", async () => {
      release();
      await expect(
        dialog.getByRole("heading", {
          name: "Cancel task request failed",
          exact: true,
        }),
      ).toBeVisible();
      await expect(dialog).toContainText(
        "The cancellation control for ops-7033 failed.",
      );
      await noBareID();
      expect(
        requests.filter((request) => request.method === "POST"),
      ).toHaveLength(1);
    });
  });
