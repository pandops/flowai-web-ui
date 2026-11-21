import { captureDesignState, designViewport } from "../fixtures/design-capture";
import {
  anyCancelTaskDialog,
  cancelTaskDialog,
} from "../fixtures/approved-dialogs";
import path from "node:path";
import { expect, test } from "../fixtures/owned-test";
import { startMockedProxy, type MockedProxy } from "../fixtures/mocked_proxy";
import { startFakeGateway, type FakeGateway } from "../fixtures/fake_gateway";
import type { BrowserContext, Page, Route, TestInfo } from "@playwright/test";

// Fail missing-control actions before the test deadline, leaving teardown time.
test.use({ actionTimeout: 10_000 });

let proxy: MockedProxy, registry: FakeGateway;
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
  // Stopping the Web UI container is slow on a busy container store.
  test.setTimeout(120_000);
  try {
    await proxy?.close();
  } finally {
    await registry?.close();
  }
});
const taskID = 8028,
  sourceID = 8029,
  flowID = 8031,
  executorID = 7017;
const taskPath = `/ui/v1/teams/1/tasks/${taskID}`;
function cancellationRequest(route: Route) {
  try {
    const request = route.request(),
      body = request.postDataJSON();
    if (
      request.method() === "POST" &&
      body &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      typeof body.request_id === "string" &&
      body.request_id.length <= 128 &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(body.request_id)
    )
      return body;
  } catch {
    /* Invalid JSON has the same public 400 outcome. */
  }
  return null;
}
// A journal-stored event: the publisher's flat message plus event_id.
function stored(
  event_id: number,
  kind: string,
  occurred_at: string,
  extra: Record<string, unknown> = {},
) {
  return {
    event_id,
    publisher: "executor",
    publisher_seq: event_id,
    team_id: 1,
    task_id: taskID,
    attempt: 1,
    claim_seq: 1,
    executor_id: executorID,
    occurred_at,
    kind,
    ...extra,
  };
}
// A journal log entry; frame_id of its task_log frame is its event_id.
function logEntry(
  event_id: number,
  log_offset: number,
  stream: string,
  text: string,
  occurred_at = "2026-10-18T00:00:03Z",
) {
  return {
    event_id,
    task_id: taskID,
    attempt: 1,
    claim_seq: 1,
    executor_id: executorID,
    log_offset,
    stream,
    text,
    publisher_seq: event_id,
    occurred_at,
  };
}
function logFrame(entry: ReturnType<typeof logEntry>) {
  return {
    frame_id: entry.event_id,
    frame_type: "task_log",
    team_id: 1,
    task_id: entry.task_id,
    data: entry,
  };
}
// A journal control event of the cancel control `control_id`.
function controlEvent(
  event_id: number,
  kind: string,
  control_id: number,
  occurred_at: string,
) {
  return stored(event_id, kind, occurred_at, {
    publisher: kind === "control_requested" ? "task-manager" : "executor",
    control: "cancel",
    control_id,
  });
}
const executionTimeline = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: "Execution timeline", exact: true }),
  });
async function detailFixture(page: Page, status = "running") {
  const active = ["created", "running"].includes(status);
  const queued = status === "queued";
  const task = {
    task_id: taskID,
    task_name: `alpha-${taskID}`,
    team_id: 1,
    source_id: sourceID,
    flow_id: flowID,
    external_id: "external-identity/with-full-text",
    current_state: status,
    attempt: 1,
    claim_seq: queued ? 0 : 1,
    executor_id: queued ? null : executorID,
    ingested_at: "2026-10-18T00:00:00Z",
    claimed_at: queued ? null : "2026-10-18T00:00:01Z",
    completed_at: active || queued ? null : "2026-10-18T00:00:21Z",
  };
  const writes: string[] = [];
  await page.route("**/ui/v1/sources?**", (route) =>
    route.fulfill({
      json: {
        items: [{ source_id: sourceID, name: "Fixture Source" }],
        next_cursor: null,
      },
    }),
  );
  await page.route("**/ui/v1/flows?**", (route) =>
    route.fulfill({
      json: {
        items: [{ flow_id: flowID, name: "Fixture Flow" }],
        next_cursor: null,
      },
    }),
  );
  await page.route(`**${taskPath}`, (route) => route.fulfill({ json: task }));
  await page.route(`**${taskPath}/attempts**`, (route) =>
    route.fulfill({
      json: {
        task_id: taskID,
        items: [
          {
            attempt: 1,
            state: status,
            failure_reason: status === "failed" ? "agent_error" : null,
            retryable: status === "failed" ? false : null,
            claims: queued
              ? []
              : [
                  {
                    attempt: 1,
                    claim_seq: 1,
                    executor_id: executorID,
                    claimed_at: "2026-10-18T00:00:01Z",
                    resolved_image: null,
                    image_source: null,
                    pending_reasons: [],
                    released_reason: null,
                    ended_at: task.completed_at,
                  },
                ],
          },
        ],
      },
    }),
  );
  await page.route(`**${taskPath}/launch-parameters**`, (route) =>
    route.fulfill({
      json: queued
        ? { task_id: taskID, attempt: null, environment: {}, secret_keys: [] }
        : {
            task_id: taskID,
            attempt: 1,
            environment: { VISIBLE: "safe ordinary value" },
            secret_keys: ["HIDDEN_KEY"],
          },
    }),
  );
  const events = queued
    ? []
    : (status === "created"
        ? ["created"]
        : active
          ? ["created", "running"]
          : ["created", "running", status]
      ).map((kind, index) =>
        stored(
          3000 + index,
          kind,
          `2026-10-18T00:00:${String(index + 1).padStart(2, "0")}Z`,
          kind === "failed"
            ? { failure_reason: "agent_error", retryable: false }
            : {},
        ),
      );
  await page.route(`**${taskPath}/events?**`, (route) =>
    route.fulfill({ json: { items: events, next_cursor: null } }),
  );
  await page.route(`**${taskPath}/logs?**`, (route) =>
    route.fulfill({ json: { items: [], next_cursor: null } }),
  );
  page.on("request", (request) => {
    if (
      request.method() !== "GET" &&
      new URL(request.url()).pathname.startsWith("/ui/v1/")
    )
      writes.push(new URL(request.url()).pathname);
  });
  return { task, writes };
}

type Step = [title: string, body: (page: Page) => Promise<void>];
// Merged tests run one step per original test, each on a fresh page of the
// test's context (fresh mocked state), and fail only after every step ran.
async function freshPageSteps(
  context: BrowserContext,
  info: TestInfo,
  label: string,
  steps: Step[],
) {
  const failures: unknown[] = [];
  for (const [title, body] of steps) {
    const page = await context.newPage();
    try {
      await test.step(title, () => body(page));
    } catch (error) {
      failures.push(error);
      await info.attach(`${title}-failure`, {
        body: String(error),
        contentType: "text/plain",
      });
    } finally {
      try {
        await captureDesignState(
          page,
          info,
          proxy.webUIImageID,
          `final-${title}`,
        );
      } finally {
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, label);
}

for (const theme of ["dark", "light"])
  for (const width of [390, 820, 1440])
    test(`v0034.4 task inspection sections, readonly output and stream recovery ${theme} ${width}`, async ({
      page,
    }, info) => {
      test.setTimeout(60_000);
      const failures: unknown[] = [];
      await page.setViewportSize(designViewport(width));
      await page.addInitScript(
        (theme) => localStorage.setItem("flowai.theme", theme),
        theme,
      );
      const { task, writes } = await detailFixture(page);
      await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
      const step = async (title: string, body: () => Promise<void>) => {
        try {
          await test.step(title, body);
        } catch (error) {
          failures.push(error);
          await info.attach(`${title}-failure`, {
            body: String(error),
            contentType: "text/plain",
          });
        } finally {
          await captureDesignState(
            page,
            info,
            proxy.webUIImageID,
            `final-${title}`,
          );
        }
      };
      await step(
        `v0034.4 task inspection has labelled canonical sections and independent readonly output ${theme} ${width}`,
        async () => {
          for (const name of [
            "Task identity and status",
            "Canonical relationships",
            "Logs",
            "Execution timeline",
            "Launch parameters",
          ])
            await expect(
              page.getByRole("heading", { name, exact: true }),
            ).toBeVisible();
          // Each canonical link is checked inside its own section: the v0048
          // execution timeline links the claiming Executor too, and that link
          // must not stand in for the Assigned Executor.
          const section = (heading: string) =>
            page.locator("section").filter({
              has: page.getByRole("heading", { name: heading, exact: true }),
            });
          for (const [heading, view, id, name] of [
            ["Canonical relationships", "source", sourceID, "Fixture Source"],
            ["Canonical relationships", "flow", flowID, "Fixture Flow"],
            [
              "Task identity and status",
              "executor",
              executorID,
              `Executor ${executorID}`,
            ],
          ])
            await expect(
              section(String(heading)).getByRole("link", {
                name: String(name),
                exact: true,
              }),
            ).toHaveAttribute("href", `?view=${view}&team=1&id=${id}`);
          await expect(
            page.getByText(task.external_id, { exact: true }),
          ).toBeVisible();
          await expect(
            page.locator("#content dt").filter({ hasText: /^Mode$/ }),
          ).toHaveCount(0);
          // D42: one log per attempt holds Work and Reasoning together.
          await expect(
            page.getByRole("log", { name: "Attempt 1 log", exact: true }),
          ).toContainText(/waiting|no output/i);
          await expect(
            page.getByRole("tab", { name: "Attempt 1", exact: true }),
          ).toHaveAttribute("aria-selected", "true");
          await expect(
            page.locator(
              "[data-log] button,[data-log] input,[data-log] textarea,[data-log] [contenteditable=true]",
            ),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: /launch|clone|retry as new|copy log|clear log|follow log|reconnect/i,
            }),
          ).toHaveCount(0);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true);
          expect(writes).toEqual([]);
        },
      );
      // The same page continues with saved output: the newer logs route wins.
      await step(
        `v0034.4 both output panes retain received lines and expose automatic stream recovery ${theme} ${width}`,
        async () => {
          const savedLines = [
            {
              stream: "work",
              content: "Retained work before stream interruption",
            },
            {
              stream: "reasoning",
              content: "Retained reasoning before stream interruption",
            },
          ];
          await page.route(`**${taskPath}/logs?**`, (route) =>
            route.fulfill({
              json: {
                items: savedLines.map((line, index) =>
                  logEntry(4001 + index, index + 1, line.stream, line.content),
                ),
                next_cursor: null,
              },
            }),
          );
          await page.reload();
          for (const line of savedLines)
            await expect(
              page.getByText(line.content, { exact: true }),
            ).toBeVisible();
          await expect(
            page.locator("[data-stream-state=connected]"),
          ).toHaveCount(1);
          // D42: both streams of attempt 1 share its one log, in log_offset
          // order, each line marked by its stream.
          const pane = page.getByRole("log", {
            name: "Attempt 1 log",
            exact: true,
          });
          const logsPanel = page.locator("[data-task-log]");
          const contents = await pane
            .locator("[data-log-content]")
            .allTextContents();
          expect(contents).toEqual(savedLines.map((line) => line.content));
          await expect(pane.locator("[data-log-stream-label]")).toHaveText([
            "Work",
            "Reasoning",
          ]);
          registry.rejectStreams(1, true);
          try {
            registry.disconnectStreams(1);
            await expect(
              logsPanel.locator("[role=status],[role=alert]"),
            ).toBeVisible();
            await expect(
              logsPanel.locator("[role=status],[role=alert]"),
            ).toContainText(
              /reconnect|retrying|stream.*unavailable|stream.*error/i,
            );
            for (const text of contents)
              await expect(pane.getByText(text, { exact: true })).toHaveCount(
                1,
              );
            await expect(
              page.getByRole("heading", {
                name: "Task identity and status",
                exact: true,
              }),
            ).toBeVisible();
            await expect(
              page.getByRole("button", {
                name: /reconnect|follow log|clear log|copy log/i,
              }),
            ).toHaveCount(0);
            await captureDesignState(
              page,
              info,
              proxy.webUIImageID,
              "output-stream-error-retrying",
            );
            registry.rejectStreams(1, false);
            await expect(
              page.locator("[data-stream-state=connected]"),
            ).toHaveCount(1);
            for (let index = 0; index < savedLines.length; index++) {
              const line = savedLines[index];
              const occurredAt = new Date(Date.now() + index + 1).toISOString();
              const frame = logFrame(
                logEntry(
                  4003 + index,
                  index + 3,
                  line.stream,
                  `Resumed ${line.stream} after automatic reconnect`,
                  occurredAt,
                ),
              );
              registry.push(1, frame);
              registry.push(1, frame);
              await expect(
                pane.getByText(frame.data.text, { exact: true }),
              ).toHaveCount(1);
            }
            await expect(pane.locator("[data-log-content]")).toHaveText([
              ...contents,
              "Resumed work after automatic reconnect",
              "Resumed reasoning after automatic reconnect",
            ]);
            await expect(
              logsPanel
                .locator("[role=status],[role=alert]")
                .filter({ hasText: /reconnect|retrying|stream.*error/i }),
            ).toHaveCount(0);
          } finally {
            registry.rejectStreams(1, false);
          }
        },
      );
      if (failures.length)
        throw new AggregateError(failures, "Task inspection and output");
    });

for (const theme of ["dark", "light"])
  test(`v0034.4 task lifecycle and cancellation eligibility for every status ${theme}`, async ({
    context,
  }, info) => {
    test.setTimeout(150_000);
    await freshPageSteps(
      context,
      info,
      "Task lifecycle and cancellation eligibility",
      ["queued", "created", "running", "finished", "failed"].map(
        (status): Step => [
          `v0034.4 ${status} task retains real lifecycle and cancellation eligibility ${theme}`,
          async (page) => {
            await page.addInitScript(
              (theme) => localStorage.setItem("flowai.theme", theme),
              theme,
            );
            await detailFixture(page, status);
            await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
            const identity = page
              .locator("section")
              .filter({
                has: page.getByRole("heading", {
                  name: "Task identity and status",
                  exact: true,
                }),
              })
              .first();
            const tone =
              status === "running"
                ? "info"
                : status === "finished"
                  ? "success"
                  : status === "failed"
                    ? "danger"
                    : "warn";
            const colors = await identity
              .locator(".badge")
              .evaluate((badge, tone) => {
                const reference = document.createElement("span");
                reference.hidden = true;
                reference.style.cssText = `color:var(--${tone});background:var(--${tone}-bg);border:1px solid var(--${tone});`;
                document.body.append(reference);
                const read = (element: Element) => {
                  const style = getComputedStyle(element);
                  return [
                    style.color,
                    style.backgroundColor,
                    style.borderTopColor,
                  ];
                };
                const result = {
                  actual: read(badge),
                  approvedSemanticTone: read(reference),
                };
                reference.remove();
                return result;
              }, tone);
            expect(colors.actual).toEqual(colors.approvedSemanticTone);
            const cancel = identity.getByRole("button", {
              name: "Cancel task",
              exact: true,
            });
            if (status === "queued") {
              await expect(identity).toContainText("Unassigned");
              // The approved queued sample offers no cancellation command.
              await expect(cancel).toHaveCount(0);
              await expect(identity).toContainText(/queued/i);
              // No invented lifecycle event or claim.
              await expect(
                page.getByText(
                  "Waiting for a successful claim. There are no lifecycle events yet.",
                ),
              ).toBeVisible();
              await expect(page.getByText(/^Claim \d+ · /)).toHaveCount(0);
            } else if (["created", "running"].includes(status))
              await expect(cancel).toBeEnabled();
            else await expect(cancel).toHaveCount(0);
            await expect(page.locator("#content")).not.toContainText(
              /task\.claimed|task\.started|canceled/i,
            );
          },
        ],
      ),
    );
  });

for (const theme of ["dark", "light"])
  test(`v0034.4 output replay/live split retains per-stream order and follows automatically ${theme}`, async ({
    page,
  }) => {
    await page.route("**/ui/v1/operator/settings", (route) =>
      route.fulfill({
        json: { time_zone: "Europe/Moscow" },
        headers: { etag: '"op-1"' },
      }),
    );
    await page.addInitScript(
      (theme) => localStorage.setItem("flowai.theme", theme),
      theme,
    );
    await detailFixture(page);
    const chunks = Array.from({ length: 40 }, (_, index) =>
      logEntry(
        5001 + index,
        index + 1,
        index % 3 === 0 ? "reasoning" : "work",
        `chunk-${String(index + 1).padStart(2, "0")} ${"complete output text ".repeat(8)}`,
      ),
    );
    await page.route(`**${taskPath}/logs?**`, (route) =>
      route.fulfill({ json: { items: chunks, next_cursor: null } }),
    );
    const sockets: string[] = [];
    page.on("websocket", (socket) => sockets.push(socket.url()));
    await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
    await expect(page.locator("[data-stream-state=connected]")).toHaveCount(1);
    // D42: attempt 1's Work and Reasoning share one log in log_offset order.
    const work = page.getByRole("log", { name: "Attempt 1 log", exact: true }),
      reasoning = work;
    {
      const root = work;
      const expected = chunks;
      for (const chunk of expected)
        await expect(root.getByText(chunk.text, { exact: true })).toHaveCount(
          1,
        );
      await expect(root.locator("[data-log-stream-label]")).toHaveText(
        expected.map((chunk) =>
          chunk.stream === "reasoning" ? "Reasoning" : "Work",
        ),
      );
      await expect(
        root.locator(`[data-log-offset="${expected[0].log_offset}"] time`),
      ).toHaveAttribute("datetime", expected[0].occurred_at);
      await expect(
        root.locator(`[data-log-offset="${expected[0].log_offset}"] time`),
      ).toContainText(/03:00:03 \+03:00/);
      const text = await root.innerText();
      expect(expected.map((chunk) => text.indexOf(chunk.text))).toEqual(
        expected.map((chunk) => text.indexOf(chunk.text)).sort((a, b) => a - b),
      );
      expect(
        await root.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      ).toBeLessThanOrEqual(2);
    }
    // The fixture exercises UI continuation/deduplication, not journal replay
    // of frames missed while disconnected. Each live frame is pushed twice.
    let liveAt = Date.now();
    let lastFrame: ReturnType<typeof logFrame>;
    const append = (stream: string) => {
      const chunk = logEntry(
        5001 + chunks.length,
        chunks.length + 1,
        stream,
        `live-${stream} tail-${chunks.length + 1}`,
        new Date(++liveAt).toISOString(),
      );
      chunks.push(chunk);
      const frame = logFrame(chunk);
      lastFrame = frame;
      registry.push(1, frame);
      registry.push(1, frame);
      return chunk;
    };
    const liveWork = append("work"),
      liveReasoning = append("reasoning");
    await expect(work.getByText(liveWork.text, { exact: true })).toHaveCount(1);
    await expect(
      work.locator(`[data-log-offset="${liveWork.log_offset}"] time`),
    ).toHaveAttribute("datetime", liveWork.occurred_at);
    await expect(
      reasoning.getByText(liveReasoning.text, { exact: true }),
    ).toHaveCount(1);
    const before = sockets.length;
    await page
      .getByRole("button", {
        name: `Switch to ${theme === "dark" ? "light" : "dark"} theme`,
        exact: true,
      })
      .click();
    expect(sockets.length).toBe(before);
    await expect(work.getByText(liveWork.text, { exact: true })).toHaveCount(1);
    registry.disconnectStreams(1);
    await expect.poll(() => sockets.length).toBe(before + 1);
    await expect(page.locator("[data-stream-state=connected]")).toHaveCount(1);
    const continuation = new URL(sockets.at(-1)!);
    // Resume uses only the integer frame cursor.
    expect([...continuation.searchParams.keys()]).toEqual(["after_frame_id"]);
    expect(continuation.searchParams.get("after_frame_id")).toBe(
      String(lastFrame!.frame_id),
    );
    const tail = append("work");
    await expect(work.getByText(tail.text, { exact: true })).toHaveCount(1);
    await page.reload();
    await expect(work.getByText(tail.text, { exact: true })).toHaveCount(1);
    expect(
      await work.evaluate(
        (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
      ),
    ).toBeLessThanOrEqual(2);
  });

test("v0034.4 task cancellation: accepted, pending, paged pending and failure", async ({
  context,
}, info) => {
  test.setTimeout(120_000);
  await freshPageSteps(context, info, "Task cancellation", [
    [
      "v0034.4 accepted cancellation closes its confirmation once and waits for real lifecycle",
      async (page) => {
        const { writes } = await detailFixture(page);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route(`**${taskPath}/controls/cancel`, async (route) => {
          if (!cancellationRequest(route))
            return route.fulfill({
              status: 400,
              json: {
                code: "invalid_request",
                message: "request_id is invalid",
              },
            });
          await held;
          await route.fulfill({
            status: 202,
            json: {
              task_id: taskID,
              control_id: 7019,
              control: "cancel",
              status: "requested",
            },
          });
        });
        await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
        await page
          .getByRole("button", { name: "Cancel task", exact: true })
          .click();
        // The approved title follows the request: confirm, pending, failed.
        const dialog = anyCancelTaskDialog(page);
        const confirm = dialog.getByRole("button", {
          name: "Cancel task",
          exact: true,
        });
        try {
          const dispatched = page.waitForRequest(
            (request) =>
              request.method() === "POST" &&
              new URL(request.url()).pathname === `${taskPath}/controls/cancel`,
          );
          await confirm.click();
          const request = await dispatched;
          expect(request.postDataJSON()).toEqual({
            request_id: expect.stringMatching(
              /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
            ),
          });
          await expect(confirm).toBeDisabled();
          await expect.poll(() => writes.length).toBe(1);
          // Programmatic submission checks the handler guard as well as its disabled UI.
          await dialog.locator("form").evaluate((form) => {
            (form as HTMLFormElement).requestSubmit();
            (form as HTMLFormElement).requestSubmit();
          });
          release();
          await expect(dialog).not.toBeVisible();
          const pending = page.getByRole("button", {
            name: "Cancellation requested",
            exact: true,
          });
          await expect(pending).toBeDisabled();
          await expect(page.locator(".status-row .badge")).toHaveText(
            "Running",
          );
          expect(writes).toEqual([`${taskPath}/controls/cancel`]);
          await expect(executionTimeline(page)).not.toContainText(
            /\b(finished|failed|cancelled|canceled) · /i,
          );
        } finally {
          release();
        }
      },
    ],
    [
      "v0034.4 canonical pending cancellation survives reload without a duplicate request",
      async (page) => {
        const { writes } = await detailFixture(page);
        await page.route(`**${taskPath}/events?**`, (route) =>
          route.fulfill({
            json: {
              items: [
                stored(7020, "created", "2026-10-18T00:00:01Z"),
                stored(7021, "running", "2026-10-18T00:00:02Z"),
                controlEvent(
                  7022,
                  "control_requested",
                  7019,
                  "2026-10-18T00:00:03Z",
                ),
              ],
              next_cursor: null,
            },
          }),
        );
        await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
        const pending = page.getByRole("button", {
          name: "Cancellation requested",
          exact: true,
        });
        await expect(pending).toBeDisabled();
        await expect(page.locator(".status-row .badge")).toHaveText("Running");
        await expect(
          executionTimeline(page).getByText(/^control_requested\b/),
        ).toHaveCount(1);
        await page.reload();
        await expect(pending).toBeDisabled();
        await expect(page.locator(".status-row .badge")).toHaveText("Running");
        await expect(
          executionTimeline(page).getByText(/^control_requested\b/),
        ).toHaveCount(1);
        expect(writes).toEqual([]);
      },
    ],
    [
      "v0034.4 pending cancellation beyond the first event page remains disabled",
      async (page) => {
        const { writes } = await detailFixture(page);
        const reads: string[] = [];
        const events: Array<Record<string, unknown>> = [];
        const at = () =>
          new Date(
            Date.parse("2026-10-18T00:00:01Z") + events.length * 1000,
          ).toISOString();
        const emit = (control_id: number, kind: string) =>
          events.push(
            controlEvent(6000 + events.length, kind, control_id, at()),
          );
        events.push(stored(5900, "created", at()));
        events.push(stored(5901, "running", at()));
        // 31 resolved controls: requested, then the holder's results.
        for (let index = 0; index < 31; index++)
          for (const kind of [
            "control_requested",
            "control_acknowledged",
            "control_failed",
          ])
            emit(7100 + index, kind);
        // Two legitimate controls cross the page boundary; another completes first.
        emit(7201, "control_requested");
        emit(7202, "control_requested");
        for (const kind of [
          "control_requested",
          "control_acknowledged",
          "control_failed",
        ])
          emit(7203, kind);
        for (const id of [7201, 7202])
          for (const kind of ["control_acknowledged", "control_failed"])
            emit(id, kind);
        // The newest control has no result yet: cancellation stays requested.
        emit(7204, "control_requested");
        expect(events).toHaveLength(105);
        await page.route(`**${taskPath}/events?**`, (route) => {
          const cursor =
            new URL(route.request().url()).searchParams.get("cursor") || "";
          reads.push(cursor);
          return route.fulfill({
            json: {
              items: cursor ? events.slice(100) : events.slice(0, 100),
              next_cursor: cursor ? null : "event-page-two",
            },
          });
        });
        await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
        await expect(
          page.getByRole("button", {
            name: "Cancellation requested",
            exact: true,
          }),
        ).toBeDisabled();
        expect(reads).toEqual(["", "event-page-two"]);
        await expect(page.locator(".status-row .badge")).toHaveText("Running");
        expect(writes).toEqual([]);
      },
    ],
    [
      "v0034.4 cancellation failure stays actionable without a false accepted or terminal state",
      async (page) => {
        const { writes } = await detailFixture(page);
        await page.route(`**${taskPath}/controls/cancel`, (route) =>
          route.fulfill(
            cancellationRequest(route)
              ? {
                  status: 503,
                  json: {
                    code: "unavailable",
                    message: "Control service unavailable",
                  },
                }
              : {
                  status: 400,
                  json: {
                    code: "invalid_request",
                    message: "request_id is invalid",
                  },
                },
          ),
        );
        await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
        await page
          .getByRole("button", { name: "Cancel task", exact: true })
          .click();
        // The approved title follows the request: confirm, pending, failed.
        const dialog = anyCancelTaskDialog(page);
        await dialog
          .getByRole("button", { name: "Cancel task", exact: true })
          .click();
        await expect(dialog.getByRole("alert")).toContainText(
          /unavailable|refresh|could not|not confirmed/i,
        );
        await expect(page.locator(".timeline")).not.toContainText(
          "Awaiting Executor acknowledgement",
        );
        await expect(page.locator(".status-row .badge")).toHaveText("Running");
        expect(writes).toEqual([`${taskPath}/controls/cancel`]);
        await page.keyboard.press("Escape");
        await expect(dialog).not.toBeVisible();
        await expect(
          page.getByRole("button", { name: "Cancel task", exact: true }),
        ).toBeEnabled();
      },
    ],
  ]);
});

test("v0034.4 initial output: live chunk during load and log continuation", async ({
  context,
}, info) => {
  test.setTimeout(60_000);
  // Sequential steps: the live-chunk page closes before the next one opens,
  // so its registry frame reaches no later socket.
  await freshPageSteps(context, info, "Initial task output", [
    [
      "v0034.4 a live chunk received during task loading survives the initial snapshot",
      async (page) => {
        const { task } = await detailFixture(page);
        let release!: () => void,
          captured = false,
          snapshotRead = false;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/ui/v1/teams/1/tasks?**", (route) =>
          route.fulfill({ json: { items: [task], next_cursor: null } }),
        );
        await page.route(`**${taskPath}`, async (route) => {
          captured = true;
          await held;
          await route.fulfill({ json: task });
        });
        await page.route(`**${taskPath}/logs?**`, (route) => {
          snapshotRead = true;
          return route.fulfill({ json: { items: [], next_cursor: null } });
        });
        await page.goto(`${proxy.baseUrl}?view=history&team=1`);
        await expect(page.locator("[data-stream-state=connected]")).toHaveCount(
          1,
        );
        try {
          await page
            .getByRole("link", { name: task.task_name, exact: true })
            .click();
          await expect.poll(() => captured && snapshotRead).toBe(true);
          const text = "Work received while the task identity read is held";
          registry.push(
            1,
            logFrame(
              logEntry(
                7023,
                777,
                "work",
                text,
                new Date(Date.now() + 1000).toISOString(),
              ),
            ),
          );
          await expect(
            page.locator('[data-testid="live-frame"]'),
          ).toContainText(text);
          release();
          await expect(
            page
              .getByRole("log", { name: "Attempt 1 log", exact: true })
              .getByText(text, { exact: true }),
          ).toHaveCount(1);
        } finally {
          release();
        }
      },
    ],
    [
      "v0034.4 initial output traverses the accepted log continuation without truncation",
      async (page) => {
        await detailFixture(page);
        const reads: string[] = [];
        await page.route(`**${taskPath}/logs?**`, (route) => {
          const cursor =
            new URL(route.request().url()).searchParams.get("cursor") || "";
          reads.push(cursor);
          const start = cursor ? 100 : 0,
            count = cursor ? 50 : 100;
          return route.fulfill({
            json: {
              items: Array.from({ length: count }, (_, index) =>
                logEntry(
                  8100 + start + index,
                  start + index + 1,
                  (start + index) % 2 ? "work" : "reasoning",
                  `complete archived chunk ${start + index + 1}`,
                ),
              ),
              next_cursor: cursor ? null : "log-page-two",
            },
          });
        });
        await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
        await expect(
          page
            .getByRole("log", { name: "Attempt 1 log", exact: true })
            .getByText("complete archived chunk 150", { exact: true }),
        ).toHaveCount(1);
        expect(reads).toEqual(["", "log-page-two"]);
        await expect(
          page.locator("[data-task-log] [data-log-offset]"),
        ).toHaveCount(150);
      },
    ],
    [
      "v0048 a task journal has not stored yet shows as queued and follows the stream",
      async (page) => {
        // task-manager returns the new task; journal answers 404 until it
        // stores the task's first event (bugfix-7).
        await detailFixture(page, "queued");
        const notStored = (route: Route) =>
          route.fulfill({
            status: 404,
            json: { code: "not_found", message: "Task not found" },
          });
        await page.route(`**${taskPath}/events?**`, notStored);
        await page.route(`**${taskPath}/logs?**`, notStored);
        await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
        await expect(page.locator("[data-stream-state=connected]")).toHaveCount(
          1,
        );
        await expect(
          page.getByRole("heading", { name: "Task not found" }),
        ).toHaveCount(0);
        const status = page.locator("[data-task-status]");
        await expect(status).toHaveText("Queued");
        const at = Date.now();
        ["created", "running", "finished"].forEach((kind, index) => {
          const event = stored(
            7101 + index,
            kind,
            new Date(at + index * 1000).toISOString(),
          );
          registry.push(1, {
            frame_id: event.event_id,
            frame_type: "task_event",
            team_id: 1,
            task_id: taskID,
            data: event,
          });
        });
        await expect(status).toHaveText("Finished");
      },
    ],
  ]);
});

// Retained screenshots complement behavior assertions; they are not a full visual verdict.
test.afterEach(async ({ page }, info) => {
  await captureDesignState(
    page,
    info,
    proxy.webUIImageID,
    `final-${info.title}`,
  );
});

// One presentation pass over the complete approved Task detail state family.
for (const theme of ["dark", "light"] as const)
  for (const width of [390, 820, 1440])
    test(`v0034.12 complete Task detail presentation states ${theme} ${width}`, async ({
      browser,
    }, info) => {
      test.setTimeout(240_000);
      const failures: unknown[] = [];
      for (const state of [
        "default",
        "queued",
        "assigned",
        "work-empty",
        "work-live",
        "work-reconnecting",
        "work-error",
        "reasoning-empty",
        "reasoning-live",
        "reasoning-reconnecting",
        "reasoning-error",
        "cancel-confirm",
        "cancel-pending",
        "cancel-failure",
        "loading",
        "error",
        "created",
        "finished",
        "failed",
        "cancel-completed",
      ]) {
        const context = await browser.newContext({
          viewport: designViewport(width),
        });
        const page = await context.newPage();
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached = 0;
        try {
          await page.addInitScript(
            (value) => localStorage.setItem("flowai.theme", value),
            theme,
          );
          const status = ["queued", "created", "finished", "failed"].includes(
            state,
          )
            ? state
            : state === "cancel-completed"
              ? "cancelled"
              : "running";
          const { writes } = await detailFixture(page, status);
          if (["loading", "error"].includes(state))
            await page.route(`**${taskPath}`, async (route) => {
              reached++;
              if (state === "loading") await held;
              await route.fulfill({
                status: 503,
                json: {
                  code: "temporarily_unavailable",
                  message: "Task could not be loaded",
                },
              });
            });
          const stream = state.startsWith("reasoning") ? "reasoning" : "work";
          if (
            state.endsWith("-live") ||
            state.endsWith("-reconnecting") ||
            state.endsWith("-error")
          )
            await page.route(`**${taskPath}/logs?**`, (route) =>
              route.fulfill({
                json: {
                  items: [
                    logEntry(4101, 1, stream, `Retained ${stream} output`),
                  ],
                  next_cursor: null,
                },
              }),
            );
          if (state === "cancel-completed")
            await page.route(`**${taskPath}/events?**`, (route) =>
              route.fulfill({
                json: {
                  // Cancellation completes: requested, acknowledged by the
                  // claim holder, then the task is cancelled.
                  items: [
                    stored(7026, "created", "2026-10-18T00:00:01Z"),
                    stored(7027, "running", "2026-10-18T00:00:02Z"),
                    controlEvent(
                      7023,
                      "control_requested",
                      7019,
                      "2026-10-18T00:00:19Z",
                    ),
                    controlEvent(
                      7024,
                      "control_acknowledged",
                      7019,
                      "2026-10-18T00:00:20Z",
                    ),
                    stored(7025, "cancelled", "2026-10-18T00:00:21Z"),
                  ],
                  next_cursor: null,
                },
              }),
            );
          if (["cancel-pending", "cancel-failure"].includes(state))
            await page.route(`**${taskPath}/controls/cancel`, async (route) => {
              expect(cancellationRequest(route)).not.toBeNull();
              reached++;
              if (state === "cancel-pending") await held;
              await route.fulfill(
                state === "cancel-failure"
                  ? {
                      status: 503,
                      json: {
                        code: "unavailable",
                        message: "Control service unavailable",
                      },
                    }
                  : {
                      status: 202,
                      json: {
                        task_id: taskID,
                        control_id: 7019,
                        control: "cancel",
                        status: "requested",
                      },
                    },
              );
            });
          await page.goto(`${proxy.baseUrl}?view=task&team=1&id=${taskID}`);
          if (["loading", "error"].includes(state)) {
            await expect.poll(() => reached).toBe(1);
            await expect(
              page
                .locator("#content")
                .getByRole(state === "loading" ? "status" : "alert"),
            ).toBeVisible();
          } else {
            await expect(
              page.getByRole("heading", {
                name: "Task identity and status",
                exact: true,
              }),
            ).toBeVisible();
            // The approved status label for a failed task is "Failed".
            await expect(page.locator(".status-row .badge")).toHaveText(
              status[0].toUpperCase() + status.slice(1),
            );
            if (state.startsWith("cancel-") && state !== "cancel-completed") {
              await page
                .getByRole("button", { name: "Cancel task", exact: true })
                .click();
              const dialog = cancelTaskDialog(page, "confirm");
              await expect(dialog).toBeVisible();
              await page.mouse.move(0, 0);
              if (state !== "cancel-confirm") {
                await dialog
                  .getByRole("button", { name: "Cancel task", exact: true })
                  .click();
                await expect.poll(() => reached).toBe(1);
                if (state === "cancel-pending")
                  await expect(
                    cancelTaskDialog(page, "pending").getByRole("button", {
                      name: "Cancel task",
                      exact: true,
                    }),
                  ).toBeDisabled();
                else
                  await expect(
                    cancelTaskDialog(page, "failure").getByRole("alert"),
                  ).toContainText(/unavailable|confirmed|refresh/i);
              }
            }
            if (
              state.endsWith("-live") ||
              state.endsWith("-reconnecting") ||
              state.endsWith("-error")
            )
              await expect(
                page.getByText(`Retained ${stream} output`, { exact: true }),
              ).toBeVisible();
            if (state.endsWith("-reconnecting") || state.endsWith("-error")) {
              await expect(
                page.locator("[data-stream-state=connected]"),
              ).toHaveCount(1);
              registry.rejectStreams(1, true);
              registry.disconnectStreams(1);
              await expect(
                page
                  .locator("[data-task-log]")
                  .locator("[role=status],[role=alert]"),
              ).toContainText(/reconnect|retrying|unavailable|error/i);
            }
          }
          expect(writes.length).toBe(
            ["cancel-pending", "cancel-failure"].includes(state) ? 1 : 0,
          );
          await captureDesignState(
            page,
            info,
            proxy.webUIImageID,
            `task-detail.html-${state}-${theme}-${width}`,
          );
        } catch (error) {
          failures.push(error);
          await info.attach(`task-detail-${state}-failure`, {
            body: String(error),
            contentType: "text/plain",
          });
        } finally {
          release();
          registry.rejectStreams(1, false);
          await context.close();
        }
      }
      if (failures.length)
        throw new AggregateError(failures, "Task detail presentation batch");
    });
