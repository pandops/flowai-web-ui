import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  TEAM_NAME,
  at,
  attempt,
  catalogRoutes,
  claim,
  event,
  executorRecord,
  executorRoutes,
  recordRequests,
  taskRecord,
  taskRoutes,
  v0048Proxy,
  MATRIX,
  usePresentation,
} from "../fixtures/v0048-ui";

// web-ui: Web UI renders task detail and executor navigation (v0048).
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const k = (task_id: number, a: number, c: number, executor_id: number) => ({
  task_id,
  attempt: a,
  claim_seq: c,
  executor_id,
});

async function setup(page: Page) {
  await catalogRoutes(page);
  await executorRoutes(page, {
    records: [executorRecord(7), executorRecord(8)],
    states: [],
    events: new Map(),
    tasks: new Map(),
  });
  await taskRoutes(page, [
    {
      task: taskRecord(1010, {
        attempts: [attempt(1, "running", [claim(1, 1, 7, 1)])],
      }),
      events: [
        event("created", 1, k(1010, 1, 1, 7)),
        event("running", 2, k(1010, 1, 1, 7)),
      ],
      parameters: {
        environment: { RETRY_LIMIT: "3" },
        secret_keys: ["PAYMENT_API_KEY"],
      },
    },
    {
      task: taskRecord(1020, {
        attempt: 2,
        claim_seq: 2,
        executor_id: 8,
        attempts: [
          attempt(
            1,
            "failed",
            [claim(1, 1, 7, 1, { ended_at: at(4) })],
            "agent_error",
            true,
          ),
          attempt(2, "running", [
            claim(2, 1, 7, 6, {
              released_reason: "executor_lost",
              ended_at: at(9),
            }),
            claim(2, 2, 8, 12),
          ]),
        ],
      }),
      events: [
        event("created", 1, k(1020, 1, 1, 7)),
        event("running", 2, k(1020, 1, 1, 7)),
        event("failed", 4, k(1020, 1, 1, 7), {
          failure_reason: "agent_error",
          retryable: true,
        }),
        event("created", 6, k(1020, 2, 1, 7)),
        event("running", 7, k(1020, 2, 1, 7)),
        event("released", 9, k(1020, 2, 1, 7), { reason: "executor_lost" }),
        event("created", 12, k(1020, 2, 2, 8)),
        event("running", 13, k(1020, 2, 2, 8)),
      ],
    },
  ]);
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0048 task detail links each claim to its Executor · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    await setup(page);
    const requests = recordRequests(page);
    const parameters = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "Launch parameters",
        exact: true,
      }),
    });

    await test.step("Operator follows the assigned Executor", async () => {
      await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=1010`);
      const main = page.locator("main");
      // D5: the frozen parameters come from one read of launch-parameters.
      await expect(parameters).toContainText("RETRY_LIMIT=3");
      await expect(parameters).toContainText("PAYMENT_API_KEY · value hidden");
      expect(
        requests.filter(
          (request) =>
            request.method === "GET" &&
            request.path ===
              `/ui/v1/teams/${TEAM}/tasks/1010/launch-parameters`,
        ),
      ).toHaveLength(1);
      // A secret reference never shows a value.
      await expect(parameters).not.toContainText(/PAYMENT_API_KEY\s*=/);
      const link = main
        .getByRole("link", { name: "Executor 7", exact: true })
        .first();
      await expect(link).toHaveAttribute(
        "href",
        `?view=executor&team=${TEAM}&id=7`,
      );
      await link.click();
      await expect(
        page.getByRole("heading", { name: "Executor 7", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/[?&]id=1010(&|$)/);
      await expect(
        page.getByRole("heading", { name: "Execution timeline", exact: true }),
      ).toBeVisible();
    });

    await test.step("Operator opens a task with several claims", async () => {
      await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=1020`);
      const main = page.locator("main");
      // D5: nothing frozen yet (attempt null) shows no launch parameters.
      await expect(
        page.getByRole("heading", { name: "Launch parameters", exact: true }),
      ).toBeVisible();
      await expect(parameters).not.toContainText("RETRY_LIMIT");
      await expect(parameters).not.toContainText("value hidden");
      await expect(parameters).not.toContainText(/[A-Z_]+=/);
      await expect(
        main
          .locator("div,tr")
          .filter({
            has: page.locator("dt,th").getByText("Status", { exact: true }),
          })
          .last(),
      ).toContainText(/running · attempt 2/i);
      const second = main
        .locator("section,article,li,div")
        .filter({
          has: page.getByRole("heading", { level: 3, name: /^Attempt 2\b/ }),
        })
        .last();
      const text = await second.innerText();
      const one = text.indexOf("Claim 1 · Executor 7"),
        two = text.indexOf("Claim 2 · Executor 8");
      expect(one).toBeGreaterThanOrEqual(0);
      expect(two).toBeGreaterThan(one);
      // Each claim's events start with created.
      expect(
        text
          .slice(one)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)[1],
      ).toMatch(/^created/);
      expect(
        text
          .slice(two)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)[1],
      ).toMatch(/^created/);
      for (const id of [7, 8])
        await expect(
          second.getByRole("link", { name: `Executor ${id}`, exact: true }),
        ).toHaveAttribute("href", `?view=executor&team=${TEAM}&id=${id}`);
    });
  });

// v0050: one task per lifecycle status, each with its reply task_name.
const STATUSES = [
  "queued",
  "created",
  "pending",
  "running",
  "finished",
  "failed",
  "cancelled",
] as const;
const lifecycleTask = (task_id: number, status: (typeof STATUSES)[number]) => {
  const claimed = status !== "queued",
    done = ["finished", "failed", "cancelled"].includes(status);
  return taskRecord(task_id, {
    current_state: status,
    executor_id: claimed ? 7 : null,
    claim_seq: claimed ? 1 : 0,
    claimed_at: claimed ? at(1) : null,
    completed_at: done ? at(5) : null,
    attempts: claimed
      ? [
          attempt(
            1,
            status,
            [claim(1, 1, 7, 1, { ended_at: done ? at(5) : null })],
            status === "failed" ? "agent_error" : null,
            status === "failed" ? false : null,
          ),
        ]
      : [],
  });
};
// The Output panel's former status-only texts (pre-v0050 task detail).
const OUTPUT_TEXTS = [
  "No task result was published",
  "Output appears when the Executor publishes it",
  "Awaiting execution output",
  "Its published output is in Logs",
  "Inspect Logs for the failure context",
  "The task is waiting for a successful claim",
];

/** Task detail names the task in its heading and `Task` field only. */
async function expectNamedDetail(
  page: Page,
  id: number,
  name: string,
  external: string,
) {
  const main = page.locator("main");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  // The browser tab title stays generic.
  await expect(page).toHaveTitle("FlowAI · Task detail");
  const field = (label: string) =>
    main
      .locator("dl > div")
      .filter({ has: page.locator("dt").getByText(label, { exact: true }) });
  await expect(field("Task")).toHaveCount(1);
  await expect(field("Task").locator("dd")).toHaveText(name);
  await expect(field("Task ID")).toHaveCount(0);
  await expect(main.locator("dt").getByText("Task ID")).toHaveCount(0);
  // No Output panel and no status-only text about output.
  await expect(
    page.getByRole("heading", { name: "Output", exact: true }),
  ).toHaveCount(0);
  for (const text of OUTPUT_TEXTS) await expect(main).not.toContainText(text);
  // Logs follows Canonical relationships directly.
  await expect(
    page.getByRole("heading", { name: "Logs", exact: true }),
  ).toBeVisible();
  // The External ID shows the fixture's Source value, not the task_id.
  await expect(field("External ID")).toHaveCount(1);
  await expect(field("External ID").locator("dd")).toHaveText(external);
  // No bare task ID outside the task name and the fixture's External ID.
  expect(
    (await main.innerText()).split(name).join(" ").split(external).join(" "),
  ).not.toMatch(new RegExp(`(^|\\D)${id}(\\D|$)`));
}

// AGENTS.md, Supported resolutions: every supported resolution and theme.
for (const view of MATRIX)
  test(`v0050 task detail shows the task name and no Output panel · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    await usePresentation(page, view.theme, view);
    test.setTimeout(120_000);
    await catalogRoutes(page);
    await executorRoutes(page, {
      records: [executorRecord(7)],
      states: [],
      events: new Map(),
      tasks: new Map(),
    });
    const lifecycle = STATUSES.map((status, index) =>
      lifecycleTask(1060 + index, status),
    );
    // The reply's name differs from `<team_name>-<task_id>` on purpose.
    const replied = taskRecord(1067, { task_name: "ops-9067" });
    await taskRoutes(
      page,
      [...lifecycle, replied].map((task) => ({ task, events: [] })),
    );

    await test.step("Task detail shows the task name and no Output panel", async () => {
      for (const task of lifecycle) {
        await page.goto(
          `${proxy.baseUrl}/?view=task&team=${TEAM}&id=${task.task_id}`,
        );
        await expect(
          page.getByRole("heading", {
            name: "Task identity and status",
            exact: true,
          }),
        ).toBeVisible();
        expect(task.task_name).toBe(`${TEAM_NAME}-${task.task_id}`);
        await expectNamedDetail(
          page,
          task.task_id,
          task.task_name,
          task.external_id,
        );
      }
    });

    await test.step("Task name comes from the reply", async () => {
      await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=1067`);
      await expect(page).toHaveURL(/[?&]id=1067(&|$)/);
      await expectNamedDetail(page, 1067, "ops-9067", replied.external_id);
      await expect(page.locator("main")).not.toContainText(`${TEAM_NAME}-1067`);
    });

    await test.step("Not-found task detail names the requested task", async () => {
      // No task record: the name is composed from the selected team's
      // canonical team_name and the route's integer task_id.
      await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=4242`);
      const main = page.locator("main");
      await expect(main).toContainText(
        new RegExp(`Requested task\\s*${TEAM_NAME}-4242`),
      );
      expect(
        (await main.innerText()).split(`${TEAM_NAME}-4242`).join(" "),
      ).not.toMatch(/(^|\D)4242(\D|$)/);
    });
  });
