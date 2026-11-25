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
  MATRIX,
  usePresentation,
} from "../fixtures/v0048-ui";

// web-ui: Web UI handles identifiers as integers (v0048).
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const task = () => ({
  task: taskRecord(1010, {
    attempts: [attempt(1, "running", [claim(1, 1, 7, 1)])],
  }),
  events: [
    event("created", 1, {
      task_id: 1010,
      attempt: 1,
      claim_seq: 1,
      executor_id: 7,
    }),
  ],
});

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 task routes carry decimal identifiers and reject others · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    await catalogRoutes(page);
    await taskRoutes(page, [task()]);
    const requests = recordRequests(page);

    await test.step("Task route uses an integer identifier", async () => {
      await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=1010`);
      await expect(
        page.getByRole("heading", { name: "Execution timeline", exact: true }),
      ).toBeVisible();
      expect(new URL(page.url()).searchParams.get("id")).toBe("1010");
      expect(requests.map((request) => request.path)).toContain(
        `/ui/v1/teams/${TEAM}/tasks/1010`,
      );
      // The team in every team path is the decimal team_id.
      for (const request of requests.filter((item) =>
        item.path.startsWith("/ui/v1/teams/"),
      ))
        expect(request.path).toMatch(/^\/ui\/v1\/teams\/3\//);
    });

    await test.step("Non-integer route identifier", async () => {
      for (const id of ["abc", "0", "07", "-4", "1.5"]) {
        requests.length = 0;
        await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=${id}`);
        await expect(
          page.getByRole("heading", { name: "Task not found", exact: true }),
          `route id ${id}`,
        ).toBeVisible();
        expect(
          requests.filter((request) => /\/tasks\//.test(request.path)),
          `route id ${id} sends no task request`,
        ).toEqual([]);
      }
      requests.length = 0;
      await page.goto(`${proxy.baseUrl}/?view=executor&team=${TEAM}&id=abc`);
      await expect(
        page.getByRole("heading", { name: "Executor not found", exact: true }),
      ).toBeVisible();
      expect(
        requests.filter((request) => /\/executors\//.test(request.path)),
      ).toEqual([]);
    });
  });

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 team stream resumes by frame identifier · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    const stream = await captureStreams(page);
    await catalogRoutes(page);
    await taskRoutes(page, [task()]);
    await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=1010`);
    await expect(
      page.getByRole("heading", { name: "Execution timeline", exact: true }),
    ).toBeVisible();

    await test.step("Team stream resumes by frame identifier", async () => {
      const running = {
        ...event("running", 2, {
          task_id: 1010,
          attempt: 1,
          claim_seq: 1,
          executor_id: 7,
        }),
        event_id: 5120,
      };
      await stream.send(running);
      await expect(page.locator("main")).toContainText("running");
      const opened = stream.streams.length;
      stream.streams.at(-1)!.close({ code: 1011, reason: "drop" });
      await expect
        .poll(() => stream.streams.length, { timeout: 20_000 })
        .toBeGreaterThan(opened);
      const query = stream.urls.at(-1)!.searchParams;
      expect([...query.keys()]).toEqual(["after_frame_id"]);
      expect(query.get("after_frame_id")).toBe("5120");
      // A replayed frame and the later frame are each rendered once.
      await stream.send(running);
      const finished = {
        ...event("finished", 9, {
          task_id: 1010,
          attempt: 1,
          claim_seq: 1,
          executor_id: 7,
        }),
        event_id: 5121,
      };
      await stream.send(finished);
      const timeline = page
        .locator("section,div")
        .filter({
          has: page.getByRole("heading", {
            name: "Execution timeline",
            exact: true,
          }),
        })
        .last();
      await expect(timeline).toContainText("finished");
      await expect(
        timeline.locator(`time[datetime="${running.occurred_at}"]`),
      ).toHaveCount(1);
      await expect(
        timeline.locator(`time[datetime="${finished.occurred_at}"]`),
      ).toHaveCount(1);
    });
  });
