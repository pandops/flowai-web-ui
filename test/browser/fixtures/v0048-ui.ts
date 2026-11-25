import path from "node:path";
import {
  expect,
  type Locator,
  type Page,
  type Route,
  type WebSocketRoute,
} from "@playwright/test";
import { startMockedProxy, type MockedProxy } from "./mocked_proxy";
import { workerProxy } from "./worker-proxy";

// Shared setup of the v0048 Web UI browser unit tests: the real Web UI
// image behind the mocked proxy, with the Gateway `/ui/v1` replies served
// per page by `page.route`. Every identifier is a positive integer
// (design.md, Identifiers): team ops 3, Flows 1 and 2, Sources 4
// and 5, Executors 7, 8, 3 and 12, tasks 1010 down to 978. Every task row
// and card carries task-manager's stored `task_name` (v0050), by default
// `<team_name>-<task_id>`; a test may override it to prove the Web UI shows
// the reply's name rather than composing it.

export const TEAM = 3;
export const TEAM_NAME = "ops";
export const webEntry = path.resolve(__dirname, "../../../web/index.html");

export function v0048Proxy(): Promise<MockedProxy> {
  return workerProxy(() =>
    startMockedProxy([{ team_id: TEAM, team_name: TEAM_NAME }], webEntry),
  );
}

// AGENTS.md, Supported resolutions: exactly these three, in both themes.
export const RESOLUTIONS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;
export const THEMES = ["light", "dark"] as const;
export const MATRIX = THEMES.flatMap((theme) =>
  RESOLUTIONS.map((resolution) => ({ theme, ...resolution })),
);

export async function usePresentation(
  page: Page,
  theme: string,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize({
    width: viewport.width,
    height: viewport.height,
  });
  await page.addInitScript(
    (value) => localStorage.setItem("flowai.theme", value),
    theme,
  );
}

// v0050: every task collection's seven fields, in this order.
export const TASK_FIELDS = [
  "Task",
  "External ID",
  "Time",
  "Task Source",
  "Flow",
  "Status",
  "Duration",
] as const;

export type ShownTask = {
  /** Route identity: the integer task_id. */
  id: number;
  /** The reply's task_name the collection must show. */
  name: string;
  /** The Source external_id, shown as plain text. */
  external: string;
};

/**
 * Checks one task collection in whichever layout it currently shows (a
 * fitting table or stacked records) and returns that layout: the seven
 * fields in order, Task first as the reply's task name linking to the task
 * detail route by its integer ID, External ID second as plain text, no
 * `Source ext ID` label and no bare task ID outside the task name.
 */
export async function expectTaskCollection(
  page: Page,
  scope: Locator,
  rows: ShownTask[],
  team = TEAM,
): Promise<"table" | "stacked"> {
  const table = scope.locator("table:visible");
  const cards = scope.locator("article:visible");
  await expect
    .poll(async () => (await table.count()) + (await cards.count()))
    .toBeGreaterThan(0);
  const layout = (await table.count()) > 0 ? "table" : "stacked";
  if (layout === "table")
    await expect(table.locator("thead th")).toHaveText([...TASK_FIELDS]);
  const records = layout === "table" ? table.locator("tbody tr") : cards;
  await expect(records).toHaveCount(rows.length);
  await expect(scope).not.toContainText("Source ext ID");
  for (const [index, row] of rows.entries()) {
    const record = records.nth(index);
    if (layout === "stacked")
      await expect(record.locator("dt")).toHaveText([...TASK_FIELDS]);
    const values = record.locator(layout === "table" ? "td" : "dd");
    await expect(values).toHaveCount(TASK_FIELDS.length);
    const link = values.nth(0).getByRole("link");
    await expect(link).toHaveCount(1);
    await expect(link).toHaveText(row.name);
    await expect(link).toHaveAccessibleName(row.name);
    const href = new URL((await link.getAttribute("href")) ?? "", page.url())
      .searchParams;
    expect(Object.fromEntries(href)).toMatchObject({
      view: "task",
      team: String(team),
      id: String(row.id),
    });
    await expect(values.nth(1)).toHaveText(row.external);
    await expect(values.nth(1).locator("a")).toHaveCount(0);
    // The bare internal task ID appears only inside the task name; the
    // External ID is the Source's value, not a task label.
    expect(
      (await record.innerText())
        .split(row.name)
        .join(" ")
        .split(row.external)
        .join(" "),
    ).not.toMatch(new RegExp(`(^|\\D)${row.id}(\\D|$)`));
  }
  return layout;
}

/** The page fits its viewport: no horizontal page scroll. */
export async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
}

export type Recorded = {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
  headers: Record<string, string>;
};

/** Records every `/ui/v1` request the page sends. */
export function recordRequests(page: Page): Recorded[] {
  const requests: Recorded[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/ui/v1/")) return;
    let body: any = null;
    try {
      body = request.postData() ? request.postDataJSON() : null;
    } catch {
      body = request.postData();
    }
    requests.push({
      method: request.method(),
      path: url.pathname,
      search: url.searchParams,
      body,
      headers: request.headers(),
    });
  });
  return requests;
}

// The catalogs every operator page reads.
export const SOURCES = [
  { source_id: 4, team_id: TEAM, name: "jira-sync", mode: "poller" },
  { source_id: 5, team_id: TEAM, name: "webhook-events", mode: "webhook" },
];
export const FLOWS = [
  { flow_id: 1, name: "Intake routing" },
  { flow_id: 2, name: "Release routing" },
];

export async function catalogRoutes(page: Page) {
  const list = (items: unknown[]) => (route: Route) =>
    route.fulfill({ json: { items, next_cursor: null } });
  await page.route("**/ui/v1/sources?**", list(SOURCES));
  await page.route("**/ui/v1/flows?**", list(FLOWS));
  await page.route("**/ui/v1/execution-tags?**", list(["openhands", "gpu"]));
}

export const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 15, 9, 0) + minutes * 60_000).toISOString();

export type ExecutorRecord = {
  executor_id: number;
  team_id: number;
  execution_tag: string;
  executor_type: string;
  created_at: string;
  token_fingerprint: string;
  token_issued_at: string;
  reported_ip: string | null;
  ip_reported_at: string | null;
};
export type ExecutorState = {
  executor_id: number;
  connection_state: string;
  connection_changed_at: string | null;
  held_claims: number | null;
  max_parallel_tasks: number | null;
  available_capacity: number | null;
  reported_ip: string | null;
  ip_changed_at: string | null;
};

export const executorRecord = (
  executor_id: number,
  extra: Partial<ExecutorRecord> = {},
): ExecutorRecord => ({
  executor_id,
  team_id: TEAM,
  execution_tag: "openhands",
  executor_type: "executor_docker_openhands",
  created_at: at(-600),
  token_fingerprint: "ab".repeat(32),
  token_issued_at: at(-600),
  reported_ip: null,
  ip_reported_at: null,
  ...extra,
});

export type ExecutorFake = {
  records: ExecutorRecord[];
  states: ExecutorState[];
  events: Map<number, any[]>;
  tasks: Map<number, any[]>;
  /** Every list query the page sent, when set. */
  listQueries?: URLSearchParams[];
  /** Replies for POST create / POST token / DELETE; default success. */
  createReply?: (body: any) => { status: number; json?: any };
  reissueReply?: (id: number) => { status: number; json?: any };
  deleteReply?: (id: number) => { status: number; json?: any };
};

/** Serves executor-registry's and journal's Executor reads and writes. */
export async function executorRoutes(page: Page, fake: ExecutorFake) {
  let next = 13;
  await page.route(`**/ui/v1/teams/${TEAM}/executor-states**`, (route) =>
    route.fulfill({ json: { items: fake.states } }),
  );
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/executors(?:\\?.*)?$`),
    async (route) => {
      const request = route.request();
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        const reply = fake.createReply?.(body);
        if (reply && reply.status >= 300)
          return route.fulfill({ status: reply.status, json: reply.json });
        const record = executorRecord(reply?.json?.executor_id ?? next++, {
          execution_tag: body.execution_tag,
          executor_type: body.executor_type,
        });
        fake.records.push(record);
        return route.fulfill({
          status: 201,
          json: { ...record, token: reply?.json?.token ?? "jwt-created-token" },
        });
      }
      // executor-registry list: only cursor and limit (1-200).
      const query = new URL(request.url()).searchParams;
      const limit = Number(query.get("limit") ?? 50),
        offset = Number(query.get("cursor") ?? 0);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        return route.fulfill({
          status: 400,
          json: { code: "invalid_request" },
        });
      fake.listQueries?.push(query);
      return route.fulfill({
        json: {
          items: fake.records.slice(offset, offset + limit),
          next_cursor:
            offset + limit < fake.records.length
              ? String(offset + limit)
              : null,
          total_count: fake.records.length,
        },
      });
    },
  );
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/executors/([^/?]+)(/[a-z]+)?(?:\\?.*)?$`),
    async (route) => {
      const request = route.request();
      const [, idText, part] = new URL(request.url()).pathname.match(
        /\/executors\/([^/?]+)(\/[a-z]+)?$/,
      )!;
      const id = Number(idText);
      const record = fake.records.find((item) => item.executor_id === id);
      if (!/^[1-9][0-9]*$/.test(idText))
        return route.fulfill({
          status: 400,
          json: { code: "invalid_request" },
        });
      if (!record)
        return route.fulfill({
          status: 404,
          json: { code: "executor_unknown_or_unavailable" },
        });
      if (part === "/token" && request.method() === "POST") {
        const reply = fake.reissueReply?.(id) ?? {
          status: 200,
          json: {
            executor_id: id,
            token: `jwt-reissued-${id}`,
            token_fingerprint: "cd".repeat(32),
            token_issued_at: at(5),
          },
        };
        return route.fulfill(reply);
      }
      if (!part && request.method() === "DELETE") {
        const reply = fake.deleteReply?.(id) ?? { status: 204 };
        if (reply.status === 204)
          fake.records.splice(fake.records.indexOf(record), 1);
        return route.fulfill(reply);
      }
      if (part === "/events")
        return route.fulfill({
          json: { items: fake.events.get(id) ?? [], next_cursor: null },
        });
      if (part === "/tasks")
        return route.fulfill({
          json: { items: fake.tasks.get(id) ?? [], next_cursor: null },
        });
      return route.fulfill({ json: record });
    },
  );
}

export type TaskFake = {
  task: ReturnType<typeof taskRecord>;
  events: ReturnType<typeof event>[];
  logs?: any[];
  /** env-registry task-parameters reply; default: none frozen. */
  parameters?: { environment: Record<string, string>; secret_keys: string[] };
};

/** Serves task-manager's task card and attempts and journal's history. */
export async function taskRoutes(page: Page, fakes: TaskFake[]) {
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/tasks/([^/?]+)(/[a-z-]+)?(?:\\?.*)?$`),
    (route) => {
      const [, idText, part] = new URL(route.request().url()).pathname.match(
        /\/tasks\/([^/?]+)(\/[a-z-]+)?$/,
      )!;
      const fake = fakes.find((item) => item.task.task_id === Number(idText));
      if (!fake)
        return route.fulfill({ status: 404, json: { code: "not_found" } });
      if (!part) return route.fulfill({ json: fake.task });
      if (part === "/attempts")
        return route.fulfill({
          json: { task_id: fake.task.task_id, items: fake.task.attempts },
        });
      if (part === "/events")
        return route.fulfill({
          json: { items: fake.events, next_cursor: null },
        });
      if (part === "/logs")
        return route.fulfill({
          json: { items: fake.logs ?? [], next_cursor: null },
        });
      if (part === "/launch-parameters")
        return route.fulfill({
          json: {
            task_id: fake.task.task_id,
            attempt: fake.parameters ? fake.task.attempt : null,
            environment: fake.parameters?.environment ?? {},
            secret_keys: fake.parameters?.secret_keys ?? [],
          },
        });
      return route.fulfill({ status: 404, json: { code: "not_found" } });
    },
  );
  // The task list (task-manager list-tasks): task summaries.
  await page.route(
    new RegExp(`/ui/v1/teams/${TEAM}/tasks(?:\\?.*)?$`),
    (route) =>
      route.fulfill({
        json: {
          items: fakes.map(({ task }) => summary(task)),
          next_cursor: null,
        },
      }),
  );
}

export type Claim = {
  attempt: number;
  claim_seq: number;
  executor_id: number;
  claimed_at: string;
  resolved_image: string;
  image_source: string;
  pending_reasons: string[];
  released_reason: string | null;
  ended_at: string | null;
};
export const claim = (
  attempt: number,
  claim_seq: number,
  executor_id: number,
  minutes: number,
  extra: Partial<Claim> = {},
): Claim => ({
  attempt,
  claim_seq,
  executor_id,
  claimed_at: at(minutes),
  resolved_image: "ghcr.io/flowai/openhands@sha256:" + "1".repeat(64),
  image_source: "flow_default",
  pending_reasons: [],
  released_reason: null,
  ended_at: null,
  ...extra,
});
export const attempt = (
  number: number,
  state: string,
  claims: Claim[],
  failure_reason: string | null = null,
  retryable: boolean | null = null,
) => ({ attempt: number, state, failure_reason, retryable, claims });

/** A task-manager task card (defs.schema.json taskCard). */
export const taskRecord = (
  task_id: number,
  extra: Record<string, any> = {},
) => ({
  task_id,
  task_name: `${TEAM_NAME}-${task_id}`,
  team_id: TEAM,
  flow_id: 1,
  source_id: 4,
  external_id: `invoice-${task_id}`,
  intake_id: task_id + 5000,
  required_tag: "openhands",
  current_state: "running",
  attempt: 1,
  claim_seq: 1,
  executor_id: 7 as number | null,
  resolved_image: "ghcr.io/flowai/openhands@sha256:" + "1".repeat(64),
  image_source: "flow_default",
  ingested_at: at(0),
  claimed_at: at(1) as string | null,
  completed_at: null as string | null,
  next_due_at: null,
  next_due_kind: null,
  execution_revision: 1,
  failure_retry_count: 3,
  failure_retry_wait_seconds: 60,
  pending_limit_seconds: 900,
  release_delay_seconds: 300,
  final_reason: null,
  archived: false,
  attempts: [] as ReturnType<typeof attempt>[],
  history: [],
  ...extra,
});

/** The list entry (taskSummary) of a task card. */
export const summary = (task: ReturnType<typeof taskRecord>) => ({
  task_id: task.task_id,
  task_name: task.task_name,
  team_id: task.team_id,
  flow_id: task.flow_id,
  source_id: task.source_id,
  external_id: task.external_id,
  required_tag: task.required_tag,
  current_state: task.current_state,
  attempt: task.attempt,
  executor_id: task.executor_id,
  ingested_at: task.ingested_at,
  claimed_at: task.claimed_at,
  completed_at: task.completed_at,
});

const EXECUTOR_KINDS = [
  "connection_lost",
  "connection_restored",
  "executor_lost",
  "executor_status",
  "ip_changed",
  "executor_registered",
  "executor_removed",
];
const TASK_MANAGER_KINDS = [
  "queued",
  "claim_accepted",
  "retry_scheduled",
  "archived",
  "control_requested",
];
let nextEventID = 2000;
/**
 * A journal-stored event (journal defs.schema.json `event`): the publisher's
 * flat message plus event_id. `released` is published by task-manager for
 * executor_lost and claim_missing and by the Executor otherwise.
 */
export function event(
  kind: string,
  minutes: number,
  keys: {
    task_id?: number | null;
    attempt?: number | null;
    claim_seq?: number | null;
    executor_id?: number | null;
    control_id?: number | null;
    team_id?: number;
    publisher?: string;
  } = {},
  data: Record<string, unknown> = {},
) {
  const publisher =
    keys.publisher ??
    (TASK_MANAGER_KINDS.includes(kind) ||
    (kind === "released" &&
      ["executor_lost", "claim_missing"].includes(String(data.reason)))
      ? "task-manager"
      : EXECUTOR_KINDS.includes(kind)
        ? "executor-registry"
        : "executor");
  const ids = Object.fromEntries(
    Object.entries({
      task_id: keys.task_id,
      attempt: keys.attempt,
      claim_seq: keys.claim_seq,
      executor_id: keys.executor_id,
      control_id: keys.control_id,
    }).filter(([, value]) => value !== null && value !== undefined),
  ) as {
    task_id?: number;
    attempt?: number;
    claim_seq?: number;
    executor_id?: number;
    control_id?: number;
  };
  const event_id = nextEventID++;
  return {
    event_id,
    publisher,
    publisher_seq: event_id,
    team_id: keys.team_id ?? TEAM,
    occurred_at: at(minutes),
    kind,
    ...ids,
    ...data,
  };
}

/** journal's stream frame type for a stored event. */
export function frameType(stored: { kind: string }) {
  if (EXECUTOR_KINDS.includes(stored.kind)) return "executor_event";
  if (stored.kind.startsWith("control_")) return "control_event";
  if (
    stored.kind === "executor_connection_lost" ||
    stored.kind === "executor_connection_restored"
  )
    return "executor_event";
  return "task_event";
}

/** Captures the page's team-stream WebSockets. */
export async function captureStreams(page: Page) {
  const streams: WebSocketRoute[] = [];
  const urls: URL[] = [];
  await page.routeWebSocket(/\/ui\/v1\/teams\/[^/]+\/stream(?:\?|$)/, (ws) => {
    streams.push(ws);
    urls.push(new URL(ws.url()));
    ws.onClose(() => closed.add(ws));
  });
  // A navigation closes the previous page's stream; frames go to the open one.
  const closed = new Set<WebSocketRoute>();
  const open = () => streams.filter((ws) => !closed.has(ws));
  return {
    streams,
    urls,
    /** Sends one journal frame carrying a stored event; its frame_id is the event_id. */
    async send(stored: ReturnType<typeof event>, type = frameType(stored)) {
      await expect.poll(() => open().length).toBeGreaterThan(0);
      open()
        .at(-1)!
        .send(
          JSON.stringify({
            frame_id: stored.event_id,
            frame_type: type,
            team_id: stored.team_id,
            task_id:
              type === "executor_event" ? null : (stored.task_id ?? null),
            data: stored,
          }),
        );
      return stored.event_id;
    },
  };
}
