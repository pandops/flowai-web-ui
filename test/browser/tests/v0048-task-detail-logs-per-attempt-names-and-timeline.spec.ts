import { expect, test, type Page } from "../fixtures/owned-test";
import type { MockedProxy } from "../fixtures/mocked_proxy";
import {
  TEAM,
  v0048Proxy,
  MATRIX,
  usePresentation,
  expectNoHorizontalScroll,
  catalogRoutes,
  taskRoutes,
  taskRecord,
  attempt,
  claim,
  event,
  at,
  captureStreams,
} from "../fixtures/v0048-ui";

// web-ui: Task detail (D42, owner 2026-11-14 on the demo stand: «all worklog
// by 1 attempt must be on one tab, second attemt - second tab, etc. in
// canonical relationship no need id s, only name. 1 is before 'archived ·
// 08:42:08 +03:00' why?»).
// - Logs: one tab per attempt; each holds that attempt's Work and Reasoning
//   entries merged by log_offset, every line marked by its stream.
// - Canonical relationships: Source and Flow by name only, no IDs.
// - Timeline: events without claim_seq sit in time order inside the
//   attempt's claim list; no second numbered list.
test.use({ actionTimeout: 10_000 });
let proxy: MockedProxy;
test.beforeEach(async () => {
  proxy = await v0048Proxy();
});

const TASK = 1060;
let nextLogEvent = 9100;
const log = (
  attemptNumber: number,
  log_offset: number,
  stream: "work" | "reasoning",
  text: string,
  minutes: number,
) => ({
  event_id: nextLogEvent++,
  team_id: TEAM,
  task_id: TASK,
  attempt: attemptNumber,
  claim_seq: 1,
  executor_id: attemptNumber === 1 ? 7 : 8,
  log_offset,
  stream,
  text,
  publisher_seq: log_offset,
  occurred_at: at(minutes),
});

// Attempt 1 failed (retryable) on Executor 7; attempt 2 runs on Executor 8.
const LOGS = [
  log(1, 1, "work", "a1 work: read payload", 2),
  log(1, 2, "reasoning", "a1 reasoning: choose path", 3),
  log(1, 3, "work", "a1 work: agent error", 4),
  log(2, 4, "reasoning", "a2 reasoning: retry plan", 12),
  log(2, 5, "work", "a2 work: pwd && ls -la", 13),
  log(2, 6, "reasoning", "a2 reasoning: verify file", 14),
  log(2, 7, "work", "a2 work: write file", 15),
];

function twoAttemptTask() {
  const task = taskRecord(TASK, {
    current_state: "running",
    attempt: 2,
    executor_id: 8,
    claimed_at: at(11),
    attempts: [
      attempt(
        1,
        "failed",
        [claim(1, 1, 7, 1, { ended_at: at(5) })],
        "agent_error",
        true,
      ),
      attempt(2, "running", [claim(2, 1, 8, 11)]),
    ],
  });
  const keys = (a: number, executor_id: number) => ({
    task_id: TASK,
    attempt: a,
    claim_seq: 1,
    executor_id,
  });
  const events = [
    event("created", 1, keys(1, 7)),
    event("running", 2, keys(1, 7)),
    event("failed", 5, keys(1, 7), {
      failure_reason: "agent_error",
      retryable: true,
    }),
    event("created", 11, keys(2, 8)),
    event("running", 12, keys(2, 8)),
  ];
  return { task, events, logs: LOGS };
}

// A finished task as on the stand: task-manager's `archived` carries no
// attempt or claim_seq and falls between two claim events in time.
function archivedTask() {
  const task = taskRecord(TASK + 1, {
    current_state: "finished",
    completed_at: at(5),
    attempts: [
      attempt(1, "finished", [claim(1, 1, 7, 1, { ended_at: at(5) })]),
    ],
  });
  const keys = { task_id: TASK + 1, attempt: 1, claim_seq: 1, executor_id: 7 };
  const events = [
    event("created", 1, keys),
    event("running", 2, keys),
    event("finished", 5, keys),
    event(
      "archived",
      6,
      { task_id: TASK + 1 },
      { attempts: 1, final_state: "finished" },
    ),
    event("task_key_revoked", 7, keys),
  ];
  return { task, events };
}

const section = (page: Page, heading: string) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: heading, exact: true }),
  });

async function lines(page: Page, attemptNumber: number) {
  return page
    .getByRole("log", { name: `Attempt ${attemptNumber} log`, exact: true })
    .locator("[data-log-offset]")
    .evaluateAll((nodes) =>
      nodes.map((node) => [
        node.querySelector("[data-log-stream-label]")?.textContent?.trim(),
        node.querySelector("[data-log-content]")?.textContent,
      ]),
    );
}

for (const view of MATRIX)
  test(`v0048 task detail: logs per attempt, relationships by name, one timeline list · Web UI unit · ${view.theme} ${view.name}`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await usePresentation(page, view.theme, view);
    await catalogRoutes(page);
    const running = twoAttemptTask();
    const archived = archivedTask();
    await taskRoutes(page, [running, archived]);
    const stream = await captureStreams(page);
    await page.goto(`${proxy.baseUrl}/?view=task&team=${TEAM}&id=${TASK}`);
    const logs = section(page, "Logs");

    await test.step("Logs show one tab per attempt; the current attempt is selected", async () => {
      await expect(logs).toBeVisible();
      for (const heading of ["Work log", "Reasoning log"])
        await expect(
          page.getByRole("heading", { name: heading, exact: true }),
        ).toHaveCount(0);
      const tabs = logs.getByRole("tab");
      await expect(tabs).toHaveText(["Attempt 1", "Attempt 2"]);
      await expect(
        logs.getByRole("tab", { name: "Attempt 2", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        logs.getByRole("tab", { name: "Attempt 1", exact: true }),
      ).toHaveAttribute("aria-selected", "false");
      await expect(
        page.getByRole("log", { name: "Attempt 2 log", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("log", { name: "Attempt 1 log", exact: true }),
      ).toBeHidden();
      await expectNoHorizontalScroll(page);
    });

    await test.step("A tab merges Work and Reasoning by log_offset, each line marked by its stream", async () => {
      expect(await lines(page, 2)).toEqual([
        ["Reasoning", "a2 reasoning: retry plan"],
        ["Work", "a2 work: pwd && ls -la"],
        ["Reasoning", "a2 reasoning: verify file"],
        ["Work", "a2 work: write file"],
      ]);
      await logs.getByRole("tab", { name: "Attempt 1", exact: true }).click();
      await expect(
        logs.getByRole("tab", { name: "Attempt 1", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("log", { name: "Attempt 1 log", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("log", { name: "Attempt 2 log", exact: true }),
      ).toBeHidden();
      expect(await lines(page, 1)).toEqual([
        ["Work", "a1 work: read payload"],
        ["Reasoning", "a1 reasoning: choose path"],
        ["Work", "a1 work: agent error"],
      ]);
      // No interactive log actions inside any log.
      await expect(
        logs.locator(
          "[data-log] button,[data-log] input,[data-log] textarea,[data-log] [contenteditable=true]",
        ),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: /copy log|clear log|follow log|reconnect/i,
        }),
      ).toHaveCount(0);
      await logs.getByRole("tab", { name: "Attempt 2", exact: true }).click();
    });

    await test.step("Live entries continue their attempt's tab once and the log follows", async () => {
      const live = log(2, 8, "reasoning", "a2 reasoning: live tail", 16);
      await stream.send(live as any, "task_log");
      await stream.send(live as any, "task_log");
      const current = page.getByRole("log", {
        name: "Attempt 2 log",
        exact: true,
      });
      await expect(current.getByText(live.text, { exact: true })).toHaveCount(
        1,
      );
      expect((await lines(page, 2)).at(-1)).toEqual(["Reasoning", live.text]);
      await expect(
        page
          .getByRole("log", { name: "Attempt 1 log", exact: true })
          .getByText(live.text, { exact: true }),
      ).toHaveCount(0);
      expect(
        await current.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      ).toBeLessThanOrEqual(2);
      // An entry of a new attempt opens its own tab.
      const third = log(3, 9, "work", "a3 work: first line", 20);
      await stream.send(third as any, "task_log");
      await expect(logs.getByRole("tab")).toHaveText([
        "Attempt 1",
        "Attempt 2",
        "Attempt 3",
      ]);
      await logs.getByRole("tab", { name: "Attempt 3", exact: true }).click();
      expect(await lines(page, 3)).toEqual([["Work", third.text]]);
    });

    await test.step("Canonical relationships show Source and Flow by name only", async () => {
      const relationships = section(page, "Canonical relationships");
      await expect(relationships.locator("dt")).toHaveText([
        "Source",
        "External ID",
        "Flow",
      ]);
      const value = (label: string) =>
        relationships
          .locator("div")
          .filter({
            has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }),
          })
          .locator("dd");
      await expect(value("Source")).toHaveText("jira-sync");
      await expect(
        value("Source").getByRole("link", { name: "jira-sync", exact: true }),
      ).toHaveAttribute("href", `?view=source&team=${TEAM}&id=4`);
      await expect(value("Flow")).toHaveText("Intake routing");
      await expect(
        value("Flow").getByRole("link", {
          name: "Intake routing",
          exact: true,
        }),
      ).toHaveAttribute("href", `?view=flow&team=${TEAM}&id=1`);
      await expect(value("External ID")).toHaveText(`invoice-${TASK}`);
    });

    await test.step("Claimless events sit in time order in the attempt's one list", async () => {
      await page.goto(
        `${proxy.baseUrl}/?view=task&team=${TEAM}&id=${TASK + 1}`,
      );
      const timeline = section(page, "Execution timeline");
      const first = timeline.locator('[data-attempt="1"]');
      await expect(first.locator("ol.timeline")).toHaveCount(1);
      await expect(timeline.locator(".attempt-events")).toHaveCount(0);
      const items = first.locator("ol.timeline > li");
      await expect(items).toHaveText([
        /^created · /,
        /^running · /,
        /^finished · /,
        /^archived · /,
        /^task_key_revoked · /,
      ]);
      await expectNoHorizontalScroll(page);
    });
  });
