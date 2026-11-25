import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  TEAM_NAME,
  at,
  attempt,
  captureStreams,
  catalogRoutes,
  claim,
  event,
  taskRecord,
  taskRoutes,
  v0048Proxy,
  type TaskFake,
  MATRIX,
  usePresentation,
  expectNoHorizontalScroll,
} from "../fixtures/v0048-ui";

// web-ui: Web UI shows task attempts and claim reasons (v0048).
// Behavior tests run at the supported desktop resolution (1440 x 900);
// the matrix tests below set each supported resolution themselves.
test.use({ actionTimeout: 10_000, viewport: { width: 1440, height: 900 } });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const keys = (
  task_id: number,
  a: number,
  c: number | null,
  executor_id: number | null,
) => ({
  task_id,
  attempt: a,
  claim_seq: c,
  executor_id,
});

/** One task released by `reason` from its only claim and queued again. */
function released(task_id: number, reason: string): TaskFake {
  return {
    task: taskRecord(task_id, {
      current_state: "queued",
      executor_id: null,
      claimed_at: null,
      attempts: [
        attempt(1, "queued", [
          claim(1, 1, 7, 1, { released_reason: reason, ended_at: at(9) }),
        ]),
      ],
    }),
    events: [
      event("created", 1, keys(task_id, 1, 1, 7)),
      event("running", 2, keys(task_id, 1, 1, 7)),
      event("released", 9, keys(task_id, 1, 1, 7), { reason }),
    ],
  };
}

const TASKS: TaskFake[] = [
  // Released after the pending limit, then claimed again by Executor 8.
  {
    task: taskRecord(1001, {
      current_state: "created",
      claim_seq: 2,
      executor_id: 8,
      attempts: [
        attempt(1, "created", [
          claim(1, 1, 7, 1, {
            pending_reasons: ["budget_exhausted", "all_selected_models_paused"],
            released_reason: "pending_timeout",
            ended_at: at(16),
          }),
          claim(1, 2, 8, 22),
        ]),
      ],
    }),
    events: [
      event("created", 1, keys(1001, 1, 1, 7)),
      event("pending", 2, keys(1001, 1, 1, 7), { reason: "budget_exhausted" }),
      // The reason code model-registry and the Executor send (spec web-ui).
      event("pending", 3, keys(1001, 1, 1, 7), {
        reason: "all_selected_models_paused",
      }),
      event("released", 16, keys(1001, 1, 1, 7), { reason: "pending_timeout" }),
      event("created", 22, keys(1001, 1, 2, 8)),
    ],
  },
  // A retryable failure; attempt 2 is queued.
  {
    task: taskRecord(1002, {
      current_state: "queued",
      attempt: 2,
      executor_id: null,
      claimed_at: null,
      attempts: [
        attempt(
          1,
          "failed",
          [claim(1, 1, 7, 1, { ended_at: at(8) })],
          "agent_error",
          true,
        ),
        attempt(2, "queued", []),
      ],
    }),
    events: [
      event("created", 1, keys(1002, 1, 1, 7)),
      event("running", 2, keys(1002, 1, 1, 7)),
      event("failed", 8, keys(1002, 1, 1, 7), {
        failure_reason: "agent_error",
        retryable: true,
      }),
      event("retry_scheduled", 8, keys(1002, 1, null, null), {
        next_attempt: 2,
        due_at: at(9),
        failure_reason: "agent_error",
      }),
    ],
  },
  // The Executor's connection drops and comes back while it runs the task.
  {
    task: taskRecord(1003, {
      attempts: [attempt(1, "running", [claim(1, 1, 7, 1)])],
    }),
    events: [
      event("created", 1, keys(1003, 1, 1, 7)),
      event("running", 2, keys(1003, 1, 1, 7)),
      event("connection_lost", 5, keys(1003, 1, 1, 7), {
        last_heartbeat_at: at(4),
      }),
      event("connection_restored", 6, keys(1003, 1, 1, 7)),
      event("executor_connection_lost", 7, keys(1003, 1, 1, 7), {
        lost_at: at(7),
      }),
      event("executor_connection_restored", 8, keys(1003, 1, 1, 7), {
        restored_at: at(8),
      }),
    ],
  },
  released(1004, "executor_lost"),
  released(1005, "executor_restarted"),
  released(1006, "executor_shutdown"),
  released(1007, "claim_missing"),
  // A platform service is unavailable, then a configuration error.
  {
    task: taskRecord(1008, {
      current_state: "failed",
      completed_at: at(12),
      attempts: [
        attempt(
          1,
          "failed",
          [
            claim(1, 1, 7, 1, {
              pending_reasons: ["dependency_unavailable"],
              ended_at: at(12),
            }),
          ],
          "missing_required_parameter",
          false,
        ),
      ],
    }),
    events: [
      event("created", 1, keys(1008, 1, 1, 7)),
      event("pending", 2, keys(1008, 1, 1, 7), {
        reason: "dependency_unavailable",
      }),
      event("failed", 12, keys(1008, 1, 1, 7), {
        failure_reason: "missing_required_parameter",
        retryable: false,
      }),
    ],
  },
  // Never claimed.
  {
    task: taskRecord(1009, {
      current_state: "queued",
      executor_id: null,
      claimed_at: null,
      attempts: [attempt(1, "queued", [])],
    }),
    events: [],
  },
  // The approved mockup's pending task: three claims of one attempt, the
  // last waiting because all selected models are paused.
  {
    task: taskRecord(1010, {
      current_state: "pending",
      claim_seq: 3,
      executor_id: 7,
      attempts: [
        attempt(1, "pending", [
          claim(1, 1, 7, 1, {
            released_reason: "executor_restarted",
            ended_at: at(2),
          }),
          claim(1, 2, 8, 3, {
            released_reason: "executor_shutdown",
            ended_at: at(4),
          }),
          claim(1, 3, 7, 5, {
            pending_reasons: ["all_selected_models_paused"],
          }),
        ]),
      ],
    }),
    events: [
      event("created", 1, keys(1010, 1, 1, 7)),
      event("released", 2, keys(1010, 1, 1, 7), {
        reason: "executor_restarted",
      }),
      event("created", 3, keys(1010, 1, 2, 8)),
      event("released", 4, keys(1010, 1, 2, 8), {
        reason: "executor_shutdown",
      }),
      event("created", 5, keys(1010, 1, 3, 7)),
      event("pending", 6, keys(1010, 1, 3, 7), {
        reason: "all_selected_models_paused",
      }),
    ],
  },
];

// The note the approved mockup shows under every attempt history without
// control events.
const CONTROL_NOTE =
  "Cancellation requests and results appear here as control events, separate from lifecycle.";

async function setup(page: Page) {
  await catalogRoutes(page);
  await taskRoutes(page, TASKS);
}

const timeline = (page: Page) =>
  page
    .locator("section,div")
    .filter({
      has: page.getByRole("heading", {
        name: "Execution timeline",
        exact: true,
      }),
    })
    .last();
const attemptBlock = (page: Page, number: number) =>
  timeline(page)
    .locator("section,article,li,div")
    .filter({
      has: page.getByRole("heading", {
        level: 3,
        name: new RegExp(`^Attempt ${number}\\b`),
      }),
    })
    .last();
const status = (page: Page) =>
  page
    .locator("div,tr")
    .filter({ has: page.locator("dt,th").getByText("Status", { exact: true }) })
    .last();

/** Every text appears in `locator`, in this order. */
async function expectInOrder(locator: Locator, texts: string[], soft = false) {
  await expect(locator).toContainText(texts[texts.length - 1]);
  const text = await locator.innerText();
  const check = soft ? expect.soft : expect;
  let from = 0;
  for (const item of texts) {
    const index = text.indexOf(item, from);
    check(
      index,
      `"${item}" after position ${from} in:\n${text}`,
    ).toBeGreaterThanOrEqual(0);
    from = index + item.length;
  }
}

async function openTask(page: Page, id: number) {
  await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=${id}`);
  await expect(
    page.getByRole("heading", { name: "Execution timeline", exact: true }),
  ).toBeVisible();
}

test("v0048 task detail shows attempts, claims and release reasons · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await setup(page);

  await test.step("Task is released after the pending limit", async () => {
    await openTask(page, 1001);
    const first = attemptBlock(page, 1);
    await expectInOrder(
      first,
      [
        "Claim 1 · Executor 7",
        "created",
        "Budget exhausted",
        "All selected models paused",
        "Released after the pending limit",
        "Not a failure",
        "Claim 2 · Executor 8",
        "created",
      ],
      true,
    );
    await expect(attemptBlock(page, 2)).toHaveCount(0);
    for (const id of [7, 8])
      await expect(
        first.getByRole("link", { name: `Executor ${id}`, exact: true }),
      ).toHaveAttribute("href", `?view=executor&team=${TEAM}&id=${id}`);
    await expect(status(page)).toContainText(/created/i);
    await expect(status(page)).not.toContainText("attempt");
  });

  await test.step("Failed attempt is retried", async () => {
    await openTask(page, 1002);
    await expect(status(page)).toContainText(/queued · attempt 2/i);
    const first = attemptBlock(page, 1);
    await expect(
      first.getByRole("heading", { level: 3, name: /^Attempt 1\b/ }),
    ).toContainText(/failed/i);
    await expectInOrder(first, [
      "Claim 1 · Executor 7",
      "created",
      "running",
      "agent_error",
      "Retryable",
      "retry_scheduled",
      "attempt 2",
    ]);
    // The time the next attempt is queued.
    await expect(first.locator(`time[datetime="${at(9)}"]`)).toHaveCount(1);
    const second = attemptBlock(page, 2);
    await expect(second).toBeVisible();
    // A waiting (queued) attempt has no status badge.
    await expect
      .soft(second.getByRole("heading", { level: 3 }))
      .toHaveText("Attempt 2");
    // A queued attempt shows no invented lifecycle event or Executor.
    await expect(second.getByRole("link", { name: /^Executor / })).toHaveCount(
      0,
    );
    await expect(second).not.toContainText("created");
    // The task list shows the Status with the new attempt number.
    await page.goto(`${proxy.baseUrl}/?view=history&team=${TEAM}`);
    const row = page
      .locator("#results")
      .locator("tr:visible,article:visible")
      .filter({
        has: page.getByRole("link", {
          name: `${TEAM_NAME}-1002`,
          exact: true,
        }),
      });
    await expect(row).toContainText(/queued · attempt 2/i);
    await expect(
      page
        .locator("#results")
        .locator("tr:visible,article:visible")
        .filter({
          has: page.getByRole("link", {
            name: `${TEAM_NAME}-1003`,
            exact: true,
          }),
        }),
    ).not.toContainText("attempt");
  });

  await test.step("Executor loses its connection", async () => {
    await openTask(page, 1003);
    const first = attemptBlock(page, 1);
    await expectInOrder(first, [
      "running",
      "connection_lost",
      "connection_restored",
      "executor_connection_lost",
      "Reported by the Executor",
      "executor_connection_restored",
      "Reported by the Executor",
    ]);
    for (const minutes of [5, 6, 7, 8])
      await expect(
        first.locator(`time[datetime="${at(minutes)}"]`),
      ).toHaveCount(1);
    // A running attempt keeps its status badge.
    await expect
      .soft(first.getByRole("heading", { level: 3 }).locator(".badge"))
      .toHaveText(/running/i);
    await expect.soft(timeline(page)).toContainText(CONTROL_NOTE);
    await expect(status(page)).toContainText(/running/i);
    await expect(status(page)).not.toContainText("attempt");
  });

  await test.step("Executor is lost", async () => {
    await openTask(page, 1004);
    await expectInOrder(attemptBlock(page, 1), [
      "Released because the Executor lost its connection",
      "Not a failure",
    ]);
    await expect(attemptBlock(page, 2)).toHaveCount(0);
    await expect(status(page)).toContainText(/queued/i);
    await expect(status(page)).not.toContainText("attempt");
  });

  await test.step("Executor restart and shutdown releases", async () => {
    for (const [id, text] of [
      [1005, "Released because the Executor restarted"],
      [1006, "Released because the Executor shut down"],
    ] as const) {
      await openTask(page, id);
      await expectInOrder(attemptBlock(page, 1), [text, "Not a failure"]);
      await expect(attemptBlock(page, 2)).toHaveCount(0);
      await expect(status(page)).not.toContainText("attempt");
    }
  });

  await test.step("Claim missing from the Executor's heartbeats is released", async () => {
    await openTask(page, 1007);
    await expectInOrder(attemptBlock(page, 1), [
      "Released because the Executor no longer reported this claim",
      "Not a failure",
    ]);
    await expect(status(page)).toContainText(/queued/i);
    await expect(status(page)).not.toContainText("attempt");
  });

  await test.step("Task waits for an unavailable platform service", async () => {
    await openTask(page, 1008);
    const first = attemptBlock(page, 1);
    await expectInOrder(first, [
      "Waiting for a platform service",
      "missing_required_parameter",
      "Not retryable",
    ]);
    await expect(timeline(page)).not.toContainText("retry_scheduled");
    // A failed task keeps the note under its attempt history.
    await expect.soft(timeline(page)).toContainText(CONTROL_NOTE);
    await expect(attemptBlock(page, 2)).toHaveCount(0);
    await expect(status(page)).toContainText(/failed/i);
  });

  await test.step("A queued task shows no invented event or Executor", async () => {
    await openTask(page, 1009);
    await expect(
      timeline(page).getByRole("link", { name: /^Executor / }),
    ).toHaveCount(0);
    await expect(timeline(page)).not.toContainText(/created|running|Claim /);
    // No claim yet: no note under an empty history.
    await expect.soft(timeline(page)).not.toContainText(CONTROL_NOTE);
    await expect(status(page)).toContainText(/queued/i);
  });
});

test("v0048 task history offers the seven states and labels failed as Failed · Web UI unit", async ({
  page,
}) => {
  await setup(page);
  await page.goto(`${proxy.baseUrl}/?view=history&team=${TEAM}`);
  await test.step("Status filter offers the seven states", async () => {
    const filter = page.getByRole("combobox", { name: "Status", exact: true });
    await expect(filter).toBeVisible();
    const options = await filter.locator("option").allInnerTexts();
    expect(options.map((text) => text.trim())).toEqual([
      "All",
      "Queued",
      "Created",
      "Pending",
      "Running",
      "Finished",
      "Failed",
      "Cancelled",
    ]);
    await expect(page.locator("#results")).not.toContainText(/\bError\b/);
    const failed = page
      .locator("#results")
      .locator("tr:visible,article:visible")
      .filter({
        has: page.getByRole("link", {
          name: `${TEAM_NAME}-1008`,
          exact: true,
        }),
      });
    await expect(failed).toContainText(/failed/i);
  });
});

test("v0048 team stream updates the open task timeline once · Web UI unit", async ({
  page,
}) => {
  const stream = await captureStreams(page);
  await setup(page);
  await openTask(page, 1003);

  await test.step("New attempt events arrive without reload or duplicates", async () => {
    const failed = event("failed", 20, keys(1003, 1, 1, 7), {
      failure_reason: "agent_error",
      retryable: true,
    });
    await stream.send(failed);
    await stream.send(failed);
    const scheduled = event("retry_scheduled", 20, keys(1003, 1, null, null), {
      next_attempt: 2,
      due_at: at(21),
      failure_reason: "agent_error",
    });
    await stream.send(scheduled);
    await stream.send(event("queued", 21, keys(1003, 2, null, null)));
    await stream.send(event("created", 22, keys(1003, 2, 1, 8)));
    const first = attemptBlock(page, 1);
    await expect(first).toContainText("agent_error");
    // failed and retry_scheduled; the replayed failed frame is shown once.
    await expect(first.locator(`time[datetime="${at(20)}"]`)).toHaveCount(2);
    const second = attemptBlock(page, 2);
    await expectInOrder(second, ["Claim 1 · Executor 8", "created"]);
    await expect(status(page)).toContainText(/created · attempt 2/i);
  });
});

test("v0048 task detail and history at every supported resolution and theme · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await setup(page);
  for (const { theme, width, height } of MATRIX)
    await test.step(`${theme} ${width}`, async () => {
      await usePresentation(page, theme, { width, height });
      await openTask(page, 1002);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(attemptBlock(page, 1)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto(`${proxy.baseUrl}/?view=history&team=${TEAM}`);
      await expect(
        page
          .getByRole("link", {
            name: `${TEAM_NAME}-1002`,
            exact: true,
          })
          .first(),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
});

test("v0048 task detail shows the pending attempt as approved at every supported resolution and theme · Web UI unit", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await setup(page);
  for (const { theme, width, height } of MATRIX)
    await test.step(`${theme} ${width}`, async () => {
      await usePresentation(page, theme, { width, height });
      await openTask(page, 1010);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const first = attemptBlock(page, 1);

      // A pending attempt heading has no status badge.
      await expect
        .soft(first.getByRole("heading", { level: 3 }))
        .toHaveText("Attempt 1");

      // The all_selected_models_paused reason in the spec's words.
      const paused = first.getByRole("listitem").filter({
        hasText: /^pending · /,
        has: page.locator(`time[datetime="${at(6)}"]`),
      });
      await expect
        .soft(paused)
        .toHaveText(/^pending · All selected models paused · /);
      await expect.soft(timeline(page)).not.toContainText("are paused");

      // "Claim N ·" in regular weight; the Executor links in the monospace
      // link style of the Assigned Executor link, 14px as in the mockup
      // (owner, 2026-11-13).
      const assigned = page
        .locator("div,tr")
        .filter({
          has: page
            .locator("dt,th")
            .getByText("Assigned Executor", { exact: true }),
        })
        .last()
        .getByRole("link", { name: "Executor 7", exact: true });
      const style = (link: Locator) =>
        link.evaluate((node) => {
          const value = getComputedStyle(node);
          return { family: value.fontFamily, size: value.fontSize };
        });
      const mono = await style(assigned);
      expect.soft(mono).toEqual({
        family: '"SF Mono", ui-monospace, Menlo, monospace',
        size: "14px",
      });
      const heads = first.locator("p", { hasText: /^Claim \d+ · / });
      await expect
        .soft(heads)
        .toHaveText([
          "Claim 1 · Executor 7",
          "Claim 2 · Executor 8",
          "Claim 3 · Executor 7",
        ]);
      for (const head of await heads.all()) {
        expect
          .soft(
            await head.evaluate((node) => getComputedStyle(node).fontWeight),
          )
          .toBe("400");
        expect.soft(await style(head.getByRole("link"))).toEqual(mono);
      }

      // The control-events note closes the timeline.
      await expect
        .soft(timeline(page).locator("p").last())
        .toHaveText(CONTROL_NOTE);
      await expectNoHorizontalScroll(page);
    });
});
