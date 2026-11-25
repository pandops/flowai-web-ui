import { expect, test, type Page } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  v0048Proxy,
  MATRIX,
  usePresentation,
  catalogRoutes,
  taskRoutes,
  taskRecord,
  attempt,
  claim,
  event,
  at,
} from "../fixtures/v0048-ui";

// web-ui: Task detail, Launch parameters of an archived task (D43).
// env-registry deletes a task's frozen snapshots when it consumes the task's
// `archived` event, so task-parameters answers `attempt: null` for an
// archived task. The section then says the parameters were removed at
// archive; "not frozen yet" stays for a current task whose attempt has not
// frozen them.
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const ARCHIVED = 1070,
  WAITING = 1071;
const REMOVED = "Launch parameters were removed when this task was archived.";
const NOT_FROZEN = "No launch parameters are frozen for this task yet.";

async function setup(page: Page) {
  await catalogRoutes(page);
  await taskRoutes(page, [
    {
      // Finished and archived: env-registry already deleted its snapshot.
      task: taskRecord(ARCHIVED, {
        current_state: "finished",
        completed_at: at(5),
        archived: true,
        attempts: [
          attempt(1, "finished", [claim(1, 1, 7, 1, { ended_at: at(5) })]),
        ],
      }),
      events: [
        event("created", 1, {
          task_id: ARCHIVED,
          attempt: 1,
          claim_seq: 1,
          executor_id: 7,
        }),
        event("finished", 5, {
          task_id: ARCHIVED,
          attempt: 1,
          claim_seq: 1,
          executor_id: 7,
        }),
        event("archived", 6, { task_id: ARCHIVED }),
      ],
    },
    {
      // Current and pending: its attempt has not opened launch parameters.
      task: taskRecord(WAITING, {
        current_state: "pending",
        executor_id: null,
        claimed_at: null,
        attempts: [attempt(1, "pending", [])],
      }),
      events: [],
    },
  ]);
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 task detail launch parameters of an archived task · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    await setup(page);
    const parameters = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Launch parameters",
        exact: true,
      }),
    });

    await test.step("Archived task says its parameters were removed", async () => {
      await page.goto(
        `${proxy.baseUrl}/?view=task&team=${TEAM}&id=${ARCHIVED}`,
      );
      await expect(parameters).toContainText(REMOVED);
      await expect(parameters).not.toContainText(NOT_FROZEN);
      await expect(parameters).not.toContainText("were supplied");
    });

    await test.step("Current task without a snapshot is not frozen yet", async () => {
      await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=${WAITING}`);
      await expect(parameters).toContainText(NOT_FROZEN);
      await expect(parameters).not.toContainText(REMOVED);
    });
  });
